import { ValidationError } from "../ingestion/types";
import { getLanguageModel } from "../llm/languageModel";
import { searchPassages } from "../retrieval/retrievalService";
import { MAX_QUERY_LENGTH } from "../retrieval/types";
import { checkAnswerSupport, parseAnswerSections, parseCitationNumbers, resolveCitations, stripCitations } from "./citations";
import { buildAnswerPrompt, buildEvidence, INSUFFICIENT_EVIDENCE_MARKER } from "./prompt";
import {
  ANSWER_MAX_TOKENS,
  ANSWER_RETRIEVAL_MODE,
  DEFAULT_ANSWER_LIMIT,
  INSUFFICIENT_EVIDENCE_ANSWER,
  InvalidModelResponseError,
  MAX_ANSWER_LIMIT,
  type AnswerResponse,
  type Evidence,
  type RawAnswerParams,
} from "./types";

function validateQuestion(question: unknown): string {
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new ValidationError("question is required");
  }
  const trimmed = question.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(`question must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  return trimmed;
}

function validateLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_ANSWER_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_ANSWER_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_ANSWER_LIMIT}`);
  }
  return limit;
}

function passagesUsed(evidence: Evidence[]): AnswerResponse["retrieval"]["passagesUsed"] {
  return evidence.map(({ number, result }) => ({
    number,
    passage_id: result.passage.id,
    document_id: result.document.id,
    source_id: result.source.id,
    source_title: result.source.title,
    ordinal: result.passage.ordinal,
    score: result.score,
  }));
}

/**
 * The insufficient-evidence answer: the fixed sentence, then the model's
 * explanation, if any, with every citation marker removed. It cites nothing,
 * so the explanation's markers are never resolved into citations.
 */
function insufficientEvidenceAnswer(reply: string): string {
  const explanation = stripCitations(reply.slice(INSUFFICIENT_EVIDENCE_MARKER.length))
    .replace(/^[\s:.-]+/, "")
    .trim();
  return explanation ? `${INSUFFICIENT_EVIDENCE_ANSWER} ${explanation}` : INSUFFICIENT_EVIDENCE_ANSWER;
}

/**
 * question → hybrid retrieval → numbered evidence → grounded model call →
 * citation and support validation → response. Stateless: nothing is stored.
 */
export async function answerQuestion(raw: RawAnswerParams): Promise<AnswerResponse> {
  const question = validateQuestion(raw.question);
  const limit = validateLimit(raw.limit);

  // searchPassages takes raw query-string style input, so the limit is passed as a string.
  const { results } = await searchPassages({
    q: question,
    limit: String(limit),
    personId: raw.personId,
    sourceId: raw.sourceId,
    sourceIds: raw.sourceIds,
    mode: ANSWER_RETRIEVAL_MODE,
  });

  const evidence = buildEvidence(results);
  const retrieval = { mode: ANSWER_RETRIEVAL_MODE, passagesUsed: passagesUsed(evidence) };

  if (evidence.length === 0) {
    return { question, status: "insufficient_evidence", answer: INSUFFICIENT_EVIDENCE_ANSWER, citations: [], retrieval, model: null };
  }

  const model = getLanguageModel();
  const { system, prompt } = buildAnswerPrompt(question, evidence);
  const reply = await model.generate({ system, prompt, maxTokens: ANSWER_MAX_TOKENS });

  if (reply.stopReason === "refusal") throw new InvalidModelResponseError("model declined to answer");
  if (reply.stopReason === "max_tokens") throw new InvalidModelResponseError("model answer was cut off at the token limit");

  // The contract from the system prompt: a reply either starts with the
  // insufficient-evidence marker (and cites nothing) or is a grounded
  // two-section answer whose sources section passes the support check.
  const text = reply.text.trim();
  if (text.startsWith(INSUFFICIENT_EVIDENCE_MARKER)) {
    return { question, status: "insufficient_evidence", answer: insufficientEvidenceAnswer(text), citations: [], retrieval, model: model.modelId };
  }
  if (text.length === 0) throw new InvalidModelResponseError("model returned an empty answer");

  const citations = resolveCitations(parseCitationNumbers(text), evidence);
  checkAnswerSupport(parseAnswerSections(text), evidence, question);

  return { question, status: "answered", answer: text, citations, retrieval, model: model.modelId };
}
