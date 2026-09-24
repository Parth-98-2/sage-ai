import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/db/pool";
import { embedMissingPassages } from "../src/embeddings/backfill";
import { setEmbedder } from "../src/embeddings/embedder";
import { ingestText } from "../src/ingestion/ingestionService";
import { HYBRID_CANDIDATE_DEPTH, reciprocalRankFusion, RRF_K } from "../src/retrieval/hybrid";
import { createFakeEmbedder } from "./helpers/fakeEmbedder";

describe("reciprocalRankFusion", () => {
  it("uses the fixed, untuned constants", () => {
    expect(RRF_K).toBe(60);
    expect(HYBRID_CANDIDATE_DEPTH).toBe(50);
  });

  it("sums 1/(k + rank) across rankings", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["c", "a"],
    ]);

    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused[1].score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[2].score).toBeCloseTo(1 / 62, 12);
  });

  it("gives an id found by only one ranking that ranking's contribution alone", () => {
    const fused = reciprocalRankFusion([["a"], ["b", "c"]]);
    expect(Object.fromEntries(fused.map((f) => [f.id, f.score]))).toEqual({ a: 1 / 61, b: 1 / 61, c: 1 / 62 });
  });

  it("breaks exact ties by id", () => {
    expect(reciprocalRankFusion([["y", "x"], ["x", "y"]]).map((f) => f.id)).toEqual(["x", "y"]);
    expect(reciprocalRankFusion([["b"], ["a"]]).map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("does not depend on the order of the rankings", () => {
    const rankings = [["a", "b", "c", "d"], ["d", "b", "e"]];
    expect(reciprocalRankFusion([...rankings].reverse())).toEqual(reciprocalRankFusion(rankings));
  });

  it("accepts a different k and handles empty input", () => {
    expect(reciprocalRankFusion([["a"]], 0)).toEqual([{ id: "a", score: 1 }]);
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe("GET /search?mode=hybrid", () => {
  const app = createApp();
  const embedder = createFakeEmbedder();

  beforeAll(() => setEmbedder(embedder));

  beforeEach(async () => {
    await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    setEmbedder(null);
    await pool.end();
  });

  async function seed() {
    const texts = [
      "courage courage soldier battle",
      "courage garden",
      "garden flowers water sunlight",
      "soldiers marching bravely",
      "the river runs quietly",
    ];
    for (const [i, rawText] of texts.entries()) {
      await ingestText({
        rawText,
        suggestedTitle: `T${i}`,
        sourceType: "book",
        personName: i < 3 ? "Marcus Aurelius" : "Seneca",
        ingestionMethod: "text_upload",
      });
    }
    await embedMissingPassages(embedder);
  }

  const search = (query: Record<string, string>) => request(app).get("/search").query(query);
  const ids = (body: { results: Array<{ passage: { id: string } }> }) => body.results.map((r) => r.passage.id);

  it("equals RRF over the lexical and semantic top 50 returned by /search", async () => {
    await seed();
    const q = "courage soldier";

    const lexical = await search({ q, mode: "lexical", limit: "50" });
    const semantic = await search({ q, mode: "semantic", limit: "50" });
    const hybrid = await search({ q, mode: "hybrid", limit: "50" });

    const expected = reciprocalRankFusion([ids(lexical.body), ids(semantic.body)]);
    expect(ids(hybrid.body)).toEqual(expected.map((e) => e.id));
    hybrid.body.results.forEach((r: { score: number }, i: number) => expect(r.score).toBeCloseTo(expected[i].score, 12));
  });

  it("keeps the lexical snippet for lexical matches and a leading-words snippet otherwise", async () => {
    await seed();

    const res = await search({ q: "courage soldier", mode: "hybrid" });

    const byText = new Map(res.body.results.map((r: { passage: { text: string }; snippet: string }) => [r.passage.text, r.snippet]));
    expect(byText.get("courage courage soldier battle")).toContain("**");
    expect(byText.get("the river runs quietly")).toBe("the river runs quietly");
  });

  it("falls back to the semantic ranking when lexical search matches nothing", async () => {
    await seed();

    const semantic = await search({ q: "what is it?", mode: "semantic", limit: "50" });
    const hybrid = await search({ q: "what is it?", mode: "hybrid", limit: "50" });

    expect(ids(hybrid.body)).toEqual(ids(semantic.body));
  });

  it("applies limit after fusion and respects filters", async () => {
    await seed();
    const seneca = (await pool.query(`SELECT id FROM people WHERE name = 'Seneca'`)).rows[0].id;

    expect((await search({ q: "courage", mode: "hybrid", limit: "2" })).body.results).toHaveLength(2);

    const filtered = await search({ q: "courage soldier", mode: "hybrid", personId: seneca });
    expect(filtered.body.results.length).toBeGreaterThan(0);
    for (const r of filtered.body.results) {
      expect(r.people.map((p: { name: string }) => p.name)).toContain("Seneca");
    }
  });
});
