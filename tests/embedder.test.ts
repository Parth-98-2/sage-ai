import { afterEach, describe, expect, it } from "vitest";
import { getEmbedder, setEmbedder } from "../src/embeddings/embedder";
import {
  createNomicEmbedder,
  DOCUMENT_PREFIX,
  NOMIC_DIMENSIONS,
  NOMIC_MODEL_ID,
  QUERY_PREFIX,
  type TextEncoderModel,
} from "../src/embeddings/nomicEmbedder";
import { createFakeEmbedder } from "./helpers/fakeEmbedder";

function stubModel(overrides: Partial<TextEncoderModel> = {}) {
  const embedded: string[] = [];
  let loads = 0;
  const model: TextEncoderModel = {
    maxTokens: 8192,
    countTokens: (text) => text.split(/\s+/).length,
    embed: async (text) => {
      embedded.push(text);
      return new Array(NOMIC_DIMENSIONS).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    },
    ...overrides,
  };
  return {
    embedded,
    loadCount: () => loads,
    load: async () => {
      loads++;
      return model;
    },
  };
}

describe("createNomicEmbedder", () => {
  it("identifies the pinned model, revision and quantisation", () => {
    expect(NOMIC_MODEL_ID).toBe("nomic-ai/nomic-embed-text-v1.5@e9b6763023c676ca8431644204f50c2b100d9aab/q8");
    const embedder = createNomicEmbedder(stubModel().load);
    expect(embedder.modelId).toBe(NOMIC_MODEL_ID);
    expect(embedder.dimensions).toBe(768);
  });

  it("applies the query and document task prefixes", async () => {
    const stub = stubModel();
    const embedder = createNomicEmbedder(stub.load);

    await embedder.embedQuery("What did Napoleon say?");
    await embedder.embedDocument("I had no definitive plans.");

    expect(QUERY_PREFIX).toBe("search_query: ");
    expect(DOCUMENT_PREFIX).toBe("search_document: ");
    expect(stub.embedded).toEqual(["search_query: What did Napoleon say?", "search_document: I had no definitive plans."]);
  });

  it("loads the model once and reuses it", async () => {
    const stub = stubModel();
    const embedder = createNomicEmbedder(stub.load);
    await Promise.all([embedder.embedQuery("a"), embedder.embedQuery("b"), embedder.embedDocument("c")]);
    expect(stub.loadCount()).toBe(1);
  });

  it("retries loading after a failed load", async () => {
    let attempts = 0;
    const stub = stubModel();
    const embedder = createNomicEmbedder(async () => {
      attempts++;
      if (attempts === 1) throw new Error("download failed");
      return stub.load();
    });

    await expect(embedder.embedQuery("a")).rejects.toThrow("download failed");
    await expect(embedder.embedQuery("a")).resolves.toHaveLength(NOMIC_DIMENSIONS);
  });

  it("refuses to embed text longer than the model limit instead of truncating", async () => {
    const stub = stubModel({ maxTokens: 3 });
    const embedder = createNomicEmbedder(stub.load);

    await expect(embedder.embedDocument("one two three four")).rejects.toThrow(/refusing to truncate/);
    expect(stub.embedded).toEqual([]);
  });

  it("rejects an embedding with the wrong number of dimensions", async () => {
    const embedder = createNomicEmbedder(stubModel({ embed: async () => [0.6, 0.8] }).load);
    await expect(embedder.embedQuery("a")).rejects.toThrow(/expected a 768-dimensional embedding, got 2/);
  });

  it("never loads the real model under NODE_ENV=test", async () => {
    await expect(createNomicEmbedder().embedQuery("a")).rejects.toThrow(/disabled under NODE_ENV=test/);
  });
});

describe("getEmbedder / setEmbedder", () => {
  afterEach(() => setEmbedder(null));

  it("defaults to the Nomic embedder and can be replaced and restored", () => {
    expect(getEmbedder().modelId).toBe(NOMIC_MODEL_ID);

    const fake = createFakeEmbedder();
    setEmbedder(fake);
    expect(getEmbedder()).toBe(fake);

    setEmbedder(null);
    expect(getEmbedder().modelId).toBe(NOMIC_MODEL_ID);
  });
});
