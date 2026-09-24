import { createAnthropicLanguageModel } from "./anthropicModel";
import { LanguageModelConfigError } from "./errors";
import type { LanguageModel } from "./languageModel";
import { createOllamaLanguageModel, ollamaConfigFromEnv } from "./ollamaModel";

export const LLM_PROVIDERS = ["ollama", "anthropic"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
/** Local by default, so answering works without API credits. */
export const DEFAULT_LLM_PROVIDER: LlmProvider = "ollama";

/** The provider named by LLM_PROVIDER, or the default when it is unset. */
export function llmProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const value = env.LLM_PROVIDER?.trim().toLowerCase();
  if (!value) return DEFAULT_LLM_PROVIDER;
  if (!(LLM_PROVIDERS as readonly string[]).includes(value)) {
    throw new LanguageModelConfigError(`LLM_PROVIDER must be one of: ${LLM_PROVIDERS.join(", ")}`);
  }
  return value as LlmProvider;
}

/** Builds the configured provider's model, without the test guard (see createLanguageModelFromEnv). */
export function createLanguageModelForProvider(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  switch (llmProviderFromEnv(env)) {
    case "ollama":
      return createOllamaLanguageModel(ollamaConfigFromEnv(env));
    case "anthropic":
      return createAnthropicLanguageModel();
  }
}

/**
 * The real language model for this process. Refuses to exist under
 * NODE_ENV=test, whatever the provider, so tests can never call a real model.
 */
export function createLanguageModelFromEnv(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  if (env.NODE_ENV === "test") {
    throw new LanguageModelConfigError("the real language model is disabled under NODE_ENV=test; use a fake language model");
  }
  return createLanguageModelForProvider(env);
}
