import Anthropic from "@anthropic-ai/sdk";
import { LanguageModelConfigError, LanguageModelError } from "./errors";
import type { LanguageModel, LanguageModelStopReason } from "./languageModel";

function toStopReason(reason: Anthropic.Message["stop_reason"]): LanguageModelStopReason {
  switch (reason) {
    case "end_turn":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/**
 * Claude via the official Anthropic SDK. The model id comes from
 * ANTHROPIC_MODEL; credentials are resolved by the SDK (ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile). Refuses to exist under
 * NODE_ENV=test so tests can never call the real API.
 */
export function createAnthropicLanguageModel(): LanguageModel {
  if (process.env.NODE_ENV === "test") {
    throw new LanguageModelConfigError("the real language model is disabled under NODE_ENV=test; use a fake language model");
  }
  const modelId = process.env.ANTHROPIC_MODEL?.trim();
  if (!modelId) {
    throw new LanguageModelConfigError("ANTHROPIC_MODEL is required to answer questions");
  }
  const client = new Anthropic();

  return {
    modelId,
    generate: async ({ system, prompt, maxTokens }) => {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: modelId,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: prompt }],
        });
      } catch (err) {
        if (err instanceof Anthropic.APIError) {
          throw new LanguageModelError(`language model request failed${err.status ? ` (${err.status})` : ""}: ${err.message}`);
        }
        throw err;
      }
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      return { text, stopReason: toStopReason(message.stop_reason) };
    },
  };
}
