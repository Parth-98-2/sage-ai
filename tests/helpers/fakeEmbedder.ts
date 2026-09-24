import crypto from "node:crypto";
import type { Embedder } from "../../src/embeddings/embedder";

export const FAKE_DIMENSIONS = 768;

export interface FakeEmbedder extends Embedder {
  calls: Array<{ kind: "query" | "document"; text: string }>;
  vector(text: string): number[];
}

/**
 * Deterministic stand-in for the real model, for tests only: a hashed
 * bag-of-words vector, L2-normalised. Texts sharing more words score higher.
 * Its rankings say nothing about real semantic retrieval quality.
 */
export function createFakeEmbedder(modelId = "fake-test@1"): FakeEmbedder {
  const vector = (text: string): number[] => {
    const v = new Array<number>(FAKE_DIMENSIONS).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const digest = crypto.createHash("sha256").update(word).digest();
      v[digest.readUInt32BE(0) % FAKE_DIMENSIONS] += 1;
    }
    const norm = Math.hypot(...v);
    return norm === 0 ? v.map((_, i) => (i === 0 ? 1 : 0)) : v.map((x) => x / norm);
  };

  const calls: FakeEmbedder["calls"] = [];
  return {
    modelId,
    dimensions: FAKE_DIMENSIONS,
    calls,
    vector,
    embedQuery: async (text) => {
      calls.push({ kind: "query", text });
      return vector(text);
    },
    embedDocument: async (text) => {
      calls.push({ kind: "document", text });
      return vector(text);
    },
  };
}

export function dot(a: number[], b: number[]): number {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}
