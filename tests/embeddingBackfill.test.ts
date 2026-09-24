import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool";
import { embedMissingPassages, sha256 } from "../src/embeddings/backfill";
import { ingestText } from "../src/ingestion/ingestionService";
import { createFakeEmbedder, FAKE_DIMENSIONS } from "./helpers/fakeEmbedder";

beforeEach(async () => {
  await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function ingest(rawText: string, suggestedTitle = "Meditations") {
  return ingestText({
    rawText,
    suggestedTitle,
    sourceType: "book",
    personName: "Marcus Aurelius",
    ingestionMethod: "text_upload",
  });
}

async function embeddingRows(model?: string) {
  const result = await pool.query<{ passage_id: string; model: string; dimensions: number; embedding: number[]; text_sha256: string; created_at: Date }>(
    `SELECT passage_id, model, dimensions, embedding, text_sha256, created_at FROM passage_embeddings
     ${model ? "WHERE model = $1" : ""} ORDER BY passage_id`,
    model ? [model] : []
  );
  return result.rows;
}

const twoParagraphs = `${"alpha ".repeat(400).trim()}\n\n${"beta ".repeat(400).trim()}`;

describe("embedMissingPassages", () => {
  it("embeds every passage of ready documents as documents", async () => {
    const doc = await ingest(twoParagraphs);
    const embedder = createFakeEmbedder();

    const summary = await embedMissingPassages(embedder);

    expect(summary).toEqual({ model: "fake-test@1", eligible: 2, embedded: 2, refreshed: 0, unchanged: 0 });
    const rows = await embeddingRows();
    expect(rows.map((r) => r.passage_id).sort()).toEqual(doc.passages.map((p) => p.id).sort());
    for (const row of rows) {
      const passage = doc.passages.find((p) => p.id === row.passage_id)!;
      expect(row.model).toBe("fake-test@1");
      expect(row.dimensions).toBe(FAKE_DIMENSIONS);
      expect(row.embedding).toHaveLength(FAKE_DIMENSIONS);
      expect(row.text_sha256).toBe(sha256(passage.text));
      const expected = embedder.vector(passage.text);
      row.embedding.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
    }
    expect(embedder.calls.every((call) => call.kind === "document")).toBe(true);
  });

  it("is idempotent: a second run embeds nothing and leaves rows untouched", async () => {
    await ingest(twoParagraphs);
    const embedder = createFakeEmbedder();
    await embedMissingPassages(embedder);
    const before = await embeddingRows();

    const summary = await embedMissingPassages(embedder);

    expect(summary).toMatchObject({ eligible: 2, embedded: 0, refreshed: 0, unchanged: 2 });
    expect(await embeddingRows()).toEqual(before);
    expect(embedder.calls).toHaveLength(2);
  });

  it("re-embeds a passage whose text changed since it was embedded", async () => {
    const doc = await ingest("Courage is the first of the virtues.");
    const embedder = createFakeEmbedder();
    await embedMissingPassages(embedder);

    await pool.query(`UPDATE passages SET text = 'Patience is the first of the virtues.' WHERE id = $1`, [doc.passages[0].id]);
    const summary = await embedMissingPassages(embedder);

    expect(summary).toMatchObject({ embedded: 0, refreshed: 1, unchanged: 0 });
    const [row] = await embeddingRows();
    expect(row.text_sha256).toBe(sha256("Patience is the first of the virtues."));
  });

  it("skips passages of documents that are not ready", async () => {
    await ingest("Courage in the ready document.");
    const failed = await ingest("Courage in the failed document.", "Letters");
    await pool.query(`UPDATE documents SET status = 'failed' WHERE id = $1`, [failed.document.id]);

    const summary = await embedMissingPassages(createFakeEmbedder());

    expect(summary).toMatchObject({ eligible: 1, embedded: 1 });
    expect((await embeddingRows()).map((r) => r.passage_id)).not.toContain(failed.passages[0].id);
  });

  it("keeps embeddings for different models separate", async () => {
    await ingest("Courage is the first of the virtues.");
    await embedMissingPassages(createFakeEmbedder("model-a"));

    const summary = await embedMissingPassages(createFakeEmbedder("model-b"));

    expect(summary).toMatchObject({ embedded: 1, unchanged: 0 });
    expect(await embeddingRows("model-a")).toHaveLength(1);
    expect(await embeddingRows("model-b")).toHaveLength(1);
  });

  it("rejects an embedder that returns the wrong number of dimensions", async () => {
    await ingest("Courage is the first of the virtues.");
    const broken = { ...createFakeEmbedder(), embedDocument: async () => [1, 0, 0] };

    await expect(embedMissingPassages(broken)).rejects.toThrow(/expected 768 dimensions, got 3/);
    expect(await embeddingRows()).toEqual([]);
  });

  it("enforces that the stored array length matches its dimensions", async () => {
    const doc = await ingest("Courage is the first of the virtues.");
    await expect(
      pool.query(
        `INSERT INTO passage_embeddings (passage_id, model, dimensions, embedding, text_sha256) VALUES ($1, 'm', 768, $2::real[], 'x')`,
        [doc.passages[0].id, [0.1, 0.2, 0.3]]
      )
    ).rejects.toThrow(/check constraint/);
  });

  it("removes embeddings when their passage is deleted", async () => {
    const doc = await ingest("Courage is the first of the virtues.");
    await embedMissingPassages(createFakeEmbedder());

    await pool.query(`DELETE FROM documents WHERE id = $1`, [doc.document.id]);

    expect(await embeddingRows()).toEqual([]);
  });
});
