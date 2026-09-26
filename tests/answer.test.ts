import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import {
  ANSWER_SYSTEM_PROMPT,
  APPLICATION_HEADING,
  buildAnswerPrompt,
  buildEvidence,
  SOURCES_HEADING,
} from "../src/answering/prompt";
import { ANSWER_MAX_TOKENS, INSUFFICIENT_EVIDENCE_ANSWER } from "../src/answering/types";
import { pool } from "../src/db/pool";
import { embedMissingPassages } from "../src/embeddings/backfill";
import { setEmbedder } from "../src/embeddings/embedder";
import { ingestText } from "../src/ingestion/ingestionService";
import { setLanguageModel } from "../src/llm/languageModel";
import { searchPassages } from "../src/retrieval/retrievalService";
import type { SearchResponse } from "../src/retrieval/types";
import { createFakeEmbedder, type FakeEmbedder } from "./helpers/fakeEmbedder";
import { createFakeLanguageModel, evidenceNumberContaining, type FakeLanguageModel } from "./helpers/fakeLanguageModel";

// Wrap the real retrieval service in a spy so tests can see exactly how
// answering calls it; behaviour is unchanged.
vi.mock("../src/retrieval/retrievalService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/retrieval/retrievalService")>();
  return { ...actual, searchPassages: vi.fn(actual.searchPassages) };
});
const searchSpy = vi.mocked(searchPassages);

const app = createApp();
let embedder: FakeEmbedder;
let llm: FakeLanguageModel;

const FIVE_YEAR = "Bloomberg writes that you should make tactical plans for the next few steps and never devise a five-year plan.";
const FIRED = "After fifteen years at Salomon Brothers, Bloomberg was fired and walked away with ten million dollars.";
const NAPOLEON = "Napoleon carried a travelling library and read constantly while on campaign.";

beforeAll(() => {
  embedder = createFakeEmbedder();
  setEmbedder(embedder);
});

beforeEach(async () => {
  await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
  embedder.calls.length = 0;
  searchSpy.mockClear();
  llm = createFakeLanguageModel("unused");
  setLanguageModel(llm);
});

afterAll(async () => {
  setEmbedder(null);
  setLanguageModel(null);
  await pool.end();
});

async function ingestEpisode(rawText: string, title: string) {
  const result = await ingestText({
    rawText,
    suggestedTitle: title,
    sourceType: "podcast",
    personName: "David Senra",
    personRole: "host",
    ingestionMethod: "text_upload",
    originalFilename: `${title}.txt`,
    mimeType: "text/plain",
  });
  await embedMissingPassages(embedder);
  return result;
}

async function seedCorpus() {
  // Short texts become one passage each, so every fact has its own evidence number.
  const bloomberg = await ingestEpisode(FIVE_YEAR, "founders-433-michael-bloomberg");
  const salomon = await ingestEpisode(FIRED, "founders-433-michael-bloomberg-part-2");
  const napoleon = await ingestEpisode(NAPOLEON, "founders-432-napoleon");
  return { bloomberg, salomon, napoleon };
}

function answer(body: unknown) {
  return request(app).post("/answer").send(body as object);
}

/** Replies with a sources section citing whichever evidence block holds `needle`. */
function citing(needle: string, sentence: string) {
  return createFakeLanguageModel((req) => `${SOURCES_HEADING}\n${sentence} [${evidenceNumberContaining(req.prompt, needle)}]`);
}

describe("POST /answer grounded answers", () => {
  it("returns a grounded answer with resolved citations and the model id", async () => {
    await seedCorpus();
    llm = citing("five-year plan", "On the podcast, host David Senra recounts that Bloomberg advised against five-year plans.");
    setLanguageModel(llm);

    const res = await answer({ question: "What did Bloomberg say about five-year plans?" });

    expect(res.status).toBe(200);
    expect(res.body.question).toBe("What did Bloomberg say about five-year plans?");
    expect(res.body.status).toBe("answered");
    expect(res.body.answer).toMatch(/^FROM THE SOURCES:\nOn the podcast, host David Senra recounts .* \[\d+\]$/);
    expect(res.body.model).toBe("fake-llm@1");
    expect(res.body.retrieval.mode).toBe("hybrid");
    expect(res.body.retrieval.passagesUsed.length).toBeGreaterThan(0);
    expect(res.body.citations).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
  });

  it("maps each citation number to the passage supplied under that number, with provenance", async () => {
    const { bloomberg, salomon } = await seedCorpus();
    llm = createFakeLanguageModel(
      (req) =>
        `${SOURCES_HEADING}\nHe opposed five-year plans [${evidenceNumberContaining(req.prompt, "five-year plan")}] ` +
        `and was fired from Salomon [${evidenceNumberContaining(req.prompt, "Salomon Brothers")}].`
    );
    setLanguageModel(llm);

    const res = await answer({ question: "What did Bloomberg say about plans and being fired from Salomon?" });

    expect(res.status).toBe(200);
    expect(res.body.citations).toHaveLength(2);
    const used = res.body.retrieval.passagesUsed;
    const cases = [
      [res.body.citations[0], bloomberg, "founders-433-michael-bloomberg", "five-year plan"],
      [res.body.citations[1], salomon, "founders-433-michael-bloomberg-part-2", "Salomon Brothers"],
    ] as const;
    for (const [citation, ingested, title, needle] of cases) {
      expect(citation.passage.text).toContain(needle);
      expect(res.body.answer).toContain(`[${citation.number}]`);
      const supplied = used.find((p: { number: number }) => p.number === citation.number);
      expect(supplied.passage_id).toBe(citation.passage.id);
      expect(citation.passage.id).toBe(ingested.passages[0].id);
      expect(citation.document.id).toBe(ingested.document.id);
      expect(citation.source).toMatchObject({ id: ingested.source.id, title, source_type: "podcast" });
      expect(citation.people).toEqual([{ id: ingested.person.id, name: "David Senra", role: "host" }]);
      expect(ingested.document.raw_text.slice(citation.passage.char_start, citation.passage.char_end)).toBe(citation.passage.text);
    }
  });

  it("accepts a two-section answer: structured, cited source lines and an uncited application", async () => {
    await seedCorpus();
    llm = createFakeLanguageModel((req) => {
      const fired = evidenceNumberContaining(req.prompt, "Salomon Brothers");
      const plans = evidenceNumberContaining(req.prompt, "five-year plan");
      return [
        `**${SOURCES_HEADING}**`,
        `- Person: Bloomberg, at Salomon Brothers [${fired}]`,
        `- What happened: after fifteen years he was fired and walked away with ten million dollars [${fired}].`,
        `- What he believed: make tactical plans for the next few steps, never a five-year plan [${plans}].`,
        "",
        APPLICATION_HEADING,
        "For building something valuable with AI, plan only your next few steps and adjust as you learn.",
      ].join("\n");
    });
    setLanguageModel(llm);

    const res = await answer({ question: "How should I plan when building something valuable with AI? Give the person, what happened and what they believed." });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("answered");
    expect(res.body.answer).toContain(APPLICATION_HEADING);
    expect(res.body.citations.map((c: { passage: { text: string } }) => c.passage.text)).toEqual([FIRED, FIVE_YEAR]);
  });

  it("does not expose the prompt or evidence text outside the cited passages", async () => {
    await seedCorpus();
    llm = citing("five-year plan", "Plans.");
    setLanguageModel(llm);

    const res = await answer({ question: "five-year plan" });

    const body = JSON.stringify(res.body);
    expect(body).not.toContain("<evidence");
    expect(body).not.toContain("Grounding rules");
    expect(body).not.toContain(NAPOLEON);
  });
});

describe("POST /answer invalid model responses", () => {
  it.each(["[7]", "[0]", "[1][9]"])("rejects a citation to evidence that was not supplied: %s", async (marker) => {
    await seedCorpus();
    setLanguageModel(createFakeLanguageModel(`Bloomberg disliked long plans ${marker}.`));

    const res = await answer({ question: "What did Bloomberg say about five-year plans?" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/model cited evidence that was not supplied/);
    expect(res.body.answer).toBeUndefined();
  });

  it("rejects an answer without the FROM THE SOURCES section", async () => {
    await seedCorpus();
    setLanguageModel(
      createFakeLanguageModel((req) => `Bloomberg disliked long plans [${evidenceNumberContaining(req.prompt, "five-year plan")}].`)
    );

    const res = await answer({ question: "What did Bloomberg say about five-year plans?" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/FROM THE SOURCES heading exactly once/);
  });

  it("rejects a source sentence without a citation", async () => {
    await seedCorpus();
    setLanguageModel(
      createFakeLanguageModel(
        (req) =>
          `${SOURCES_HEADING}\nBloomberg advised against five-year plans [${evidenceNumberContaining(req.prompt, "five-year plan")}]. ` +
          "He was also fired from Salomon Brothers."
      )
    );

    const res = await answer({ question: "What did Bloomberg say about five-year plans?" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('source sentence has no citation: "He was also fired from Salomon Brothers."');
    expect(res.body.answer).toBeUndefined();
  });

  it("rejects a source sentence naming a company that is not in the cited passage", async () => {
    await seedCorpus();
    setLanguageModel(
      createFakeLanguageModel(
        (req) =>
          `${SOURCES_HEADING}\nPerson: Bloomberg [${evidenceNumberContaining(req.prompt, "five-year plan")}]\n` +
          `What he did: like AppLovin, he avoided five-year plans [${evidenceNumberContaining(req.prompt, "five-year plan")}].`
      )
    );

    const res = await answer({ question: "Tell me about a person: what they did and what happened." });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^sentence cites \[\d+\] but "AppLovin" does not appear in the cited evidence: "like AppLovin/);
  });

  it("rejects a source sentence whose number is not in the cited passage", async () => {
    await seedCorpus();
    setLanguageModel(
      createFakeLanguageModel((req) => `${SOURCES_HEADING}\nBloomberg was fired after 20 years [${evidenceNumberContaining(req.prompt, "Salomon")}].`)
    );

    const res = await answer({ question: "When was Bloomberg fired?" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/"20" does not appear in the cited evidence/);
  });

  it("rejects an APPLICATION section that cites evidence", async () => {
    await seedCorpus();
    setLanguageModel(
      createFakeLanguageModel((req) => {
        const n = evidenceNumberContaining(req.prompt, "five-year plan");
        return `${SOURCES_HEADING}\nBloomberg advised against five-year plans [${n}].\n\n${APPLICATION_HEADING}\nPlan only your next few steps [${n}].`;
      })
    );

    const res = await answer({ question: "How should I plan?" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/APPLICATION section must not cite evidence, but cites \[\d+\]/);
  });

  it("rejects an APPLICATION section that brings in an outside company", async () => {
    await seedCorpus();
    setLanguageModel(
      createFakeLanguageModel(
        (req) =>
          `${SOURCES_HEADING}\nBloomberg advised against five-year plans [${evidenceNumberContaining(req.prompt, "five-year plan")}].\n\n` +
          `${APPLICATION_HEADING}\nDo what AppLovin did and plan only the next few steps.`
      )
    );

    const res = await answer({ question: "How should I plan?" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('the APPLICATION section names "AppLovin", which is not in the evidence or the question');
  });

  it.each([
    ["refusal", /declined/],
    ["max_tokens", /cut off/],
  ] as const)("rejects a %s stop", async (stopReason, message) => {
    await seedCorpus();
    setLanguageModel(createFakeLanguageModel({ text: "Partial answer [1]", stopReason }));

    const res = await answer({ question: "five-year plan" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(message);
  });
});

describe("POST /answer first-person attribution", () => {
  // An exact excerpt of the real Q1 evidence: Bloomberg passage #6, read by the podcast host.
  const Q1_PASSAGE =
    "Take lots of chances and make lots of individual spur-of-the-moment decisions. This is such a great line. Don't devise a five-year plan or a great leap forward. " +
    "central planning didn't work for Stalin or Mao, and it won't work for an entrepreneur either. Every significant advance I or my companies ever made has been " +
    "evolutionary rather than revolutionary. Small earned steps, not big lucky hits. I stay flexible. A reporter asked me what we at Bloomberg had failed at.";
  const QUESTION = "What did Michael Bloomberg say about five-year plans?";

  /** Replies with `lines` under the sources heading, each ending with the evidence number of the Q1 passage. */
  function replying(lines: string[]) {
    return createFakeLanguageModel((req) => {
      const n = evidenceNumberContaining(req.prompt, "Stalin");
      return `${SOURCES_HEADING}\n${lines.map((line) => `${line} [${n}]`).join("\n")}`;
    });
  }

  it("rejects the real llama3.1:8b Q1 answer, whose first-person sentence names no speaker", async () => {
    await ingestEpisode(Q1_PASSAGE, "founders-433-michael-bloomberg-q1");
    llm = replying([
      "Central planning didn't work for Stalin or Mao, and it won't work for an entrepreneur either.",
      "Every significant advance I or my companies ever made has been evolutionary rather than revolutionary.",
      "Don't devise a five-year plan or a great leap forward.",
    ]);
    setLanguageModel(llm);

    const res = await answer({ question: QUESTION });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(
      /^source sentence uses first-person words \("I", "my"\) without naming who is speaking: "Every significant advance I or my companies ever made has been evolutionary rather than revolutionary\. \[\d+\]"$/
    );
  });

  it("accepts the attributed version, citing the Q1 passage", async () => {
    await ingestEpisode(Q1_PASSAGE, "founders-433-michael-bloomberg-q1");
    llm = replying([
      "Bloomberg said that central planning didn't work for Stalin or Mao and wouldn't work for an entrepreneur either.",
      "Senra reads from Bloomberg's book: every significant advance I or my companies ever made has been evolutionary rather than revolutionary.",
      "Bloomberg also said, 'Don't devise a five-year plan or a great leap forward.'",
    ]);
    setLanguageModel(llm);

    const res = await answer({ question: QUESTION });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("answered");
    expect(res.body.answer).toContain("Don't devise a five-year plan or a great leap forward.");
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0].passage.text).toBe(Q1_PASSAGE);
  });
});

describe("POST /answer insufficient evidence", () => {
  it("does not call the model when nothing is retrieved", async () => {
    const res = await answer({ question: "What was Bloomberg's favorite color?" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      question: "What was Bloomberg's favorite color?",
      status: "insufficient_evidence",
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      citations: [],
      retrieval: { mode: "hybrid", passagesUsed: [] },
      model: null,
    });
    expect(llm.requests).toHaveLength(0);
  });

  it("does not call the model when filters exclude every passage", async () => {
    await seedCorpus();
    const res = await answer({ question: "five-year plan", sourceId: "00000000-0000-4000-8000-000000000000" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("insufficient_evidence");
    expect(llm.requests).toHaveLength(0);
  });

  it("returns the model's explicit insufficient-evidence answer with its explanation", async () => {
    await seedCorpus();
    llm = createFakeLanguageModel("INSUFFICIENT_EVIDENCE\nThe passages cover Bloomberg's career but not his favorite color.");
    setLanguageModel(llm);

    const res = await answer({ question: "What was Bloomberg's favorite color?" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "insufficient_evidence",
      answer: `${INSUFFICIENT_EVIDENCE_ANSWER} The passages cover Bloomberg's career but not his favorite color.`,
      citations: [],
      model: "fake-llm@1",
    });
  });

  it("accepts a bare insufficient-evidence marker", async () => {
    await seedCorpus();
    setLanguageModel(createFakeLanguageModel("INSUFFICIENT_EVIDENCE"));

    const res = await answer({ question: "What was Bloomberg's favorite color?" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "insufficient_evidence", answer: INSUFFICIENT_EVIDENCE_ANSWER, citations: [] });
  });

  it("never resolves a citation in the explanation, even one naming a supplied passage", async () => {
    await seedCorpus();
    llm = createFakeLanguageModel(
      (req) =>
        `INSUFFICIENT_EVIDENCE\nThe passages cover Bloomberg's career [${evidenceNumberContaining(req.prompt, "Salomon")}] but not his favorite color.`
    );
    setLanguageModel(llm);

    const res = await answer({ question: "What was Bloomberg's favorite color?" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("insufficient_evidence");
    expect(res.body.citations).toEqual([]);
    expect(res.body.answer).toBe(`${INSUFFICIENT_EVIDENCE_ANSWER} The passages cover Bloomberg's career but not his favorite color.`);
  });

  it.each([
    ["a run of markers after the fixed sentence", "INSUFFICIENT_EVIDENCE\nThe supplied evidence is insufficient to answer the question. [1][2][3]", "The supplied evidence is insufficient to answer the question."],
    ["markers alone", "INSUFFICIENT_EVIDENCE [1][2][3]", ""],
    ["grouped and unsupplied numbers", "INSUFFICIENT_EVIDENCE: Only [1, 3] mention him [42], and neither says it [2].", "Only mention him, and neither says it."],
  ])("drops every citation marker: %s", async (_, reply, explanation) => {
    await seedCorpus();
    setLanguageModel(createFakeLanguageModel(reply));

    const res = await answer({ question: "What was Bloomberg's favorite color?" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("insufficient_evidence");
    expect(res.body.citations).toEqual([]);
    expect(res.body.answer).toBe(explanation ? `${INSUFFICIENT_EVIDENCE_ANSWER} ${explanation}` : INSUFFICIENT_EVIDENCE_ANSWER);
    expect(res.body.answer).not.toMatch(/\[\s*\d/);
  });

  it("returns no citations for an out-of-corpus question, whatever the explanation cites", async () => {
    await seedCorpus();
    llm = createFakeLanguageModel((req) => {
      const count = (req.prompt.match(/<evidence number="/g) ?? []).length;
      const all = Array.from({ length: count }, (_, i) => `[${i + 1}]`).join("");
      return `INSUFFICIENT_EVIDENCE\nThe passages discuss Bloomberg and Napoleon ${all}, not Australia.`;
    });
    setLanguageModel(llm);

    const res = await answer({ question: "What is the capital of Australia?" });

    expect(llm.requests).toHaveLength(1);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("insufficient_evidence");
    expect(res.body.citations).toEqual([]);
    expect(res.body.answer).toBe(`${INSUFFICIENT_EVIDENCE_ANSWER} The passages discuss Bloomberg and Napoleon, not Australia.`);
    expect(res.body.retrieval.passagesUsed.length).toBeGreaterThan(0);
  });

  it("still resolves the citations of a grounded answer", async () => {
    await seedCorpus();
    llm = citing("five-year plan", "Bloomberg advised against five-year plans.");
    setLanguageModel(llm);

    const res = await answer({ question: "What did Bloomberg say about five-year plans?" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("answered");
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0].number).toBe(evidenceNumberContaining(llm.requests[0].prompt, "five-year plan"));
    expect(res.body.citations[0].passage.text).toBe(FIVE_YEAR);
  });
});

describe("POST /answer retrieval", () => {
  it("forces hybrid retrieval, ignoring any requested mode", async () => {
    await seedCorpus();
    setLanguageModel(citing("five-year plan", "Plans."));

    await answer({ question: "five-year plan", mode: "lexical" });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0][0]).toMatchObject({ mode: "hybrid" });
    // Hybrid ran its semantic half: the question was embedded as a query.
    expect(embedder.calls).toContainEqual({ kind: "query", text: "five-year plan" });
  });

  it("retrieves 10 passages by default and honours an explicit limit", async () => {
    for (let i = 0; i < 12; i++) await ingestEpisode(`Episode ${i} discusses plans and planning.`, `episode-${i}`);
    setLanguageModel(citing("Episode", "Plans."));

    const byDefault = await answer({ question: "plans" });
    expect(searchSpy.mock.calls[0][0]).toMatchObject({ limit: "10" });
    expect(byDefault.body.retrieval.passagesUsed).toHaveLength(10);

    const limited = await answer({ question: "plans", limit: 3 });
    expect(limited.body.retrieval.passagesUsed.map((p: { number: number }) => p.number)).toEqual([1, 2, 3]);
  });

  it("passes person and source filters through to retrieval", async () => {
    const { bloomberg } = await seedCorpus();
    llm = citing("five-year plan", "Plans.");
    setLanguageModel(llm);

    const res = await answer({
      question: "What did he say about plans and reading?",
      personId: bloomberg.person.id,
      sourceId: bloomberg.source.id,
    });

    expect(res.status).toBe(200);
    expect(searchSpy.mock.calls[0][0]).toMatchObject({ personId: bloomberg.person.id, sourceId: bloomberg.source.id });
    expect(res.body.retrieval.passagesUsed.every((p: { source_id: string }) => p.source_id === bloomberg.source.id)).toBe(true);
    expect(llm.requests[0].prompt).not.toContain("Napoleon");
  });

  it("restricts retrieval to the sources listed in sourceIds", async () => {
    const { bloomberg, napoleon } = await seedCorpus();
    llm = citing("five-year plan", "Plans.");
    setLanguageModel(llm);

    const res = await answer({ question: "Bloomberg plans Napoleon fired", sourceIds: [bloomberg.source.id, napoleon.source.id] });

    expect(res.status).toBe(200);
    const used = new Set(res.body.retrieval.passagesUsed.map((p: { source_id: string }) => p.source_id));
    expect(used).toEqual(new Set([bloomberg.source.id, napoleon.source.id]));
    expect(llm.requests[0].prompt).not.toContain(FIRED);
  });

  it("accepts sourceIds as a comma-separated string", async () => {
    const { bloomberg, napoleon } = await seedCorpus();
    llm = citing("five-year plan", "Plans.");
    setLanguageModel(llm);

    const res = await answer({ question: "Bloomberg plans Napoleon fired", sourceIds: `${bloomberg.source.id}, ${napoleon.source.id}` });

    expect(res.status).toBe(200);
    expect(res.body.retrieval.passagesUsed).toHaveLength(2);
    expect(llm.requests[0].prompt).not.toContain(FIRED);
  });

  it.each(["lexical", "semantic", "hybrid"] as const)("filters %s retrieval by sourceIds", async (mode) => {
    const { bloomberg, salomon } = await seedCorpus();

    const { results } = await searchPassages({ q: "Bloomberg", mode, sourceIds: [bloomberg.source.id, salomon.source.id] });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.source.id === bloomberg.source.id || r.source.id === salomon.source.id)).toBe(true);
  });

  it("sends full passage text to the model, not the highlighted search snippet", async () => {
    const longText = `${Array.from({ length: 80 }, (_, i) => `filler${i}`).join(" ")} Bloomberg rejected the five-year plan outright.`;
    await ingestEpisode(longText, "long-episode");
    llm = citing("outright", "Plans.");
    setLanguageModel(llm);

    await answer({ question: "five-year plan" });

    const { results } = (await searchSpy.mock.results[0].value) as SearchResponse;
    expect(results[0].snippet).toContain("**");
    expect(llm.requests[0].prompt).toContain(`<passage>\n${longText}\n</passage>`);
    expect(llm.requests[0].prompt).not.toContain(results[0].snippet);
    expect(llm.requests[0].prompt).not.toContain("**");
  });
});

describe("POST /answer attribution and model requests", () => {
  it("tells the model who is speaking and who is only discussed", async () => {
    const { bloomberg } = await seedCorpus();
    const { rows } = await pool.query<{ id: string }>("INSERT INTO people (name) VALUES ('Michael Bloomberg') RETURNING id");
    await pool.query("INSERT INTO source_people (source_id, person_id, role) VALUES ($1, $2, 'subject')", [bloomberg.source.id, rows[0].id]);
    llm = citing("five-year plan", "Host David Senra recounts Bloomberg's view on plans.");
    setLanguageModel(llm);

    const res = await answer({ question: "What did Bloomberg say about five-year plans?", sourceId: bloomberg.source.id });

    const { prompt, system } = llm.requests[0];
    const block = prompt.slice(prompt.indexOf(`<evidence number="${evidenceNumberContaining(prompt, "five-year plan")}">`));
    expect(block).toMatch(/^<evidence number="\d+">\nSource: founders-433-michael-bloomberg\nSource type: podcast\nVoice: David Senra \(host\)\nDiscussed: Michael Bloomberg \(subject\)\n/);
    expect(system).toContain("they are not speaking in the source");
    expect(res.body.citations[0].people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "David Senra", role: "host" }),
        expect.objectContaining({ name: "Michael Bloomberg", role: "subject" }),
      ])
    );
  });

  it("records the exact request: fixed system prompt, prompt built from the retrieved evidence, token cap", async () => {
    await seedCorpus();
    llm = citing("five-year plan", "Plans.");
    setLanguageModel(llm);

    await answer({ question: "  What did Bloomberg say about five-year plans?  " });

    const { results } = (await searchSpy.mock.results[0].value) as SearchResponse;
    const expected = buildAnswerPrompt("What did Bloomberg say about five-year plans?", buildEvidence(results));
    expect(llm.requests).toEqual([{ system: ANSWER_SYSTEM_PROMPT, prompt: expected.prompt, maxTokens: ANSWER_MAX_TOKENS }]);
  });

  it("builds an identical request for an identical question", async () => {
    await seedCorpus();
    llm = citing("five-year plan", "Plans.");
    setLanguageModel(llm);

    await answer({ question: "What did Bloomberg say about five-year plans?" });
    await answer({ question: "What did Bloomberg say about five-year plans?" });

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]).toEqual(llm.requests[0]);
  });
});

describe("POST /answer validation and configuration", () => {
  it.each([
    [{}, /question is required/],
    [{ question: "   " }, /question is required/],
    [{ question: 42 }, /question is required/],
    [{ question: "x".repeat(501) }, /at most 500/],
    [{ question: "q", limit: "10" }, /limit must be an integer/],
    [{ question: "q", limit: 0 }, /limit must be an integer/],
    [{ question: "q", limit: 21 }, /limit must be an integer/],
    [{ question: "q", limit: 2.5 }, /limit must be an integer/],
    [{ question: "q", personId: "not-a-uuid" }, /personId must be a valid UUID/],
    [{ question: "q", sourceId: 7 }, /sourceId must be a valid UUID/],
    [{ question: "q", sourceIds: [] }, /sourceIds must be a non-empty list of valid UUIDs/],
    [{ question: "q", sourceIds: "" }, /sourceIds must be a non-empty list of valid UUIDs/],
    [{ question: "q", sourceIds: ["not-a-uuid"] }, /sourceIds must be a non-empty list of valid UUIDs/],
    [{ question: "q", sourceIds: [7] }, /sourceIds must be a non-empty list of valid UUIDs/],
    [{ question: "q", sourceIds: 7 }, /sourceIds must be a non-empty list of valid UUIDs/],
    [
      { question: "q", sourceId: "00000000-0000-4000-8000-000000000000", sourceIds: ["00000000-0000-4000-8000-000000000000"] },
      /either sourceId or sourceIds, not both/,
    ],
  ])("rejects %j", async (body, message) => {
    const res = await answer(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(llm.requests).toHaveLength(0);
  });

  it("rejects malformed JSON and non-object bodies", async () => {
    const malformed = await request(app).post("/answer").set("Content-Type", "application/json").send('{"question":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/valid JSON/);

    const array = await answer(["question"]);
    expect(array.status).toBe(400);
    expect(array.body.error).toMatch(/JSON object/);

    const text = await request(app).post("/answer").set("Content-Type", "text/plain").send("question");
    expect(text.status).toBe(400);
  });

  it("logs unexpected failures and never returns an empty error message", async () => {
    // Node reports a refused connection (e.g. Postgres down) as an AggregateError with an empty message.
    const failure = new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:5432")], "");
    searchSpy.mockRejectedValueOnce(failure);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await answer({ question: "five-year plan" });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("internal server error");
      expect(logSpy).toHaveBeenCalledWith("POST /answer failed:", failure);
      expect(llm.requests).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never loads the real model under NODE_ENV=test", async () => {
    await seedCorpus();
    setLanguageModel(null);

    const res = await answer({ question: "five-year plan" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/disabled under NODE_ENV=test/);
  });
});
