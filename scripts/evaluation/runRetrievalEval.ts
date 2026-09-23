import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createHttpSearchClient,
  parseEvalFile,
  renderMarkdownReport,
  runEvaluation,
} from "./retrievalEval";

/**
 * Runs the retrieval evaluation set against a running Sage server and writes
 * a Markdown report for human review.
 *
 *   npx tsx scripts/evaluation/runRetrievalEval.ts [--eval <file>] [--base-url <url>] [--out <file>]
 */

const DEFAULT_EVAL_FILE = "corpus/retrieval-eval.md";
const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_OUT_FILE = "corpus/retrieval-eval-report.md";

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

async function main() {
  const { values } = parseArgs({
    options: {
      eval: { type: "string", default: DEFAULT_EVAL_FILE },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      out: { type: "string", default: DEFAULT_OUT_FILE },
    },
  });
  const evalFile = resolveEvalFile(values.eval);
  const baseUrl = values["base-url"].replace(/\/+$/, "");
  const outFile = values.out;

  const questions = parseEvalFile(fs.readFileSync(evalFile, "utf-8"));
  console.log(`Parsed ${questions.length} questions from ${evalFile}`);

  try {
    const health = await fetch(new URL("/health", baseUrl));
    if (!health.ok) throw new Error(`status ${health.status}`);
  } catch (err) {
    throw new Error(`Sage server is not reachable at ${baseUrl} (${(err as Error).message}). Start it with: npm run dev`);
  }

  const runs = await runEvaluation(questions, createHttpSearchClient(baseUrl));
  const report = renderMarkdownReport(runs, {
    generatedAt: new Date().toISOString(),
    baseUrl,
    evalFile: evalFile.replace(/\\/g, "/"),
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

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
