import { createAnthropicLanguageModel } from "./anthropicModel";

export interface LanguageModelRequest {
  system: string;
  /** The single user turn: evidence and question. */
  prompt: string;
  maxTokens: number;
}

/**
 * Why generation stopped: `end` is a normal finish; `max_tokens` means the
 * text was cut off; `refusal` means the model declined.
 */
export type LanguageModelStopReason = "end" | "max_tokens" | "refusal" | "other";

export interface LanguageModelResponse {
  text: string;
  stopReason: LanguageModelStopReason;
}

/** A text-in, text-out model. Stateless: every call carries its full context. */
export interface LanguageModel {
  readonly modelId: string;
  generate(request: LanguageModelRequest): Promise<LanguageModelResponse>;
}

let current: LanguageModel | null = null;

/** The process-wide language model; the real one is created lazily on first use. */
export function getLanguageModel(): LanguageModel {
  current ??= createAnthropicLanguageModel();
  return current;
}

/** Replaces the process-wide language model (tests use a deterministic fake); null restores the default. */
export function setLanguageModel(model: LanguageModel | null): void {
  current = model;
}
