import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { answerQuestion } from "../src/answering/answerService";
import { MAX_ANSWER_LIMIT } from "../src/answering/types";
import { pool } from "../src/db/pool";
import { embedMissingPassages } from "../src/embeddings/backfill";
import { getEmbedder } from "../src/embeddings/embedder";
import { ingestText, ingestTranscript } from "../src/ingestion/ingestionService";
import { decodeUtf8Strict, normalizeText } from "../src/ingestion/textNormalization";
import { DEFAULT_SPONSORS, planTranscript, type RemovedRange } from "../src/ingestion/transcript";
import { ALLOWED_PERSON_ROLES, ALLOWED_SOURCE_TYPES } from "../src/ingestion/types";

/**
 * Local Sage session (npm run sage): add transcripts and ask questions in one
 * terminal. Uses the same ingestion, embedding and answering code as the HTTP
 * API; no server needs to be running, only Postgres and the configured model.
 *
 * One non-interactive command: npm run sage -- ingest-transcript <file> [options]
 * (see INGEST_TRANSCRIPT_USAGE).
 */

const HELP = `Commands:
  /add <file.txt|file.md>   add a source (prompts for title, type, person and role)
  /limit <N>                passages retrieved per question (1-${MAX_ANSWER_LIMIT})
  /help                     show this help
  /quit                     exit
Anything else is a question for Sage.`;

const EXCERPT_CHARS = 160;
/** Passages retrieved per question unless changed with /limit; the same as /answer's default. */
export const DEFAULT_SESSION_LIMIT = 10;

/** The /limit argument as a retrieval limit /answer accepts, or null if it is not one. */
export function parseLimit(arg: string): number | null {
  if (!/^\d+$/.test(arg)) return null;
  const limit = Number(arg);
  return limit >= 1 && limit <= MAX_ANSWER_LIMIT ? limit : null;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

async function ask(rl: readline.Interface, label: string, fallback?: string): Promise<string> {
  const answer = (await rl.question(fallback ? `  ${label} [${fallback}]: ` : `  ${label}: `)).trim();
  return answer || fallback || "";
}

async function addSource(rl: readline.Interface, rawPath: string): Promise<void> {
  const filePath = path.resolve(rawPath.replace(/^["']|["']$/g, ""));
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".txt" && extension !== ".md") throw new Error("only .txt and .md files are supported");
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);

  const title = await ask(rl, "Title", path.basename(filePath, extension));
  const sourceType = await ask(rl, `Source type (${ALLOWED_SOURCE_TYPES.join(", ")})`, "other");
  const personName = await ask(rl, "Person name");
  const personRole = await ask(rl, `Person role (${ALLOWED_PERSON_ROLES.join(", ")})`, "author");

  const result = await ingestText({
    rawText: decodeUtf8Strict(fs.readFileSync(filePath)),
    suggestedTitle: title,
    sourceType,
    personName,
    personRole,
    ingestionMethod: "text_upload",
    originalFilename: path.basename(filePath),
    mimeType: extension === ".md" ? "text/markdown" : "text/plain",
  });
  console.log(
    result.duplicate
      ? `Already added: "${result.source.title}" (document ${result.document.id}).`
      : `Added "${result.source.title}": ${result.passages.length} passages (source ${result.source.id}, document ${result.document.id}).`
  );

  // /answer uses hybrid retrieval, so passages must be embedded before semantic search can find them.
  const summary = await embedMissingPassages(getEmbedder(), (done, total) => process.stdout.write(`\r  Embedding ${done}/${total}`));
  if (summary.embedded + summary.refreshed > 0) process.stdout.write("\n");
  console.log(`Ready to answer from it (${summary.embedded + summary.refreshed} passages embedded).`);
}

async function answer(question: string, limit: number): Promise<void> {
  console.log("Thinking… (a local model can take a few minutes)");
  const started = Date.now();
  const res = await answerQuestion({ question, limit });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${res.answer}\n`);
  if (res.citations.length > 0) {
    console.log("Sources:");
    for (const c of res.citations) {
      console.log(`  [${c.number}] ${c.source.title}, passage ${c.passage.ordinal}: "${excerpt(c.passage.text)}"`);
    }
  }
  console.log(`\n(${res.status}, ${res.model ?? "no model call"}, ${seconds}s)`);
}

export const INGEST_TRANSCRIPT_USAGE = `Usage: npm run sage -- ingest-transcript <file.txt> [options]
  --title <title>         source title (default: the file name)
  --host <name>           the podcast host, recorded as role "host" (default: David Senra)
  --subject <name>        a person the episode is about, recorded as role "subject" (repeatable)
  --sponsor <name>        a sponsor whose reads to remove, added to ${DEFAULT_SPONSORS.join(", ")} (repeatable)
  --url <url>             the episode's URL
  --published <date>      the episode's date, YYYY-MM-DD
  --dry-run               show what would be removed and how many passages would be stored; write nothing`;

function describeRemoved(text: string, removed: RemovedRange[]): string {
  if (removed.length === 0) return "  Removed: nothing";
  return removed
    .map(({ start, end, reason }) => {
      const flat = text.slice(start, end).replace(/\s+/g, " ").trim();
      return `  Removed ${reason} (${end - start} chars): "${flat.slice(0, 60)} … ${flat.slice(-50)}"`;
    })
    .join("\n");
}

/** npm run sage -- ingest-transcript <file> [options]: stores a transcript (see ingestTranscript) and embeds its passages. */
export async function ingestTranscriptCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: "string" },
      host: { type: "string", default: "David Senra" },
      subject: { type: "string", multiple: true, default: [] },
      sponsor: { type: "string", multiple: true, default: [] },
      url: { type: "string" },
      published: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1) throw new Error(INGEST_TRANSCRIPT_USAGE);

  const filePath = path.resolve(positionals[0]);
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".txt" && extension !== ".md") throw new Error("only .txt and .md files are supported");
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);

  const rawText = decodeUtf8Strict(fs.readFileSync(filePath));
  const sponsors = [...DEFAULT_SPONSORS, ...values.sponsor];
  const title = values.title ?? path.basename(filePath, extension);

  if (values["dry-run"]) {
    const text = normalizeText(rawText);
    const plan = planTranscript(text, sponsors);
    console.log(`Dry run for "${title}": ${plan.markers.length} timestamps, ${plan.passages.length} passages would be stored.`);
    console.log(describeRemoved(text, plan.removed));
    return;
  }

  const result = await ingestTranscript({
    rawText,
    suggestedTitle: title,
    sourceType: "podcast",
    personName: values.host,
    personRole: "host",
    additionalPeople: values.subject.map((name) => ({ name, role: "subject" })),
    sponsors,
    externalUrl: values.url,
    publishedAt: values.published,
    ingestionMethod: "text_upload",
    originalFilename: path.basename(filePath),
    mimeType: extension === ".md" ? "text/markdown" : "text/plain",
  });
  console.log(
    result.duplicate
      ? `Already ingested: "${result.source.title}" (source ${result.source.id}, document ${result.document.id}, ${result.passages.length} passages). Nothing new was stored.`
      : `Ingested "${result.source.title}": ${result.passages.length} passages (source ${result.source.id}, document ${result.document.id}).`
  );
  if (result.duplicate && result.source.title !== title) {
    console.log(`  This transcript is already stored under "${result.source.title}"; the title "${title}" and people given now were not applied.`);
  }
  console.log(describeRemoved(result.document.raw_text, result.removed));

  const summary = await embedMissingPassages(getEmbedder(), (done, total) => process.stdout.write(`\r  Embedding ${done}/${total}`));
  if (summary.embedded + summary.refreshed > 0) process.stdout.write("\n");
  console.log(`Searchable: ${summary.embedded + summary.refreshed} passages embedded now.`);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let limit = DEFAULT_SESSION_LIMIT;
  console.log(`Sage (local). ${HELP}\nRetrieval limit: ${limit} passages.\n`);
  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question("sage> ")).trim();
      } catch {
        break; // input closed (Ctrl+C / Ctrl+D)
      }
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      try {
        if (line === "/help") console.log(HELP);
        else if (line === "/limit" || line.startsWith("/limit ")) {
          const next = parseLimit(line.slice(6).trim());
          if (next === null) console.log(`Usage: /limit <N>, where N is 1-${MAX_ANSWER_LIMIT} (currently ${limit})`);
          else console.log(`Retrieval limit: ${(limit = next)} passages.`);
        } else if (line === "/add" || line.startsWith("/add ")) {
          const file = line.slice(4).trim();
          if (!file) console.log("Usage: /add <file.txt|file.md>");
          else await addSource(rl, file);
        } else await answer(line, limit);
      } catch (err) {
        console.log(`Error: ${(err as Error).message || (err as Error).name}`);
      }
      console.log();
    }
  } finally {
    rl.close();
    await pool.end();
  }
}

// Run only when executed directly, so tests can import from this file.
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) main();
  else if (command === "ingest-transcript") {
    ingestTranscriptCommand(args)
      .catch((err) => {
        console.error((err as Error).message || err);
        process.exitCode = 1;
      })
      .finally(() => pool.end());
  } else {
    console.error(`Unknown command: ${command}\n${INGEST_TRANSCRIPT_USAGE}`);
    process.exitCode = 1;
    pool.end();
  }
}
