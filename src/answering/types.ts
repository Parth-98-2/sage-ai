import type { SearchResult } from "../retrieval/types";

/** Hybrid candidates retrieved per question; `limit` overrides it. */
export const DEFAULT_ANSWER_LIMIT = 20;
export const MAX_ANSWER_LIMIT = 20;
/** Passages selected from the candidates for the model (see evidenceSelection); a limit at or below it skips selection. */
export const ANSWER_EVIDENCE_COUNT = 6;
export const ANSWER_MAX_TOKENS = 16000;
/** Answering always retrieves with hybrid (lexical + semantic, fused) retrieval. */
export const ANSWER_RETRIEVAL_MODE = "hybrid" as const;

/** The fixed sentence every insufficient-evidence answer starts with. */
export const INSUFFICIENT_EVIDENCE_ANSWER = "The available sources are insufficient to answer this question.";

/** Unvalidated input, as received in the request body. */
export interface RawAnswerParams {
  question?: unknown;
  personId?: unknown;
  sourceId?: unknown;
  sourceIds?: unknown;
  limit?: unknown;
}

/**
 * One retrieved passage as shown to the model. `number` is assigned by the
 * server (1-based, in retrieval order) and is the only thing the model may
 * cite; the server alone maps it back to provenance.
 */
export interface Evidence {
  number: number;
  result: SearchResult;
}

export interface Citation {
  number: number;
  passage: SearchResult["passage"];
  document: SearchResult["document"];
  source: SearchResult["source"];
  people: SearchResult["people"];
}

export interface PassageUsed {
  number: number;
  passage_id: string;
  document_id: string;
  source_id: string;
  source_title: string;
  ordinal: number;
  score: number;
  /** 1-based position among the hybrid candidates, before evidence selection. */
  retrievalRank: number;
}

export type AnswerStatus = "answered" | "insufficient_evidence";

export interface AnswerResponse {
  question: string;
  status: AnswerStatus;
  answer: string;
  citations: Citation[];
  retrieval: {
    mode: typeof ANSWER_RETRIEVAL_MODE;
    passagesUsed: PassageUsed[];
  };
  /** The model that wrote the answer; null when no passages were retrieved and no model was called. */
  model: string | null;
}

/** The model's output broke the answering contract (bad citation, truncation, refusal, …). */
export class InvalidModelResponseError extends Error {}
