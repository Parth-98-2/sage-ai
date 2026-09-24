import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { NOMIC_MODEL_ID } from "../../src/embeddings/nomicEmbedder";
import { HYBRID_CANDIDATE_DEPTH, RRF_K } from "../../src/retrieval/hybrid";
import { SEARCH_MODES, type SearchMode } from "../../src/retrieval/types";
import {
  aggregate,
  buildMetricsJson,
  FOCUS_QUESTIONS,
  parseQrels,
  RESULT_DEPTH,
  renderComparisonReport,
  runModeComparison,
  sha256Hex,
  textSha256,
} from "./metrics";
import {
  createHttpSearchClient,
  EVAL_RESULT_LIMIT,
  parseEvalFile,
  renderMarkdownReport,
  runEvaluation,
  type EvalQuestion,
} from "./retrievalEval";

/**
 * Runs the retrieval evaluation set against a running Sage server.
 *
 * Lexical-only report (original behaviour):
 *   npx tsx scripts/evaluation/runRetrievalEval.ts [--eval <file>] [--base-url <url>] [--out <file>]
 *
 * Comparison scored against the frozen judgments:
 *   npx tsx scripts/evaluation/runRetrievalEval.ts --modes lexical,semantic,hybrid [--out-dir <dir>] [--qrels <file>]
 */

const DEFAULT_EVAL_FILE = "corpus/retrieval-eval.md";
const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_OUT_FILE = "corpus/retrieval-eval-report.md";
const DEFAULT_QRELS_FILE = "scripts/evaluation/retrieval-qrels.json";

/** Windows can hide a trailing .txt, so fall back to `<file>.txt` if needed. */
function resolveEvalFile(file: string): string {
  if (fs.existsSync(file)) return file;
  if (fs.existsSync(`${file}.txt`)) return `${file}.txt`;
  throw new Error(`evaluation file not found: ${file}`);
}

function currentCommit(): string | null {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf-8" }).trim();
    return dirty ? `${commit} (with uncommitted changes)` : commit;
  } catch {
    return null;
  }
}

function parseModes(value: string): SearchMode[] {
  const modes = value.split(",").map((mode) => mode.trim()).filter(Boolean);
  for (const mode of modes) {
    if (!(SEARCH_MODES as readonly string[]).includes(mode)) {
      throw new Error(`unknown mode "${mode}"; expected one of: ${SEARCH_MODES.join(", ")}`);
    }
  }
  if (modes.length === 0 || new Set(modes).size !== modes.length) throw new Error("--modes must list distinct modes");
  return modes as SearchMode[];
}

async function checkServer(baseUrl: string) {
  try {
    const health = await fetch(new URL("/health", baseUrl));
    if (!health.ok) throw new Error(`status ${health.status}`);
  } catch (err) {
    throw new Error(`Sage server is not reachable at ${baseUrl} (${(err as Error).message}). Start it with: npm run dev`);
  }
}

async function runLexicalReport(questions: EvalQuestion[], evalFile: string, baseUrl: string, outFile: string) {
  const runs = await runEvaluation(questions, createHttpSearchClient(baseUrl));
  const report = renderMarkdownReport(runs, {
    generatedAt: new Date().toISOString(),
    baseUrl,
    evalFile,
    commit: currentCommit(),
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, report, "utf-8");

  for (const run of runs) {
    const status = run.error ? `ERROR: ${run.error}` : `${run.results.length} results`;
    console.log(`Q${run.question.number}: ${status}`);
  }
  console.log(`Report written to ${outFile}`);
  if (runs.some((run) => run.error)) process.exitCode = 1;
}

async function runComparison(
  questions: EvalQuestion[],
  evalFile: string,
  baseUrl: string,
  modes: SearchMode[],
  qrelsFile: string,
  outDir: string
) {
  const qrelsText = fs.readFileSync(qrelsFile, "utf-8");
  const qrels = parseQrels(qrelsText, questions.map((q) => q.number));
  const evalFileSha256 = sha256Hex(fs.readFileSync(evalFile));
  if (qrels.evalFileSha256 !== evalFileSha256) {
    throw new Error(`${evalFile} has changed since the judgments were frozen (sha256 mismatch); refusing to score`);
  }

  const results = await runModeComparison(questions, qrels.judgments, (mode) => createHttpSearchClient(baseUrl, mode), modes);
  const generatedAt = new Date().toISOString();
  const metadata = {
    commit: currentCommit(),
    baseUrl,
    evalFile,
    evalFileSha256,
    qrelsFile: qrelsFile.replace(/\\/g, "/"),
    qrelsSha256: textSha256(qrelsText),
    embeddingModel: NOMIC_MODEL_ID,
    rrfK: RRF_K,
    hybridCandidateDepth: HYBRID_CANDIDATE_DEPTH,
  };

  fs.mkdirSync(outDir, { recursive: true });
  for (const result of results) {
    const shownRuns = result.runs.map((run) => ({ ...run, results: run.results.slice(0, EVAL_RESULT_LIMIT) }));
    const report = renderMarkdownReport(shownRuns, {
      generatedAt,
      baseUrl,
      evalFile,
      commit: metadata.commit,
      mode: result.mode,
      requestLimit: RESULT_DEPTH,
    });
    fs.writeFileSync(path.join(outDir, `report-${result.mode}.md`), report, "utf-8");
  }
  fs.writeFileSync(path.join(outDir, "comparison.md"), renderComparisonReport(results, questions, { ...metadata, generatedAt }), "utf-8");
  fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(buildMetricsJson(results, questions, metadata), null, 2) + "\n", "utf-8");

  for (const result of results) {
    const overall = aggregate(result.metrics);
    const focus = result.metrics.filter((m) => FOCUS_QUESTIONS.includes(m.question));
    console.log(
      `${result.mode.padEnd(8)} MRR ${overall.mrr.toFixed(3)}  hit@10 ${overall.hitAt10}/${overall.questions}  ` +
        `focus best ranks: ${focus.map((m) => `Q${m.question}=${m.bestPrimaryRank ?? "—"}`).join(" ")}`
    );
  }
  console.log(`Comparison written to ${outDir}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      eval: { type: "string", default: DEFAULT_EVAL_FILE },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      out: { type: "string", default: DEFAULT_OUT_FILE },
      modes: { type: "string" },
      qrels: { type: "string", default: DEFAULT_QRELS_FILE },
      "out-dir": { type: "string" },
    },
  });
  const evalFile = resolveEvalFile(values.eval).replace(/\\/g, "/");
  const baseUrl = values["base-url"].replace(/\/+$/, "");

  const questions = parseEvalFile(fs.readFileSync(evalFile, "utf-8"));
  console.log(`Parsed ${questions.length} questions from ${evalFile}`);
  await checkServer(baseUrl);

  if (values.modes === undefined) {
    await runLexicalReport(questions, evalFile, baseUrl, values.out);
    return;
  }
  const outDir = values["out-dir"] ?? path.join("eval-output", new Date().toISOString().replace(/[:.]/g, "-"));
  await runComparison(questions, evalFile, baseUrl, parseModes(values.modes), values.qrels, outDir);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
