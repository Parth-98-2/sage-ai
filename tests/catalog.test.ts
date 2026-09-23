import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/db/pool";
import { ingestText } from "../src/ingestion/ingestionService";

const app = createApp();

beforeEach(async () => {
  await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

const sampleText = `${"alpha ".repeat(400).trim()}\n\n${"beta ".repeat(400).trim()}`;

async function seedFoundersEpisode() {
  return ingestText({
    rawText: sampleText,
    suggestedTitle: "Founders #234 — Enzo Ferrari",
    sourceType: "podcast",
    personName: "David Senra",
    personRole: "host",
    ingestionMethod: "text_upload",
    originalFilename: "founders-234.txt",
    mimeType: "text/plain",
  });
}

describe("GET /people/:id", () => {
  it("returns the person and their sources with role", async () => {
    const seeded = await seedFoundersEpisode();

    const res = await request(app).get(`/people/${seeded.person.id}`);

    expect(res.status).toBe(200);
    expect(res.body.person.id).toBe(seeded.person.id);
    expect(res.body.person.name).toBe("David Senra");
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0].id).toBe(seeded.source.id);
    expect(res.body.sources[0].role).toBe("host");
  });

  it("returns 404 for a nonexistent person", async () => {
    const res = await request(app).get("/people/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app).get("/people/not-a-uuid");
    expect(res.status).toBe(400);
  });
});

describe("GET /sources/:id", () => {
  it("returns the source, its people with roles, and its documents (without raw_text)", async () => {
    const seeded = await seedFoundersEpisode();

    const res = await request(app).get(`/sources/${seeded.source.id}`);

    expect(res.status).toBe(200);
    expect(res.body.source.id).toBe(seeded.source.id);
    expect(res.body.source.title).toBe("Founders #234 — Enzo Ferrari");

    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0].id).toBe(seeded.person.id);
    expect(res.body.people[0].role).toBe("host");

    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].id).toBe(seeded.document.id);
    expect(res.body.documents[0].passage_count).toBe(seeded.passages.length);
    expect(res.body.documents[0].raw_text).toBeUndefined();
  });

  it("returns 404 for a nonexistent source", async () => {
    const res = await request(app).get("/sources/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app).get("/sources/not-a-uuid");
    expect(res.status).toBe(400);
  });
});

describe("GET /sources/:id/documents", () => {
  it("returns document summaries for the source without raw_text", async () => {
    const seeded = await seedFoundersEpisode();

    const res = await request(app).get(`/sources/${seeded.source.id}/documents`);

    expect(res.status).toBe(200);
    expect(res.body.source_id).toBe(seeded.source.id);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].id).toBe(seeded.document.id);
    expect(res.body.documents[0].ingestion_method).toBe("text_upload");
    expect(res.body.documents[0].passage_count).toBe(seeded.passages.length);
    expect(res.body.documents[0].raw_text).toBeUndefined();
  });

  it("reflects multiple documents when the same source is re-ingested", async () => {
    const first = await seedFoundersEpisode();
    await ingestText({
      rawText: sampleText,
      suggestedTitle: "Founders #234 — Enzo Ferrari",
      sourceType: "podcast",
      personName: "David Senra",
      personRole: "host",
      ingestionMethod: "text_upload",
      originalFilename: "founders-234-corrected.txt",
      mimeType: "text/plain",
    });

    const res = await request(app).get(`/sources/${first.source.id}/documents`);

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);
  });

  it("returns 404 for a nonexistent source", async () => {
    const res = await request(app).get("/sources/00000000-0000-0000-0000-000000000000/documents");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app).get("/sources/not-a-uuid/documents");
    expect(res.status).toBe(400);
  });
});
