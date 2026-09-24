import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { ANSWER_SYSTEM_PROMPT, buildAnswerPrompt, buildEvidence } from "../src/answering/prompt";
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

/** Replies with a citation to whichever evidence block holds `needle`. */
function citing(needle: string, sentence: string) {
  return createFakeLanguageModel((req) => `${sentence} [${evidenceNumberContaining(req.prompt, needle)}]`);
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
    expect(res.body.answer).toMatch(/^On the podcast, host David Senra recounts .* \[\d+\]$/);
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
        `He opposed five-year plans [${evidenceNumberContaining(req.prompt, "five-year plan")}] ` +
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

  it("rejects an answer with no citations", async () => {
    await seedCorpus();
    setLanguageModel(createFakeLanguageModel("Bloomberg disliked long plans."));

    const res = await answer({ question: "What did Bloomberg say about five-year plans?" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/without citing/);
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

  it("returns the model's explicit insufficient-evidence answer, validating any citations in it", async () => {
    await seedCorpus();
    llm = createFakeLanguageModel(
      (req) =>
        `INSUFFICIENT_EVIDENCE\nThe passages cover Bloomberg's career [${evidenceNumberContaining(req.prompt, "Salomon")}] but not his favorite color.`
    );
    setLanguageModel(llm);

    const res = await answer({ question: "What was Bloomberg's favorite color?" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("insufficient_evidence");
    expect(res.body.answer).toMatch(new RegExp(`^${INSUFFICIENT_EVIDENCE_ANSWER.replace(/\./g, "\\.")} The passages cover`));
    expect(res.body.answer).not.toContain("INSUFFICIENT_EVIDENCE");
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0].passage.text).toContain("Salomon");
    expect(res.body.model).toBe("fake-llm@1");
  });

  it("accepts a bare insufficient-evidence marker", async () => {
    await seedCorpus();
    setLanguageModel(createFakeLanguageModel("INSUFFICIENT_EVIDENCE"));

    const res = await answer({ question: "What was Bloomberg's favorite color?" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "insufficient_evidence", answer: INSUFFICIENT_EVIDENCE_ANSWER, citations: [] });
  });

  it("still rejects an invalid citation inside an insufficient-evidence answer", async () => {
    await seedCorpus();
    setLanguageModel(createFakeLanguageModel("INSUFFICIENT_EVIDENCE\nOnly passage [42] mentions him."));

    const res = await answer({ question: "What was Bloomberg's favorite color?" });
    expect(res.status).toBe(502);
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
