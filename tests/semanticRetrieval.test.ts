import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/db/pool";
import { embedMissingPassages } from "../src/embeddings/backfill";
import { setEmbedder } from "../src/embeddings/embedder";
import { ingestText } from "../src/ingestion/ingestionService";
import { createFakeEmbedder, dot, type FakeEmbedder } from "./helpers/fakeEmbedder";

// The fake embedder is a deterministic bag-of-words stand-in: these tests
// check the retrieval mechanics (ranking by dot product, filters, provenance),
// not the quality of real semantic retrieval.

const app = createApp();
let embedder: FakeEmbedder;

beforeAll(() => {
  embedder = createFakeEmbedder();
  setEmbedder(embedder);
});

beforeEach(async () => {
  await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
  embedder.calls.length = 0;
});

afterAll(async () => {
  setEmbedder(null);
  await pool.end();
});

function ingest(rawText: string, overrides: Partial<Parameters<typeof ingestText>[0]> = {}) {
  return ingestText({
    rawText,
    suggestedTitle: "Meditations",
    sourceType: "book",
    personName: "Marcus Aurelius",
    personRole: "author",
    ingestionMethod: "text_upload",
    originalFilename: "meditations.txt",
    ...overrides,
  });
}

function semantic(query: Record<string, string>) {
  return request(app).get("/search").query({ mode: "semantic", ...query });
}

describe("GET /search?mode=semantic ranking", () => {
  it("ranks passages by the dot product of the query and passage embeddings", async () => {
    await ingest("courage soldier battle courage", { suggestedTitle: "A" });
    await ingest("courage garden flowers water", { suggestedTitle: "B" });
    await ingest("garden flowers water sunlight", { suggestedTitle: "C" });
    await embedMissingPassages(embedder);

    const res = await semantic({ q: "courage soldier" });

    expect(res.status).toBe(200);
    const titles = res.body.results.map((r: { source: { title: string } }) => r.source.title);
    expect(titles).toEqual(["A", "B", "C"]);
    const queryVector = embedder.vector("courage soldier");
    for (const result of res.body.results) {
      expect(result.score).toBeCloseTo(dot(queryVector, embedder.vector(result.passage.text)), 5);
    }
    expect(embedder.calls.filter((c) => c.kind === "query")).toEqual([{ kind: "query", text: "courage soldier" }]);
  });

  it("breaks score ties by passage id ascending", async () => {
    await ingest("stillness judgement", { suggestedTitle: "A" });
    await ingest("stillness judgement", { suggestedTitle: "B" });
    await ingest("stillness judgement", { suggestedTitle: "C" });
    await embedMissingPassages(embedder);

    const res = await semantic({ q: "stillness" });

    const ids = res.body.results.map((r: { passage: { id: string } }) => r.passage.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual([...ids].sort());
  });

  it("returns results for a stopword-only query, unlike lexical search", async () => {
    await ingest("What is it that we fear?");
    await embedMissingPassages(embedder);

    expect((await semantic({ q: "what is it?" })).body.results).toHaveLength(1);
    expect((await request(app).get("/search").query({ q: "what is it?" })).body.results).toEqual([]);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 4; i++) await ingest(`note ${i} courage`, { suggestedTitle: `T${i}` });
    await embedMissingPassages(embedder);

    expect((await semantic({ q: "courage", limit: "2" })).body.results).toHaveLength(2);
  });
});

describe("GET /search?mode=semantic coverage", () => {
  it("does not search passages that have no embedding for the current model", async () => {
    await ingest("courage embedded", { suggestedTitle: "A" });
    await embedMissingPassages(embedder);
    await ingest("courage not embedded", { suggestedTitle: "B" });

    const res = await semantic({ q: "courage" });

    expect(res.body.results.map((r: { source: { title: string } }) => r.source.title)).toEqual(["A"]);
  });

  it("ignores embeddings stored for a different model", async () => {
    await ingest("courage");
    await embedMissingPassages(createFakeEmbedder("other-model"));

    expect((await semantic({ q: "courage" })).body.results).toEqual([]);
  });

  it("excludes passages from documents that are not ready", async () => {
    const ready = await ingest("courage ready", { suggestedTitle: "A" });
    await ingest("courage failed", { suggestedTitle: "B" });
    await embedMissingPassages(embedder);
    await pool.query(`UPDATE documents SET status = 'failed' WHERE source_id <> $1`, [ready.source.id]);

    const res = await semantic({ q: "courage" });

    expect(res.body.results.map((r: { document: { id: string } }) => r.document.id)).toEqual([ready.document.id]);
  });
});

describe("GET /search?mode=semantic filters and provenance", () => {
  async function seedTwoPeople() {
    const marcus = await ingest("courage is the first virtue");
    const seneca = await ingest("courage leads to the stars", {
      suggestedTitle: "Letters",
      sourceType: "essay",
      personName: "Seneca",
    });
    await embedMissingPassages(embedder);
    return { marcus, seneca };
  }

  it("filters by personId and sourceId", async () => {
    const { marcus, seneca } = await seedTwoPeople();

    const byPerson = await semantic({ q: "courage", personId: seneca.person.id });
    expect(byPerson.body.results.map((r: { source: { id: string } }) => r.source.id)).toEqual([seneca.source.id]);

    const bySource = await semantic({ q: "courage", sourceId: marcus.source.id });
    expect(bySource.body.results.map((r: { source: { id: string } }) => r.source.id)).toEqual([marcus.source.id]);

    const both = await semantic({ q: "courage", personId: seneca.person.id, sourceId: marcus.source.id });
    expect(both.body.results).toEqual([]);
  });

  it("returns the same provenance as lexical search for the same passage", async () => {
    await seedTwoPeople();

    const lexical = await request(app).get("/search").query({ q: "stars" });
    const semanticRes = await semantic({ q: "stars" });
    const lexicalHit = lexical.body.results[0];
    const semanticHit = semanticRes.body.results.find(
      (r: { passage: { id: string } }) => r.passage.id === lexicalHit.passage.id
    );

    expect(semanticHit.passage).toEqual(lexicalHit.passage);
    expect(semanticHit.document).toEqual(lexicalHit.document);
    expect(semanticHit.source).toEqual(lexicalHit.source);
    expect(semanticHit.people).toEqual(lexicalHit.people);
    expect(Object.keys(semanticHit).sort()).toEqual(Object.keys(lexicalHit).sort());
  });

  it("uses the passage's opening words as the snippet and never returns raw_text", async () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    await ingest(words);
    await embedMissingPassages(embedder);

    const res = await semantic({ q: "word1" });

    expect(res.body.results[0].snippet).toBe(`${words.split(" ").slice(0, 40).join(" ")} …`);
    expect(JSON.stringify(res.body)).not.toContain("raw_text");
    expect(JSON.stringify(res.body)).not.toContain("search_vector");
  });
});
