import type { SearchResponse, SearchResult } from "../../src/retrieval/types";

/**
 * Retrieval evaluation helpers. This module only parses the human-written
 * evaluation set, calls the existing GET /search endpoint, and renders what
 * came back. It deliberately does not judge relevance: the expected
 * source/concept in the evaluation file is a reference for a human reviewer.
 */

export const EVAL_RESULT_LIMIT = 10;

export interface EvalField {
  label: string;
  value: string;
}

export interface EvalQuestion {
  number: number;
  category: string | null;
  question: string;
  /** Every `**Label:** value` line, in file order (Expected source, Difficulty, ...). */
  fields: EvalField[];
}

export type SearchFn = (q: string, limit: number) => Promise<SearchResponse>;

export interface QuestionRun {
  question: EvalQuestion;
  results: SearchResult[];
  error: string | null;
}

export interface ReportMetadata {
  generatedAt: string;
  baseUrl: string;
  evalFile: string;
  commit: string | null;
}

const REQUIRED_FIELDS = ["Expected source", "Expected passage/concept"];
const QUESTION_HEADING = /^###\s+Q(\d+)\s*$/;
const FIELD_LINE = /^\*\*(.+?):\*\*\s*(.*)$/;

export function getField(question: EvalQuestion, label: string): string | undefined {
  return question.fields.find((field) => field.label.toLowerCase() === label.toLowerCase())?.value;
}

/**
 * Parses the evaluation Markdown: `## ...` headings set the category, each
 * `### Qn` starts a question, the first prose lines are the question text,
 * and `**Label:** value` lines are its fields. A question ends at the next
 * heading or `---` rule.
 */
export function parseEvalFile(markdown: string): EvalQuestion[] {
  const questions: EvalQuestion[] = [];
  let category: string | null = null;
  let current: { number: number; category: string | null; questionLines: string[]; fields: EvalField[] } | null =
    null;

  const finish = () => {
    if (!current) return;
    const question = current.questionLines.join(" ").trim();
    if (!question) throw new Error(`Q${current.number}: question text is missing`);
    for (const label of REQUIRED_FIELDS) {
      if (!current.fields.some((field) => field.label.toLowerCase() === label.toLowerCase())) {
        throw new Error(`Q${current.number}: missing "**${label}:**" field`);
      }
    }
    if (questions.some((q) => q.number === current!.number)) {
      throw new Error(`Q${current.number}: duplicate question number`);
    }
    questions.push({ number: current.number, category: current.category, question, fields: current.fields });
    current = null;
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();

    const questionHeading = QUESTION_HEADING.exec(line);
    if (questionHeading) {
      finish();
      current = { number: Number(questionHeading[1]), category, questionLines: [], fields: [] };
      continue;
    }
    if (line.startsWith("#") || line === "---") {
      finish();
      if (line.startsWith("## ")) category = line.slice(3).trim();
      continue;
    }
    if (!current || line === "") continue;

    const field = FIELD_LINE.exec(line);
    if (field) {
      current.fields.push({ label: field[1].trim(), value: field[2].trim() });
    } else if (current.fields.length === 0) {
      current.questionLines.push(line);
    } else {
      throw new Error(`Q${current.number}: unexpected text after fields: "${line}"`);
    }
  }
  finish();

  if (questions.length === 0) throw new Error("no questions (### Qn headings) found");
  return questions;
}

/** Calls the running Sage server's GET /search; no retrieval logic lives here. */
export function createHttpSearchClient(baseUrl: string): SearchFn {
  return async (q, limit) => {
    const url = new URL("/search", baseUrl);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url);
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(`GET /search returned ${response.status}: ${body?.error ?? response.statusText}`);
    }
    return body as SearchResponse;
  };
}

export async function runEvaluation(
  questions: EvalQuestion[],
  search: SearchFn,
  limit = EVAL_RESULT_LIMIT
): Promise<QuestionRun[]> {
  const runs: QuestionRun[] = [];
  for (const question of questions) {
    try {
      const response = await search(question.question, limit);
      runs.push({ question, results: response.results, error: null });
    } catch (err) {
      runs.push({ question, results: [], error: (err as Error).message });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Markdown rendering

const EXCERPT_CHARS = 700;

/** Escapes text so corpus content cannot inject HTML or Markdown structure. */
function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]|#])/g, "\\$1");
}

/** Keeps the `**...**` highlight markers that ts_headline adds; escapes everything else. */
function renderSnippet(snippet: string): string {
  return snippet
    .split("**")
    .map(escapeMarkdown)
    .join("**")
    .replace(/\s+/g, " ")
    .trim();
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatScore(score: number): string {
  return score.toFixed(4);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function renderResult(result: SearchResult, rank: number): string {
  const { passage, source } = result;
  const text = passage.text;
  const excerpt = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()} …` : text;

  const lines = [
    `#### ${rank}. ${escapeMarkdown(source.title)} · passage ${passage.ordinal} · score ${formatScore(result.score)}`,
    "",
    `Snippet: ${renderSnippet(result.snippet)}`,
    "",
    blockquote(escapeMarkdown(excerpt)),
  ];
  if (text.length > EXCERPT_CHARS) {
    lines.push(
      "",
      `<details><summary>Full passage (${wordCount(text)} words, chars ${passage.char_start}–${passage.char_end})</summary>`,
      "",
      blockquote(escapeMarkdown(text)),
      "",
      "</details>"
    );
  }
  return lines.join("\n");
}

function renderQuestion(run: QuestionRun): string {
  const { question, results, error } = run;
  const lines = [
    `## Q${question.number}${question.category ? ` — ${escapeMarkdown(question.category)}` : ""}`,
    "",
    `**Question:** ${escapeMarkdown(question.question)}`,
    "",
    ...question.fields.map((field) => `**${escapeMarkdown(field.label)}:** ${escapeMarkdown(field.value)}  `),
    "",
  ];

  if (error) {
    lines.push(`**Search failed:** ${escapeMarkdown(error)}`, "");
  } else if (results.length === 0) {
    lines.push("_No results returned._", "");
  } else {
    lines.push(
      `### Retrieved results (${results.length})`,
      "",
      "| Rank | Score | Source | Passage ordinal | Chars |",
      "|---:|---:|---|---:|---|",
      ...results.map(
        (result, index) =>
          `| ${index + 1} | ${formatScore(result.score)} | ${escapeMarkdown(result.source.title)} | ${
            result.passage.ordinal
          } | ${result.passage.char_start}–${result.passage.char_end} |`
      ),
      "",
      ...results.flatMap((result, index) => [renderResult(result, index + 1), ""])
    );
  }

  lines.push(
    "### Human judgement",
    "",
    "- [ ] Expected passage in top 1",
    "- [ ] Expected passage in top 5",
    "- [ ] Expected passage in top 10",
    "- Rank of best relevant passage: ",
    "- Genuinely relevant, or only matching words: ",
    "- Obviously irrelevant high-ranking results: ",
    "",
    "---",
    ""
  );
  return lines.join("\n");
}

export function renderMarkdownReport(runs: QuestionRun[], metadata: ReportMetadata): string {
  const summaryRows = runs.map((run) => {
    const top = run.results[0];
    const topCell = run.error
      ? "search failed"
      : top
        ? `${escapeMarkdown(top.source.title)} · passage ${top.passage.ordinal} · ${formatScore(top.score)}`
        : "no results";
    return `| Q${run.question.number} | ${escapeMarkdown(
      getField(run.question, "Expected source") ?? ""
    )} | ${run.results.length} | ${topCell} |`;
  });

  return [
    "# Sage Retrieval Evaluation Report",
    "",
    `- Generated: ${metadata.generatedAt}`,
    `- Commit: ${metadata.commit ?? "unknown"}`,
    `- Endpoint: \`GET ${metadata.baseUrl}/search?q=…&limit=${EVAL_RESULT_LIMIT}\``,
    `- Evaluation file: \`${metadata.evalFile}\``,
    `- Questions: ${runs.length}`,
    "",
    "Results are listed exactly as returned by the existing `/search` endpoint.",
    "Relevance is **not** judged automatically: compare each result against the",
    "expected source and passage/concept, and fill in the human judgement checklist.",
    "",
    "## Summary",
    "",
    "| Question | Expected source | Results | Top result (source · passage · score) |",
    "|---|---|---:|---|",
    ...summaryRows,
    "",
    "---",
    "",
    ...runs.map(renderQuestion),
  ].join("\n");
}
