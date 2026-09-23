import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/db/pool";
import { ingestText } from "../src/ingestion/ingestionService";
import { getDocumentWithPassages } from "../src/ingestion/repository";

const app = createApp();

beforeEach(async () => {
  await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function ingest(overrides: Partial<Parameters<typeof ingestText>[0]> & { rawText: string }) {
  return ingestText({
    suggestedTitle: "Meditations",
    sourceType: "book",
    personName: "Marcus Aurelius",
    personRole: "author",
    ingestionMethod: "text_upload",
    originalFilename: "meditations.txt",
    mimeType: "text/plain",
    ...overrides,
  });
}

function search(query: Record<string, string>) {
  return request(app).get("/search").query(query);
}

describe("GET /search matching and ranking", () => {
  it("matches different word forms via stemming", async () => {
    await ingest({ rawText: "The river runs quietly past the old stone mill." });

    const res = await search({ q: "running" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].passage.text).toContain("runs");
  });

  it("uses OR semantics so passages matching only some terms are returned", async () => {
    await ingest({ rawText: "Courage is the first of the virtues." });
    await ingest({ rawText: "Death smiles at us all.", suggestedTitle: "Letters", sourceType: "essay" });
    await ingest({ rawText: "Gardens need patient tending.", suggestedTitle: "Notes", sourceType: "other" });

    const res = await search({ q: "What did he say about death and courage?" });
    expect(res.status).toBe(200);
    const texts = res.body.results.map((r: { passage: { text: string } }) => r.passage.text);
    expect(texts).toHaveLength(2);
    expect(texts).toEqual(expect.arrayContaining(["Courage is the first of the virtues.", "Death smiles at us all."]));
  });

  it("ranks passages with more matches higher", async () => {
    await ingest({ rawText: "Courage appears once here among other words." });
    await ingest({
      rawText: "Courage, courage, and more courage: courage is everything.",
      suggestedTitle: "Letters",
      sourceType: "essay",
    });

    const res = await search({ q: "courage" });
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].passage.text).toContain("courage is everything");
    expect(res.body.results[0].score).toBeGreaterThan(res.body.results[1].score);
  });

  it("breaks score ties by passage id ascending", async () => {
    const text = "Stillness is the key to clear judgement.";
    await ingest({ rawText: text });
    await ingest({ rawText: text });
    await ingest({ rawText: text });

    const res = await search({ q: "stillness" });
    const ids = res.body.results.map((r: { passage: { id: string } }) => r.passage.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(res.body.results.map((r: { score: number }) => r.score)).size).toBe(1);
  });

  it("returns 200 with empty results for a stopword-only query", async () => {
    await ingest({ rawText: "What is it that we fear?" });

    const res = await search({ q: "what is it?" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: "what is it?", results: [] });
  });

  it("treats tsquery operator characters in q as plain text", async () => {
    await ingest({ rawText: "Courage is the first of the virtues." });

    const res = await search({ q: "courage & | ! :* ( ) ' \\ <->" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it("highlights matched terms in the snippet", async () => {
    await ingest({ rawText: "Courage is the first of the virtues." });

    const res = await search({ q: "courage" });
    expect(res.body.results[0].snippet).toContain("**Courage**");
  });

  it("excludes passages from documents that are not ready", async () => {
    const ready = await ingest({ rawText: "Courage in the ready document." });
    const failed = await ingest({ rawText: "Courage in the failed document." });
    await pool.query(`UPDATE documents SET status = 'failed' WHERE id = $1`, [failed.document.id]);

    const res = await search({ q: "courage" });
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].document.id).toBe(ready.document.id);
  });

  it("applies the default limit of 10 and respects an explicit limit", async () => {
    for (let i = 0; i < 12; i++) {
      await ingest({ rawText: `Courage note number ${i}.` });
    }

    const defaultRes = await search({ q: "courage" });
    expect(defaultRes.body.results).toHaveLength(10);

    const limitedRes = await search({ q: "courage", limit: "3" });
    expect(limitedRes.body.results).toHaveLength(3);
  });
});

describe("GET /search provenance", () => {
  it("returns passage, document, source and people provenance without raw_text", async () => {
    const paragraphs = Array.from({ length: 3 }, (_, i) =>
      `${"filler ".repeat(300).trim()} marker${i === 2 ? " courage" : ""}`
    );
    const rawText = paragraphs.join("\n\n");
    const ingested = await ingest({ rawText, externalUrl: "https://example.com/meditations" });

    const res = await search({ q: "courage" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const [result] = res.body.results;

    expect(JSON.stringify(res.body)).not.toContain("raw_text");
    expect(JSON.stringify(res.body)).not.toContain("search_vector");

    expect(result.document).toEqual({
      id: ingested.document.id,
      ingestion_method: "text_upload",
      original_filename: "meditations.txt",
      source_url: null,
      created_at: expect.any(String),
    });
    expect(result.source).toMatchObject({
      id: ingested.source.id,
      title: "Meditations",
      source_type: "book",
      external_url: "https://example.com/meditations",
    });
    expect(result.people).toEqual([{ id: ingested.person.id, name: "Marcus Aurelius", role: "author" }]);

    const stored = await getDocumentWithPassages(ingested.document.id);
    expect(result.passage.ordinal).toBeGreaterThan(0);
    expect(stored!.document.raw_text.slice(result.passage.char_start, result.passage.char_end)).toBe(
      result.passage.text
    );
  });

  it("lists every person and role linked to the source", async () => {
    await ingest({
      rawText: "Courage under pressure.",
      suggestedTitle: "Founders #1",
      sourceType: "podcast",
      personName: "David Senra",
      personRole: "host",
    });
    await ingest({
      rawText: "More on courage.",
      suggestedTitle: "Founders #1",
      sourceType: "podcast",
      personName: "Enzo Ferrari",
      personRole: "subject",
    });

    const res = await search({ q: "courage" });
    expect(res.body.results).toHaveLength(2);
    for (const result of res.body.results) {
      expect(result.people).toEqual([
        { id: expect.any(String), name: "David Senra", role: "host" },
        { id: expect.any(String), name: "Enzo Ferrari", role: "subject" },
      ]);
    }
  });
});

describe("GET /search filters", () => {
  async function seedTwoSources() {
    const marcus = await ingest({ rawText: "Courage is the first of the virtues." });
    const seneca = await ingest({
      rawText: "Courage leads to the stars.",
      suggestedTitle: "Letters",
      sourceType: "essay",
      personName: "Seneca",
    });
    return { marcus, seneca };
  }

  it("filters by personId", async () => {
    const { seneca } = await seedTwoSources();

    const res = await search({ q: "courage", personId: seneca.person.id });
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].source.id).toBe(seneca.source.id);
  });

  it("filters by sourceId", async () => {
    const { marcus } = await seedTwoSources();

    const res = await search({ q: "courage", sourceId: marcus.source.id });
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].source.id).toBe(marcus.source.id);
  });

  it("combines personId and sourceId filters", async () => {
    const { marcus, seneca } = await seedTwoSources();

    const res = await search({ q: "courage", personId: seneca.person.id, sourceId: marcus.source.id });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it("returns empty results for a well-formed but unknown personId", async () => {
    await seedTwoSources();

    const res = await search({ q: "courage", personId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

describe("GET /search validation", () => {
  it.each([
    ["missing q", "/search"],
    ["empty q", "/search?q=%20%20"],
    ["repeated q", "/search?q=a&q=b"],
    ["overlong q", `/search?q=${"a".repeat(501)}`],
    ["zero limit", "/search?q=courage&limit=0"],
    ["limit above max", "/search?q=courage&limit=51"],
    ["non-integer limit", "/search?q=courage&limit=2.5"],
    ["non-numeric limit", "/search?q=courage&limit=ten"],
    ["invalid personId", "/search?q=courage&personId=not-a-uuid"],
    ["invalid sourceId", "/search?q=courage&sourceId=123"],
  ])("rejects %s with 400", async (_label, url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
  });

  it("trims q in the response", async () => {
    const res = await search({ q: "  courage  " });
    expect(res.status).toBe(200);
    expect(res.body.query).toBe("courage");
  });
});
