import path from "node:path";
import type { Embedder } from "./embedder";

export const NOMIC_MODEL = "nomic-ai/nomic-embed-text-v1.5";
export const NOMIC_REVISION = "e9b6763023c676ca8431644204f50c2b100d9aab";
export const NOMIC_DTYPE = "q8";
export const NOMIC_DIMENSIONS = 768;
export const NOMIC_MODEL_ID = `${NOMIC_MODEL}@${NOMIC_REVISION}/${NOMIC_DTYPE}`;

export const QUERY_PREFIX = "search_query: ";
export const DOCUMENT_PREFIX = "search_document: ";

const MODEL_CACHE_DIR = path.resolve(__dirname, "..", "..", ".cache", "models");

/** The minimal model surface the embedder needs; injectable so tests never load the real model. */
export interface TextEncoderModel {
  maxTokens: number;
  countTokens(text: string): number;
  embed(text: string): Promise<number[]>;
}

/**
 * Loads the pinned q8 Nomic model through Transformers.js. The package is
 * ESM-typed, so it is imported dynamically from this CommonJS project.
 *
 * Pooling follows the model card: mean pooling, then layer norm, then L2
 * normalisation, keeping all 768 dimensions. Texts are always embedded one
 * at a time: the q8 model's dynamic quantisation makes a text's vector depend
 * on what else is in the batch.
 */
async function loadNomicModel(): Promise<TextEncoderModel> {
  if (process.env.NODE_ENV === "test") {
    throw new Error("the real embedding model is disabled under NODE_ENV=test; use a fake embedder");
  }
  const { pipeline, layer_norm, env } = await import("@huggingface/transformers");
  env.cacheDir = MODEL_CACHE_DIR;
  const extractor = await pipeline("feature-extraction", NOMIC_MODEL, {
    dtype: NOMIC_DTYPE,
    revision: NOMIC_REVISION,
  });

  return {
    maxTokens: extractor.tokenizer.model_max_length,
    countTokens: (text) => extractor.tokenizer.encode(text).length,
    embed: async (text) => {
      const pooled = await extractor([text], { pooling: "mean" });
      const normalised = layer_norm(pooled, [pooled.dims[1]]).normalize(2, -1);
      return (normalised.tolist() as number[][])[0];
    },
  };
}

/**
 * Wraps a text-encoder model with the Nomic task prefixes and refuses to
 * embed text that would be truncated or that yields the wrong dimension.
 */
export function createNomicEmbedder(loadModel: () => Promise<TextEncoderModel> = loadNomicModel): Embedder {
  let model: Promise<TextEncoderModel> | null = null;

  const encode = async (text: string): Promise<number[]> => {
    model ??= loadModel().catch((err) => {
      model = null;
      throw err;
    });
    const loaded = await model;

    const tokens = loaded.countTokens(text);
    if (tokens > loaded.maxTokens) {
      throw new Error(`text is ${tokens} tokens, over the model limit of ${loaded.maxTokens}; refusing to truncate`);
    }
    const vector = await loaded.embed(text);
    if (vector.length !== NOMIC_DIMENSIONS) {
      throw new Error(`expected a ${NOMIC_DIMENSIONS}-dimensional embedding, got ${vector.length}`);
    }
    return vector;
  };

  return {
    modelId: NOMIC_MODEL_ID,
    dimensions: NOMIC_DIMENSIONS,
    embedQuery: (text) => encode(QUERY_PREFIX + text),
    embedDocument: (text) => encode(DOCUMENT_PREFIX + text),
  };
}
