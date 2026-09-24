import "dotenv/config";
import { pool } from "../src/db/pool";
import { embedMissingPassages } from "../src/embeddings/backfill";
import { getEmbedder } from "../src/embeddings/embedder";

/**
 * Backfills passage embeddings for the configured model (npm run embed).
 * Safe to re-run: only missing or stale embeddings are computed.
 */
async function main() {
  const embedder = getEmbedder();
  console.log(`Embedding passages with ${embedder.modelId} (${embedder.dimensions} dimensions)`);

  const summary = await embedMissingPassages(embedder, (done, total) => {
    process.stdout.write(`\r  ${done}/${total} passages embedded`);
  });
  if (summary.embedded + summary.refreshed > 0) process.stdout.write("\n");

  const covered = summary.embedded + summary.refreshed + summary.unchanged;
  console.log(
    `Done: ${summary.embedded} new, ${summary.refreshed} refreshed, ${summary.unchanged} unchanged; ` +
      `coverage ${covered}/${summary.eligible} ready passages`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
