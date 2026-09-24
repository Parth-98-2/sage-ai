import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  aggregate,
  buildMetricsJson,
  computeQuestionMetrics,
  parseQrels,
  passageKey,
  QrelsError,
  renderComparisonReport,
  runModeComparison,
  sha256Hex,
  textSha256,
  type Judgment,
} from "../scripts/evaluation/metrics";
import { createHttpSearchClient, parseEvalFile, type SearchFn } from "../scripts/evaluation/retrievalEval";
import { createApp } from "../src/app";
import { pool } from "../src/db/pool";
import { embedMissingPassages } from "../src/embeddings/backfill";
import { setEmbedder } from "../src/embeddings/embedder";
import { ingestText } from "../src/ingestion/ingestionService";
import type { SearchResult } from "../src/retrieval/types";
import { createFakeEmbedder } from "./helpers/fakeEmbedder";

const FROZEN_QRELS = "scripts/evaluation/retrieval-qrels.json";
const FROZEN_QRELS_SHA256 = "d876dd937a8f1190173f1f83de5b6357dc842ba066538c9dc4c03e8d5b063186";

function result(sourceTitle: string, ordinal: number, text = `${sourceTitle} ${ordinal}`): SearchResult {
  return {
    passage: { id: `${sourceTitle}-${ordinal}`, ordinal, text, char_start: 0, char_end: text.length, token_count: 1 },
    snippet: "",
    score: 0,
    document: { id: "d", ingestion_method: "text_upload", original_filename: null, source_url: null, created_at: "" },
    source: { id: "s", title: sourceTitle, source_type: "book", external_url: null, published_at: null },
    people: [],
  };
}

function judgment(question: number, sourceTitle: string, ordinal: number, grade: 1 | 2, text = `${sourceTitle} ${ordinal}`): Judgment {
  return { question, sourceTitle, ordinal, grade, textSha256: sha256Hex(text), evidence: "e", rationale: "r" };
}

describe("the frozen judgments file", () => {
  it("is unchanged since approval", () => {
    expect(textSha256(fs.readFileSync(FROZEN_QRELS, "utf-8"))).toBe(FROZEN_QRELS_SHA256);
  });

  const evalFile = ["corpus/retrieval-eval.md", "corpus/retrieval-eval.md.txt"].find((file) => fs.existsSync(file));

  it.skipIf(!evalFile)("validates against the 15 evaluation questions and their file hash", () => {
    const questions = parseEvalFile(fs.readFileSync(evalFile!, "utf-8"));
    const qrels = parseQrels(fs.readFileSync(FROZEN_QRELS, "utf-8"), questions.map((q) => q.number));

    expect(qrels.evalFileSha256).toBe(sha256Hex(fs.readFileSync(evalFile!)));
    expect(qrels.judgments).toHaveLength(58);
    expect(qrels.judgments.filter((j) => j.grade === 2)).toHaveLength(25);
  });
});

describe("parseQrels", () => {
  const valid = (judgments: unknown[]) => JSON.stringify({ status: "s", evalFile: "f", evalFileSha256: "x", judgments });

  it("accepts well-formed judgments", () => {
    const qrels = parseQrels(valid([judgment(1, "A", 0, 2), judgment(1, "B", 3, 1)]), [1]);
    expect(qrels.judgments).toHaveLength(2);
  });

  it.each([
    ["an unknown question", [judgment(9, "A", 0, 2)], /unknown question 9/],
    ["a grade outside 1-2", [{ ...judgment(1, "A", 0, 2), grade: 0 }], /grade must be 1 or 2/],
    ["a malformed fingerprint", [{ ...judgment(1, "A", 0, 2), textSha256: "abc" }], /SHA-256/],
    ["a duplicate passage", [judgment(1, "A", 0, 2), judgment(1, "A", 0, 1)], /duplicate judgment for Q1 A#0/],
    ["a question without a grade-2 passage", [judgment(1, "A", 0, 1)], /Q1 has no grade-2 judgment/],
  ])("rejects %s", (_label, judgments, error) => {
    expect(() => parseQrels(valid(judgments), [1])).toThrow(error);
  });
});

describe("computeQuestionMetrics", () => {
  const judgments = [judgment(1, "A", 1, 2), judgment(1, "B", 2, 1), judgment(1, "C", 3, 2), judgment(2, "A", 1, 2)];

  it("computes ranks, hits, reciprocal rank and graded nDCG@10", () => {
    const results = [result("X", 0), result("B", 2), result("A", 1), result("Y", 0), result("Z", 0), result("W", 0)];

    const m = computeQuestionMetrics(1, results, judgments);

    expect(m.bestPrimaryRank).toBe(3);
    expect(m.bestRelevantRank).toBe(2);
    expect([m.hitAt1, m.hitAt5, m.hitAt10]).toEqual([false, true, true]);
    expect(m.reciprocalRank).toBeCloseTo(1 / 3, 6);
    const dcg = 1 / Math.log2(3) + 3 / Math.log2(4);
    const idcg = 3 / Math.log2(2) + 3 / Math.log2(3) + 1 / Math.log2(4);
    expect(m.ndcgAt10).toBeCloseTo(dcg / idcg, 6);
    expect(m.unjudgedTop5).toEqual([
      { rank: 1, sourceTitle: "X", ordinal: 0 },
      { rank: 4, sourceTitle: "Y", ordinal: 0 },
      { rank: 5, sourceTitle: "Z", ordinal: 0 },
    ]);
    expect(m.judged).toEqual([
      { sourceTitle: "A", ordinal: 1, grade: 2, rank: 3 },
      { sourceTitle: "C", ordinal: 3, grade: 2, rank: null },
      { sourceTitle: "B", ordinal: 2, grade: 1, rank: 2 },
    ]);
  });

  it("scores a question whose primary passage is absent as zero, not as an error", () => {
    const m = computeQuestionMetrics(2, [result("B", 2), result("Q", 1)], judgments);
    expect(m).toMatchObject({ bestPrimaryRank: null, bestRelevantRank: null, reciprocalRank: 0, ndcgAt10: 0, hitAt10: false });
    expect(m.unjudgedTop5).toHaveLength(2);
  });

  it("counts ranks beyond 10 for best rank but not for nDCG@10", () => {
    const results = [...Array.from({ length: 11 }, (_, i) => result("F", i)), result("A", 1)];
    const m = computeQuestionMetrics(2, results, judgments);
    expect(m.bestPrimaryRank).toBe(12);
    expect(m.hitAt10).toBe(false);
    expect(m.ndcgAt10).toBe(0);
    expect(m.reciprocalRank).toBeCloseTo(1 / 12, 6);
  });

  it("refuses to score when a judged passage's text has drifted", () => {
    expect(() => computeQuestionMetrics(1, [result("A", 1, "different text")], judgments)).toThrow(QrelsError);
  });
});

describe("aggregate", () => {
  it("averages reciprocal rank and nDCG and counts hits", () => {
    const judgments = [judgment(1, "A", 0, 2), judgment(2, "A", 0, 2)];
    const metrics = [
      computeQuestionMetrics(1, [result("A", 0)], judgments),
      computeQuestionMetrics(2, [result("X", 0), result("Y", 0), result("A", 0)], judgments),
    ];
    expect(aggregate(metrics)).toEqual({
      questions: 2,
      mrr: Math.round(((1 + 1 / 3) / 2) * 1e6) / 1e6,
      meanNdcgAt10: Math.round(((1 + 1 / Math.log2(4)) / 2) * 1e6) / 1e6,
      hitAt1: 1,
      hitAt5: 2,
      hitAt10: 2,
      primaryFound: 2,
    });
  });
});

describe("runModeComparison and reports", () => {
  const FIXTURE = ["### Q1", "", "First?", "", "**Expected source:** A", "**Expected passage/concept:** a", "",
    "### Q6", "", "Sixth?", "", "**Expected source:** B", "**Expected passage/concept:** b"].join("\n");
  const questions = parseEvalFile(FIXTURE);
  const judgments = [judgment(1, "A", 0, 2), judgment(6, "B", 0, 2)];
  const rankings: Record<string, SearchResult[]> = {
    lexical: [result("A", 0), result("B", 0)],
    semantic: [result("B", 0), result("A", 0)],
  };
  const searchForMode = (mode: string): SearchFn => async (q) => ({ query: q, results: rankings[mode] });
  const metadata = {
    commit: "abc",
    baseUrl: "http://x",
    evalFile: "eval.md",
    evalFileSha256: "e".repeat(64),
    qrelsFile: "qrels.json",
    qrelsSha256: "f".repeat(64),
    embeddingModel: "fake",
    rrfK: 60,
    hybridCandidateDepth: 50,
  };

  it("scores each mode on the same questions", async () => {
    const results = await runModeComparison(questions, judgments, searchForMode, ["lexical", "semantic"]);
    expect(results.map((r) => r.mode)).toEqual(["lexical", "semantic"]);
    expect(results[0].metrics.map((m) => m.bestPrimaryRank)).toEqual([1, 2]);
    expect(results[1].metrics.map((m) => m.bestPrimaryRank)).toEqual([2, 1]);
  });

  it("aborts when any search in a mode fails", async () => {
    const failing = (mode: string): SearchFn => async (q) => {
      if (mode === "semantic") throw new Error("model not loaded");
      return { query: q, results: [] };
    };
    await expect(runModeComparison(questions, judgments, failing, ["lexical", "semantic"])).rejects.toThrow(
      /semantic: 2 question\(s\) failed, e.g. Q1: model not loaded/
    );
  });

  it("builds a timestamp-free metrics document and a readable comparison", async () => {
    const results = await runModeComparison(questions, judgments, searchForMode, ["lexical", "semantic"]);
    const json = buildMetricsJson(results, questions, metadata);

    expect(JSON.stringify(json)).not.toMatch(/generatedAt|\d{4}-\d{2}-\d{2}T/);
    expect(json.experiment.focusQuestions).toEqual([6]);
    expect(json.modes.lexical.overall.hitAt1).toBe(1);

    const report = renderComparisonReport(results, questions, { ...metadata, generatedAt: "now" });
    expect(report).toContain("## Focus questions (Q6)");
    expect(report).toContain("| Q6 | 2 / 2 | 1 / 1 |");
    expect(report).toContain("| lexical | 0.750 |");
    expect(report).toContain("unjudged");
  });
});

describe("comparison against the real app (fake embedder)", () => {
  let server: Server;
  let baseUrl: string;
  const embedder = createFakeEmbedder();

  beforeAll(async () => {
    setEmbedder(embedder);
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    setEmbedder(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it("produces byte-identical metrics across repeated runs", async () => {
    const texts = ["courage and planning", "flexible plans adapt", "gardens and water"];
    const ingested = [];
    for (const [i, rawText] of texts.entries()) {
      ingested.push(
        await ingestText({ rawText, suggestedTitle: `T${i}`, sourceType: "book", personName: "P", ingestionMethod: "text_upload" })
      );
    }
    await embedMissingPassages(embedder);
    const questions = parseEvalFile(
      ["### Q1", "", "What about flexible plans?", "", "**Expected source:** T", "**Expected passage/concept:** plans"].join("\n")
    );
    const judgments = [judgment(1, "T1", 0, 2, ingested[1].passages[0].text)];
    const metadata = {
      commit: "abc", baseUrl, evalFile: "e", evalFileSha256: "e", qrelsFile: "q", qrelsSha256: "q",
      embeddingModel: embedder.modelId, rrfK: 60, hybridCandidateDepth: 50,
    };

    const run = async () =>
      JSON.stringify(
        buildMetricsJson(
          await runModeComparison(questions, judgments, (mode) => createHttpSearchClient(baseUrl, mode), ["lexical", "semantic", "hybrid"]),
          questions,
          metadata
        )
      );

    const first = await run();
    expect(await run()).toBe(first);
    const parsed = JSON.parse(first);
    expect(Object.keys(parsed.modes)).toEqual(["lexical", "semantic", "hybrid"]);
    expect(parsed.modes.hybrid.questions[0].judged[0]).toMatchObject({ sourceTitle: "T1", ordinal: 0, grade: 2 });
    expect(passageKey("T1", 0)).toBe("T1#0");
  });
});
