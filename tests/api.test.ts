import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/db/pool";

const app = createApp();

beforeEach(async () => {
  await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("GET /health", () => {
  it("returns an ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("POST /ingest/text-file", () => {
  it("ingests a .txt file and the document can be retrieved with its passages", async () => {
    const ingestRes = await request(app)
      .post("/ingest/text-file")
      .field("title", "API Test Source")
      .field("sourceType", "essay")
      .field("personName", "Grace Hopper")
      .attach("file", Buffer.from("Hello world. ".repeat(50)), "test.txt");

    expect(ingestRes.status).toBe(201);
    expect(ingestRes.body.document.id).toBeDefined();
    expect(ingestRes.body.passages.length).toBeGreaterThan(0);

    const getRes = await request(app).get(`/documents/${ingestRes.body.document.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.document.id).toBe(ingestRes.body.document.id);
    expect(getRes.body.passages.length).toBe(ingestRes.body.passages.length);
    expect(getRes.body.passages[0]).not.toHaveProperty("search_vector");
  });

  it("rejects a request with no file", async () => {
    const res = await request(app).post("/ingest/text-file").field("personName", "X");
    expect(res.status).toBe(400);
  });

  it("rejects unsupported file types", async () => {
    const res = await request(app)
      .post("/ingest/text-file")
      .field("personName", "X")
      .attach("file", Buffer.from("not text"), "test.pdf");
    expect(res.status).toBe(400);
  });

  it("rejects a missing personName", async () => {
    const res = await request(app)
      .post("/ingest/text-file")
      .attach("file", Buffer.from("some content"), "test.md");
    expect(res.status).toBe(400);
  });

  it("returns 201 for a new document and 200 with duplicate=true for a re-upload", async () => {
    const upload = () =>
      request(app)
        .post("/ingest/text-file")
        .field("title", "Duplicate Test")
        .field("personName", "Grace Hopper")
        .attach("file", Buffer.from("Same content twice."), "dup.txt");

    const first = await upload();
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);

    const second = await upload();
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.document.id).toBe(first.body.document.id);
  });

  it("rejects a file that is not valid UTF-8 with 400", async () => {
    const res = await request(app)
      .post("/ingest/text-file")
      .field("personName", "X")
      .attach("file", Buffer.from([0x43, 0x61, 0x66, 0xe9]), "latin1.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UTF-8/);
  });

  it("stores a BOM-prefixed CRLF file in normalised form", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Line one.\r\nLine two.")]);
    const res = await request(app).post("/ingest/text-file").field("personName", "X").attach("file", bytes, "bom.txt");
    expect(res.status).toBe(201);
    expect(res.body.document.raw_text).toBe("Line one.\nLine two.");
  });

  it("rejects an invalid publishedAt with 400", async () => {
    const res = await request(app)
      .post("/ingest/text-file")
      .field("personName", "X")
      .field("publishedAt", "2024-13-45")
      .attach("file", Buffer.from("content"), "date.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/publishedAt/);
  });

  it("rejects an invalid externalUrl with 400", async () => {
    const res = await request(app)
      .post("/ingest/text-file")
      .field("personName", "X")
      .field("externalUrl", "not a url")
      .attach("file", Buffer.from("content"), "url.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/externalUrl/);
  });

  it("returns 413 JSON for a file over the size limit", async () => {
    const res = await request(app)
      .post("/ingest/text-file")
      .field("personName", "X")
      .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1, "a"), "big.txt");
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toMatch(/limit/);
  });

  it("returns 400 JSON for an unexpected multipart file field", async () => {
    const res = await request(app)
      .post("/ingest/text-file")
      .field("personName", "X")
      .attach("document", Buffer.from("content"), "wrong-field.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
  });
});

describe("GET /documents/:id", () => {
  it("returns 404 for a well-formed but nonexistent id", async () => {
    const res = await request(app).get("/documents/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app).get("/documents/not-a-uuid");
    expect(res.status).toBe(400);
  });
});
