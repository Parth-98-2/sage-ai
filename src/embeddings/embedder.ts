import { createNomicEmbedder } from "./nomicEmbedder";

/**
 * Turns text into a fixed-length, L2-normalised vector. Vectors are only
 * comparable when they come from the same `modelId`, which is why every
 * stored embedding is keyed by it.
 */
export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  embedDocument(text: string): Promise<number[]>;
}

let current: Embedder | null = null;

/** The process-wide embedder; the real model is created lazily on first use. */
export function getEmbedder(): Embedder {
  current ??= createNomicEmbedder();
  return current;
}

/** Replaces the process-wide embedder (tests use a deterministic fake); null restores the default. */
export function setEmbedder(embedder: Embedder | null): void {
  current = embedder;
}
