import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHttpSearchClient,
  getField,
  parseEvalFile,
  renderMarkdownReport,
  runEvaluation,
  type QuestionRun,
  type SearchFn,
} from "../scripts/evaluation/retrievalEval";
import { createApp } from "../src/app";
import { pool } from "../src/db/pool";
import { ingestText } from "../src/ingestion/ingestionService";
import type { SearchResult } from "../src/retrieval/types";

const FIXTURE = [
  "# Eval Set",
  "",
  "Intro prose that is not a question.",
  "",
  "---",
  "",
  "## Category 1 — Direct",
  "",
  "### Q1",
  "",
  "What did Bloomberg say about five-year plans?",
  "",
  "**Expected source:** Bloomberg",
  "**Expected passage/concept:** Don’t devise a five-year plan.",
  "",
  "### Q2",
  "",
  "A question that wraps",
  "onto a second line?",
  "",
  "**Expected source:** Napoleon",
  "**Expected passage/concept:** Projects, not plans.",
  "",
  "**Secondary source:** Bloomberg",
  "**Secondary concept:** Act from day one.",
  "",
  "**Difficulty:** High",
  "",
  "---",
  "",
  "## Category 2 — Reworded",
  "",
  "### Q3",
  "",
  "How should preparation and execution differ?",
  "",
  "**Expected source:** Napoleon",
  "**Expected passage/concept:** Cautious in planning, bold in execution.",
  "",
  "---",
  "",
  "## Evaluation rule",
  "",
  "* Record things.",
].join("\n");

describe("parseEvalFile", () => {
  it("parses questions, categories and fields in file order", () => {
    const questions = parseEvalFile(FIXTURE);

    expect(questions.map((q) => q.number)).toEqual([1, 2, 3]);
    expect(questions[0]).toEqual({
      number: 1,
      category: "Category 1 — Direct",
      question: "What did Bloomberg say about five-year plans?",
      fields: [
        { label: "Expected source", value: "Bloomberg" },
        { label: "Expected passage/concept", value: "Don’t devise a five-year plan." },
      ],
    });
    expect(questions[1].question).toBe("A question that wraps onto a second line?");
    expect(questions[1].fields.map((f) => f.label)).toEqual([
      "Expected source",
      "Expected passage/concept",
      "Secondary source",
      "Secondary concept",
      "Difficulty",
    ]);
    expect(getField(questions[1], "difficulty")).toBe("High");
    expect(questions[2].category).toBe("Category 2 — Reworded");
  });

  it("parses CRLF input identically to LF input", () => {
    expect(parseEvalFile(FIXTURE.replace(/\n/g, "\r\n"))).toEqual(parseEvalFile(FIXTURE));
  });

  it("rejects a question missing a required field", () => {
    const markdown = "### Q1\n\nA question?\n\n**Expected source:** Bloomberg\n";
    expect(() => parseEvalFile(markdown)).toThrow(/Q1: missing "\*\*Expected passage\/concept:\*\*"/);
  });

  it("rejects a question with no question text", () => {
    const markdown = "### Q1\n\n**Expected source:** A\n**Expected passage/concept:** B\n";
    expect(() => parseEvalFile(markdown)).toThrow(/Q1: question text is missing/);
  });

  it("rejects duplicate question numbers", () => {
    const question = "### Q1\n\nA?\n\n**Expected source:** A\n**Expected passage/concept:** B\n\n";
    expect(() => parseEvalFile(question + question)).toThrow(/Q1: duplicate/);
  });

  it("rejects stray prose after a question's fields", () => {
    const markdown = "### Q1\n\nA?\n\n**Expected source:** A\n**Expected passage/concept:** B\n\nStray note.\n";
    expect(() => parseEvalFile(markdown)).toThrow(/Q1: unexpected text after fields/);
  });

  it("rejects a file with no questions", () => {
    expect(() => parseEvalFile("# Nothing here\n")).toThrow(/no questions/);
  });

  const realEvalFile = ["corpus/retrieval-eval.md", "corpus/retrieval-eval.md.txt"].find((file) =>
    fs.existsSync(file)
  );

  it.skipIf(!realEvalFile)("parses all 15 questions from the corpus evaluation file", () => {
    const questions = parseEvalFile(fs.readFileSync(realEvalFile!, "utf-8"));

    expect(questions.map((q) => q.number)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    for (const question of questions) {
      expect(question.question.length).toBeGreaterThan(0);
      expect(getField(question, "Expected source")).toMatch(/^(Bloomberg|Napoleon)$/);
      expect(getField(question, "Expected passage/concept")).toBeTruthy();
    }
    expect(questions[0].question).toBe("What did Michael Bloomberg say about making five-year plans?");
    expect(getField(questions[12], "Secondary source")).toBe("Napoleon");
    expect(getField(questions[14], "Difficulty")).toBe("Very high");
    expect(questions[10].category).toMatch(/^Category 3/);
  });
});

function fakeResult(overrides: { title?: string; ordinal?: number; score?: number; text?: string; snippet?: string }) {
  const text = overrides.text ?? "Passage text.";
  return {
    passage: { id: "p", ordinal: overrides.ordinal ?? 0, text, char_start: 0, char_end: text.length, token_count: 2 },
    snippet: overrides.snippet ?? "Passage **text**.",
    score: overrides.score ?? 0.5,
    document: {
      id: "d",
      ingestion_method: "text_upload",
      original_filename: "f.txt",
      source_url: null,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    source: {
      id: "s",
      title: overrides.title ?? "founders-433-michael-bloomberg",
      source_type: "podcast",
      external_url: null,
      published_at: null,
    },
    people: [],
  } satisfies SearchResult;
}

describe("runEvaluation", () => {
  it("queries each question in order with the result limit and records per-question errors", async () => {
    const questions = parseEvalFile(FIXTURE);
    const calls: Array<[string, number]> = [];
    const search: SearchFn = async (q, limit) => {
      calls.push([q, limit]);
      if (q.startsWith("A question")) throw new Error("GET /search returned 500: boom");
      return { query: q, results: [fakeResult({})] };
    };

    const runs = await runEvaluation(questions, search);

    expect(calls).toEqual(questions.map((q) => [q.question, 10]));
    expect(runs.map((r) => r.error)).toEqual([null, "GET /search returned 500: boom", null]);
    expect(runs[0].results).toHaveLength(1);
    expect(runs[1].results).toEqual([]);
  });
});

describe("renderMarkdownReport", () => {
  const metadata = {
    generatedAt: "2026-09-23T00:00:00.000Z",
    baseUrl: "http://localhost:3000",
    evalFile: "corpus/retrieval-eval.md",
    commit: "abc1234",
  };

  function render(runs: QuestionRun[]) {
    return renderMarkdownReport(runs, metadata);
  }

  it("shows the question, all reference fields and every ranked result", () => {
    const [question] = parseEvalFile(FIXTURE);
    const longText = `${"word ".repeat(300)}END_OF_PASSAGE`;
    const report = render([
      {
        question,
        error: null,
        results: [
          fakeResult({ ordinal: 4, score: 0.123456, text: "Tactical plans only." }),
          fakeResult({ title: "founders-432-napoleon", ordinal: 7, score: 0.05, text: longText }),
        ],
      },
    ]);

    expect(report).toContain("- Commit: abc1234");
    expect(report).toContain("## Q1 — Category 1 — Direct");
    expect(report).toContain("**Question:** What did Bloomberg say about five-year plans?");
    expect(report).toContain("**Expected source:** Bloomberg");
    expect(report).toContain("**Expected passage/concept:** Don’t devise a five-year plan.");
    expect(report).toContain("| 1 | 0.1235 | founders-433-michael-bloomberg | 4 |");
    expect(report).toContain("| 2 | 0.0500 | founders-432-napoleon | 7 |");
    expect(report).toContain("> Tactical plans only.");
    expect(report).toContain("<details><summary>Full passage (301 words");
    expect(report).toContain("END\\_OF\\_PASSAGE");
    expect(report).toContain("Snippet: Passage **text**.");
    expect(report).toContain("- [ ] Expected passage in top 1");
  });

  it("does not judge correctness", () => {
    const [question] = parseEvalFile(FIXTURE);
    const report = render([{ question, error: null, results: [fakeResult({})] }]);
    expect(report).not.toMatch(/\b(correct|incorrect|pass|fail|hit|miss)\b/i);
    expect(report).not.toContain("- [x]");
  });

  it("escapes HTML and Markdown in corpus text but keeps snippet highlights", () => {
    const [question] = parseEvalFile(FIXTURE);
    const report = render([
      {
        question,
        error: null,
        results: [
          fakeResult({
            title: "Title | with pipe",
            text: "<script>alert(1)</script> # not a heading",
            snippet: "a **<b>match</b>** here",
          }),
        ],
      },
    ]);

    expect(report).not.toContain("<script>");
    expect(report).toContain("&lt;script&gt;");
    expect(report).toContain("Title \\| with pipe");
    expect(report).toContain("\\# not a heading");
    expect(report).toContain("Snippet: a **&lt;b&gt;match&lt;/b&gt;** here");
  });

  it("reports search failures and empty result sets explicitly", () => {
    const [q1, q2] = parseEvalFile(FIXTURE);
    const report = render([
      { question: q1, error: "GET /search returned 500: boom", results: [] },
      { question: q2, error: null, results: [] },
    ]);

    expect(report).toContain("**Search failed:** GET /search returned 500: boom");
    expect(report).toContain("_No results returned._");
    expect(report).toContain("| Q1 | Bloomberg | 0 | search failed |");
    expect(report).toContain("| Q2 | Napoleon | 0 | no results |");
  });
});

describe("createHttpSearchClient against the real app", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it("returns the /search response for a question", async () => {
    await ingestText({
      rawText: "Don't devise a five-year plan. Make tactical plans for the next few steps.",
      suggestedTitle: "founders-433-michael-bloomberg",
      sourceType: "podcast",
      personName: "Michael Bloomberg",
      ingestionMethod: "text_upload",
    });

    const response = await createHttpSearchClient(baseUrl)("What did Bloomberg say about five-year plans?", 10);

    expect(response.results).toHaveLength(1);
    expect(response.results[0].source.title).toBe("founders-433-michael-bloomberg");
    expect(response.results[0].passage.ordinal).toBe(0);
  });

  it("surfaces the endpoint's error message on a non-2xx response", async () => {
    await expect(createHttpSearchClient(baseUrl)("x".repeat(501), 10)).rejects.toThrow(
      /GET \/search returned 400: q must be at most 500 characters/
    );
  });
});
