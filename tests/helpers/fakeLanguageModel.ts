import type { LanguageModel, LanguageModelRequest, LanguageModelResponse } from "../../src/llm/languageModel";

export type FakeReply = string | LanguageModelResponse | ((request: LanguageModelRequest) => string | LanguageModelResponse);

export interface FakeLanguageModel extends LanguageModel {
  /** Every request received, exactly as passed in. */
  requests: LanguageModelRequest[];
}

/**
 * Deterministic stand-in for the real model, for tests only: returns a
 * scripted reply (a plain string finishes normally) and records each request.
 */
export function createFakeLanguageModel(reply: FakeReply, modelId = "fake-llm@1"): FakeLanguageModel {
  const requests: LanguageModelRequest[] = [];
  return {
    modelId,
    requests,
    generate: async (request) => {
      requests.push(request);
      const out = typeof reply === "function" ? reply(request) : reply;
      return typeof out === "string" ? { text: out, stopReason: "end" } : out;
    },
  };
}

/** The evidence number whose passage contains `needle`, read back from a recorded prompt. */
export function evidenceNumberContaining(prompt: string, needle: string): number {
  for (const block of prompt.split(/(?=<evidence number=")/)) {
    const match = block.match(/^<evidence number="(\d+)">/);
    if (match && block.includes(needle)) return Number(match[1]);
  }
  throw new Error(`no evidence block contains ${JSON.stringify(needle)}`);
}
