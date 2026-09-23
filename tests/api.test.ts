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
