import crypto from "node:crypto";
import type { SearchMode, SearchResult } from "../../src/retrieval/types";
import { escapeMarkdown, runEvaluation, type EvalQuestion, type QuestionRun, type SearchFn } from "./retrievalEval";

/**
 * Metrics for the lexical / semantic / hybrid comparison. Relevance comes only
 * from the frozen, human-authored judgments file (qrels): grade 2 = primary
 * evidence, grade 1 = secondary relevant evidence, and a passage that is not
 * in the file is unjudged (unknown), never assumed irrelevant.
 */

/** Results requested per question, so best ranks are exact rather than "not in top 10". */
export const RESULT_DEPTH = 50;
/** The pre-registered lexical-failure questions the experiment is about. */
export const FOCUS_QUESTIONS = [6, 10, 11, 12, 14];

export interface Judgment {
  question: number;
  sourceTitle: string;
  ordinal: number;
  grade: 1 | 2;
  textSha256: string;
  evidence: string;
  rationale: string;
}

export interface QrelsFile {
  status: string;
  evalFile: string;
  evalFileSha256: string;
  judgments: Judgment[];
}

export class QrelsError extends Error {}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function passageKey(sourceTitle: string, ordinal: number): string {
  return `${sourceTitle}#${ordinal}`;
}

/** Parses and validates the judgments file against the evaluation questions. */
export function parseQrels(json: string, questionNumbers: number[]): QrelsFile {
  const data = JSON.parse(json) as Partial<QrelsFile>;
  if (typeof data !== "object" || data === null || !Array.isArray(data.judgments)) {
    throw new QrelsError("qrels must be an object with a judgments array");
  }
  if (typeof data.evalFileSha256 !== "string") throw new QrelsError("qrels is missing evalFileSha256");

  const known = new Set(questionNumbers);
  const seen = new Set<string>();
  data.judgments.forEach((j, index) => {
    const where = `judgment ${index + 1}`;
    if (!Number.isInteger(j.question) || !known.has(j.question)) throw new QrelsError(`${where}: unknown question ${j.question}`);
    if (typeof j.sourceTitle !== "string" || !j.sourceTitle) throw new QrelsError(`${where}: sourceTitle is required`);
    if (!Number.isInteger(j.ordinal) || j.ordinal < 0) throw new QrelsError(`${where}: ordinal must be a non-negative integer`);
    if (j.grade !== 1 && j.grade !== 2) throw new QrelsError(`${where}: grade must be 1 or 2`);
    if (typeof j.textSha256 !== "string" || !/^[0-9a-f]{64}$/.test(j.textSha256)) {
      throw new QrelsError(`${where}: textSha256 must be a SHA-256 hex digest`);
    }
    const key = `Q${j.question} ${passageKey(j.sourceTitle, j.ordinal)}`;
    if (seen.has(key)) throw new QrelsError(`${where}: duplicate judgment for ${key}`);
    seen.add(key);
  });
  for (const question of questionNumbers) {
    if (!data.judgments.some((j) => j.question === question && j.grade === 2)) {
      throw new QrelsError(`Q${question} has no grade-2 judgment`);
    }
  }
  return data as QrelsFile;
}

// ---------------------------------------------------------------------------
// Per-question metrics

export interface JudgedRank {
  sourceTitle: string;
  ordinal: number;
  grade: 1 | 2;
  rank: number | null;
}

export interface QuestionMetrics {
  question: number;
  resultCount: number;
  /** Rank (1-based) of the best grade-2 passage within the returned results, or null. */
  bestPrimaryRank: number | null;
  /** Rank of the best grade-1 or grade-2 passage, or null. */
  bestRelevantRank: number | null;
  hitAt1: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  reciprocalRank: number;
  ndcgAt10: number;
  judged: JudgedRank[];
  unjudgedTop5: Array<{ rank: number; sourceTitle: string; ordinal: number }>;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const gain = (grade: number) => 2 ** grade - 1;
const discount = (rank: number) => Math.log2(rank + 1);

/**
 * Scores one question's ranked results against its judgments. Throws a
 * QrelsError if a judged passage's text no longer matches its fingerprint,
 * since the judgment would then refer to different text.
 */
export function computeQuestionMetrics(
  question: number,
  results: SearchResult[],
  judgments: Judgment[]
): QuestionMetrics {
  const own = judgments.filter((j) => j.question === question);
  const byKey = new Map(own.map((j) => [passageKey(j.sourceTitle, j.ordinal), j]));
  const rankByKey = new Map<string, number>();
  const unjudgedTop5: QuestionMetrics["unjudgedTop5"] = [];
  let dcg = 0;

  results.forEach((result, index) => {
    const rank = index + 1;
    const key = passageKey(result.source.title, result.passage.ordinal);
    const judgment = byKey.get(key);
    if (!judgment) {
      if (rank <= 5) unjudgedTop5.push({ rank, sourceTitle: result.source.title, ordinal: result.passage.ordinal });
      return;
    }
    if (sha256Hex(result.passage.text) !== judgment.textSha256) {
      throw new QrelsError(`Q${question}: ${key} text no longer matches its judged fingerprint; the corpus has drifted`);
    }
    if (!rankByKey.has(key)) rankByKey.set(key, rank);
    if (rank <= 10) dcg += gain(judgment.grade) / discount(rank);
  });

  const judged = own
    .map((j) => ({ sourceTitle: j.sourceTitle, ordinal: j.ordinal, grade: j.grade, rank: rankByKey.get(passageKey(j.sourceTitle, j.ordinal)) ?? null }))
    .sort((a, b) => b.grade - a.grade || a.sourceTitle.localeCompare(b.sourceTitle) || a.ordinal - b.ordinal);
  const bestRank = (grades: number[]) =>
    judged
      .filter((j) => grades.includes(j.grade) && j.rank !== null)
      .reduce<number | null>((best, j) => (best === null || j.rank! < best ? j.rank : best), null);

  const bestPrimaryRank = bestRank([2]);
  const idealGains = own.map((j) => gain(j.grade)).sort((a, b) => b - a).slice(0, 10);
  const idcg = idealGains.reduce((sum, g, index) => sum + g / discount(index + 1), 0);

  return {
    question,
    resultCount: results.length,
    bestPrimaryRank,
    bestRelevantRank: bestRank([1, 2]),
    hitAt1: bestPrimaryRank !== null && bestPrimaryRank <= 1,
    hitAt5: bestPrimaryRank !== null && bestPrimaryRank <= 5,
    hitAt10: bestPrimaryRank !== null && bestPrimaryRank <= 10,
    reciprocalRank: round(bestPrimaryRank ? 1 / bestPrimaryRank : 0),
    ndcgAt10: round(idcg > 0 ? dcg / idcg : 0),
    judged,
    unjudgedTop5,
  };
}

export interface AggregateMetrics {
  questions: number;
  mrr: number;
  meanNdcgAt10: number;
  hitAt1: number;
  hitAt5: number;
  hitAt10: number;
  primaryFound: number;
}

export function aggregate(metrics: QuestionMetrics[]): AggregateMetrics {
  const n = metrics.length;
  const mean = (values: number[]) => (n === 0 ? 0 : round(values.reduce((a, b) => a + b, 0) / n));
  return {
    questions: n,
    mrr: mean(metrics.map((m) => m.reciprocalRank)),
    meanNdcgAt10: mean(metrics.map((m) => m.ndcgAt10)),
    hitAt1: metrics.filter((m) => m.hitAt1).length,
    hitAt5: metrics.filter((m) => m.hitAt5).length,
    hitAt10: metrics.filter((m) => m.hitAt10).length,
    primaryFound: metrics.filter((m) => m.bestPrimaryRank !== null).length,
  };
}

// ---------------------------------------------------------------------------
// Running and reporting the comparison

export interface ModeResult {
  mode: SearchMode;
  runs: QuestionRun[];
  metrics: QuestionMetrics[];
}

export interface ComparisonMetadata {
  commit: string | null;
  baseUrl: string;
  evalFile: string;
  evalFileSha256: string;
  qrelsFile: string;
  qrelsSha256: string;
  embeddingModel: string;
  rrfK: number;
  hybridCandidateDepth: number;
}

/**
 * Runs every question through each mode (same questions, same endpoint, only
 * `mode` differs) and scores the results. Any failed search aborts the
 * comparison rather than producing partial metrics.
 */
export async function runModeComparison(
  questions: EvalQuestion[],
  judgments: Judgment[],
  searchForMode: (mode: SearchMode) => SearchFn,
  modes: SearchMode[]
): Promise<ModeResult[]> {
  const results: ModeResult[] = [];
  for (const mode of modes) {
    const runs = await runEvaluation(questions, searchForMode(mode), RESULT_DEPTH);
    const failed = runs.filter((run) => run.error);
    if (failed.length > 0) {
      throw new Error(
        `${mode}: ${failed.length} question(s) failed, e.g. Q${failed[0].question.number}: ${failed[0].error}`
      );
    }
    const metrics = runs.map((run) => computeQuestionMetrics(run.question.number, run.results, judgments));
    results.push({ mode, runs, metrics });
  }
  return results;
}

function groupByCategory(questions: EvalQuestion[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const q of questions) {
    const category = q.category ?? "Uncategorised";
    groups.set(category, [...(groups.get(category) ?? []), q.number]);
  }
  return groups;
}

/** Focus questions present in this question set. */
function focusQuestions(questions: EvalQuestion[]): number[] {
  return FOCUS_QUESTIONS.filter((number) => questions.some((q) => q.number === number));
}

/** Hash of a text file that ignores line-ending conversion (e.g. git autocrlf on Windows). */
export function textSha256(text: string): string {
  return sha256Hex(text.replace(/\r\n/g, "\n"));
}

function pick(metrics: QuestionMetrics[], numbers: number[]): QuestionMetrics[] {
  return metrics.filter((m) => numbers.includes(m.question));
}

/** Deterministic metrics document: no timestamps, stable key order, rounded values. */
export function buildMetricsJson(results: ModeResult[], questions: EvalQuestion[], metadata: ComparisonMetadata) {
  const categories = groupByCategory(questions);
  return {
    experiment: {
      commit: metadata.commit,
      evalFile: metadata.evalFile,
      evalFileSha256: metadata.evalFileSha256,
      qrelsFile: metadata.qrelsFile,
      qrelsSha256: metadata.qrelsSha256,
      embeddingModel: metadata.embeddingModel,
      rrfK: metadata.rrfK,
      hybridCandidateDepth: metadata.hybridCandidateDepth,
      resultDepth: RESULT_DEPTH,
      focusQuestions: focusQuestions(questions),
    },
    modes: Object.fromEntries(
      results.map((result) => [
        result.mode,
        {
          overall: aggregate(result.metrics),
          focus: aggregate(pick(result.metrics, focusQuestions(questions))),
          byCategory: Object.fromEntries(
            [...categories].map(([category, numbers]) => [category, aggregate(pick(result.metrics, numbers))])
          ),
          questions: result.metrics,
        },
      ])
    ),
  };
}

const rankCell = (rank: number | null) => (rank === null ? "—" : String(rank));
const fixed = (value: number) => value.toFixed(3);

function aggregateTable(rows: Array<[string, AggregateMetrics]>): string[] {
  return [
    "| Mode | MRR | nDCG@10 | Hit@1 | Hit@5 | Hit@10 | Primary found (top 50) |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...rows.map(
      ([mode, a]) =>
        `| ${mode} | ${fixed(a.mrr)} | ${fixed(a.meanNdcgAt10)} | ${a.hitAt1}/${a.questions} | ${a.hitAt5}/${a.questions} | ${a.hitAt10}/${a.questions} | ${a.primaryFound}/${a.questions} |`
    ),
  ];
}

function excerpt(text: string, words = 30): string {
  const all = text.trim().split(/\s+/);
  return escapeMarkdown(all.slice(0, words).join(" ") + (all.length > words ? " …" : ""));
}

export function renderComparisonReport(
  results: ModeResult[],
  questions: EvalQuestion[],
  metadata: ComparisonMetadata & { generatedAt: string }
): string {
  const modes = results.map((r) => r.mode);
  const focus = focusQuestions(questions);
  const metricFor = (mode: SearchMode, question: number) =>
    results.find((r) => r.mode === mode)!.metrics.find((m) => m.question === question)!;
  const countRange = (result: ModeResult) => {
    const counts = result.metrics.map((m) => m.resultCount);
    return `${Math.min(...counts)}–${Math.max(...counts)}`;
  };

  const lines = [
    "# Sage Retrieval Comparison",
    "",
    `- Generated: ${metadata.generatedAt}`,
    `- Commit: ${metadata.commit ?? "unknown"}`,
    `- Endpoint: \`GET ${metadata.baseUrl}/search?q=…&limit=${RESULT_DEPTH}&mode=…\``,
    `- Evaluation file: \`${metadata.evalFile}\` (sha256 ${metadata.evalFileSha256.slice(0, 12)}…)`,
    `- Judgments: \`${metadata.qrelsFile}\` (sha256 ${metadata.qrelsSha256.slice(0, 12)}…)`,
    `- Embedding model: \`${metadata.embeddingModel}\``,
    `- Hybrid: RRF k=${metadata.rrfK}, ${metadata.hybridCandidateDepth} candidates per retriever, equal weights`,
    `- Results returned per question: ${results.map((r) => `${r.mode} ${countRange(r)}`).join(", ")}`,
    "",
    "Relevance comes only from the frozen human judgments: grade 2 = primary evidence,",
    "grade 1 = secondary relevant evidence. Passages not in the judgments are **unjudged**",
    "(unknown), not irrelevant. Hit@k, MRR and \"primary found\" use grade-2 passages;",
    "nDCG@10 uses both grades (gain 2^grade − 1). Ranks are 1-based within the top 50; — = not in the top 50.",
    "",
    "## Overall",
    "",
    ...aggregateTable(results.map((r) => [r.mode, aggregate(r.metrics)])),
    "",
    `## Focus questions (${focus.map((q) => `Q${q}`).join(", ")})`,
    "",
    ...aggregateTable(results.map((r) => [r.mode, aggregate(pick(r.metrics, focus))])),
    "",
    "Best grade-2 rank / best relevant (grade 1 or 2) rank:",
    "",
    `| Question | ${modes.join(" | ")} |`,
    `|---|${modes.map(() => "---:").join("|")}|`,
    ...focus.map(
      (q) =>
        `| Q${q} | ${modes
          .map((mode) => {
            const m = metricFor(mode, q);
            return `${rankCell(m.bestPrimaryRank)} / ${rankCell(m.bestRelevantRank)}`;
          })
          .join(" | ")} |`
    ),
    "",
    "## By category",
    "",
  ];

  for (const [category, numbers] of groupByCategory(questions)) {
    lines.push(
      `### ${escapeMarkdown(category)}`,
      "",
      ...aggregateTable(results.map((r) => [r.mode, aggregate(pick(r.metrics, numbers))])),
      ""
    );
  }

  lines.push(
    "## Per question",
    "",
    "Best grade-2 rank / best relevant rank / nDCG@10:",
    "",
    `| Question | ${modes.join(" | ")} |`,
    `|---|${modes.map(() => "---:").join("|")}|`,
    ...questions.map(
      (q) =>
        `| Q${q.number} | ${modes
          .map((mode) => {
            const m = metricFor(mode, q.number);
            return `${rankCell(m.bestPrimaryRank)} / ${rankCell(m.bestRelevantRank)} / ${fixed(m.ndcgAt10)}`;
          })
          .join(" | ")} |`
    ),
    "",
    "## Judged passages by rank",
    ""
  );

  for (const q of questions) {
    const judged = metricFor(modes[0], q.number).judged;
    lines.push(
      `### Q${q.number}`,
      "",
      `| Passage | Grade | ${modes.join(" | ")} |`,
      `|---|---:|${modes.map(() => "---:").join("|")}|`,
      ...judged.map(
        (j) =>
          `| ${escapeMarkdown(passageKey(j.sourceTitle, j.ordinal))} | ${j.grade} | ${modes
            .map((mode) =>
              rankCell(
                metricFor(mode, q.number).judged.find((x) => x.sourceTitle === j.sourceTitle && x.ordinal === j.ordinal)!.rank
              )
            )
            .join(" | ")} |`
      ),
      ""
    );
  }

  lines.push(
    "## Unjudged passages in the top 5",
    "",
    "These need a human relevance judgment; they are not counted as relevant or irrelevant.",
    ""
  );
  let anyUnjudged = false;
  for (const q of questions) {
    for (const result of results) {
      const m = metricFor(result.mode, q.number);
      if (m.unjudgedTop5.length === 0) continue;
      anyUnjudged = true;
      const run = result.runs.find((r) => r.question.number === q.number)!;
      lines.push(`- **Q${q.number} · ${result.mode}**`);
      for (const u of m.unjudgedTop5) {
        lines.push(`  - rank ${u.rank}: ${escapeMarkdown(passageKey(u.sourceTitle, u.ordinal))} — ${excerpt(run.results[u.rank - 1].passage.text)}`);
      }
    }
  }
  if (!anyUnjudged) lines.push("_None._");
  lines.push("");
  return lines.join("\n");
}
