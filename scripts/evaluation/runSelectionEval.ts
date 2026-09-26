import fs from "node:fs";
import { parseArgs } from "node:util";
import { selectEvidence } from "../../src/answering/evidenceSelection";
import { buildAnswerPrompt, buildEvidence } from "../../src/answering/prompt";
import { ANSWER_EVIDENCE_COUNT, DEFAULT_ANSWER_LIMIT } from "../../src/answering/types";
import { pool } from "../../src/db/pool";
import { searchPassages } from "../../src/retrieval/retrievalService";
import type { SearchResult } from "../../src/retrieval/types";
import type { Judgment, QrelsFile } from "./metrics";
import { parseEvalFile } from "./retrievalEval";

/**
 * Compares evidence selection with the plain hybrid top k on the retrieval
 * evaluation set, against the database directly (no server needed):
 *
 *   npx tsx scripts/evaluation/runSelectionEval.ts [--eval <file>] [--qrels <file>]
 *
 * The frozen judgments name passages of an earlier ingestion by source title
 * and ordinal, so each judgment is matched to the current corpus by its quoted
 * evidence instead: a candidate is judged when its text contains the quote.
 * Quotes found in no candidate are reported as unmatched, not as misses.
 */

const { values } = parseArgs({
  options: {
    eval: { type: "string", default: "corpus/retrieval-eval.md.txt" },
    qrels: { type: "string", default: "scripts/evaluation/retrieval-qrels.json" },
  },
});

const normalize = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

interface Arm {
  name: string;
  select: (question: string, candidates: SearchResult[]) => SearchResult[];
}

const ARMS: Arm[] = [
  { name: `hybrid top ${ANSWER_EVIDENCE_COUNT}`, select: (_, candidates) => candidates.slice(0, ANSWER_EVIDENCE_COUNT) },
  { name: "selectEvidence", select: (question, candidates) => selectEvidence(question, candidates, ANSWER_EVIDENCE_COUNT) },
];

/** 1-based position of the first selected passage whose text contains one of `quotes`, or null. */
function firstMatch(selected: SearchResult[], quotes: string[]): number | null {
  const index = selected.findIndex((result) => quotes.some((quote) => normalize(result.passage.text).includes(quote)));
  return index < 0 ? null : index + 1;
}

const label = (result: SearchResult) => `${result.source.title} #${result.passage.ordinal}`;

async function main() {
  const questions = parseEvalFile(fs.readFileSync(values.eval!, "utf-8"));
  const judgments = (JSON.parse(fs.readFileSync(values.qrels!, "utf-8")) as QrelsFile).judgments;
  const quotesFor = (question: number, grades: Judgment["grade"][]) =>
    judgments.filter((j) => j.question === question && grades.includes(j.grade)).map((j) => normalize(j.evidence));

  const totals = ARMS.map(() => ({ main: 0, any: 0, sent: 0, promptChars: 0 }));
  const rows: string[] = [];
  let unmatched = 0;
  let q1 = "";

  for (const { number, question } of questions) {
    const { results } = await searchPassages({ q: question, limit: String(DEFAULT_ANSWER_LIMIT), mode: "hybrid" });
    const main = quotesFor(number, [2]);
    const any = quotesFor(number, [1, 2]);
    unmatched += any.filter((quote) => !results.some((r) => normalize(r.passage.text).includes(quote))).length;

    const cells = ARMS.map((arm, i) => {
      const selected = arm.select(question, results);
      const mainAt = firstMatch(selected, main);
      const anyAt = firstMatch(selected, any);
      totals[i].main += mainAt ? 1 : 0;
      totals[i].any += anyAt ? 1 : 0;
      totals[i].sent += selected.length;
      totals[i].promptChars += buildAnswerPrompt(question, buildEvidence(selected)).prompt.length;
      if (number === 1) {
        q1 += `\n${arm.name}:\n${selected.map((r) => `  ${results.indexOf(r) + 1}. ${label(r)}${main.some((q) => normalize(r.passage.text).includes(q)) ? "  <- main" : ""}`).join("\n")}`;
      }
      return `${mainAt ?? "—"} / ${anyAt ?? "—"}`;
    });
    const mainRank = firstMatch(results, main);
    rows.push(`| Q${number} | ${results.length} | ${mainRank ?? "—"} | ${cells.join(" | ")} |`);
  }

  const n = questions.length;
  console.log(`# Evidence selection evaluation\n`);
  console.log(`Candidates: hybrid top ${DEFAULT_ANSWER_LIMIT}. Passages sent: ${ANSWER_EVIDENCE_COUNT}. Questions: ${n}.`);
  console.log(`Judged quotes found in no candidate (unmatched, not counted as misses): ${unmatched} of ${judgments.length}.\n`);
  console.log(`Cells: position of the first main (grade 2) / any relevant passage in the selected set; — = not selected.\n`);
  console.log(`| Q | Candidates | Main rank in candidates | ${ARMS.map((a) => a.name).join(" | ")} |`);
  console.log(`|---|---:|---:|${ARMS.map(() => "---:").join("|")}|`);
  rows.forEach((row) => console.log(row));
  console.log(`\n| Arm | Main passage selected | Any relevant selected | Mean passages sent | Mean prompt chars |`);
  console.log(`|---|---:|---:|---:|---:|`);
  ARMS.forEach((arm, i) => {
    const t = totals[i];
    console.log(`| ${arm.name} | ${t.main}/${n} | ${t.any}/${n} | ${(t.sent / n).toFixed(1)} | ${Math.round(t.promptChars / n)} |`);
  });
  console.log(`\nQ1 selected passages (candidate rank. source #ordinal):${q1}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
