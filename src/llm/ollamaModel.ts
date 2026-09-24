import { LanguageModelConfigError, LanguageModelError } from "./errors";
import type { LanguageModel, LanguageModelStopReason } from "./languageModel";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
/** Room for the ~10k-token evidence prompt plus the answer; Ollama's own default is far smaller. */
export const DEFAULT_OLLAMA_NUM_CTX = 32768;
export const DEFAULT_OLLAMA_TIMEOUT_MS = 300_000;

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  numCtx: number;
  timeoutMs: number;
}

/** The subset of the /api/chat (stream: false) response this provider reads. */
interface OllamaChatResponse {
  message?: { content?: unknown };
  done_reason?: unknown;
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new LanguageModelConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}

/** Reads OLLAMA_MODEL (required), OLLAMA_BASE_URL, OLLAMA_NUM_CTX and OLLAMA_TIMEOUT_MS. */
export function ollamaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  const model = env.OLLAMA_MODEL?.trim();
  if (!model) {
    throw new LanguageModelConfigError("OLLAMA_MODEL is required to answer questions with LLM_PROVIDER=ollama");
  }
  return {
    baseUrl: (env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, ""),
    model,
    numCtx: positiveInteger(env.OLLAMA_NUM_CTX, "OLLAMA_NUM_CTX", DEFAULT_OLLAMA_NUM_CTX),
    timeoutMs: positiveInteger(env.OLLAMA_TIMEOUT_MS, "OLLAMA_TIMEOUT_MS", DEFAULT_OLLAMA_TIMEOUT_MS),
  };
}

function toStopReason(reason: unknown): LanguageModelStopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

/**
 * A local model served by Ollama, via its HTTP chat API (non-streaming).
 *
 * `truncate: false` and `shift: false` make Ollama reject a prompt that does
 * not fit in `numCtx` instead of silently dropping its beginning — which is
 * where the grounding rules are. Temperature 0 keeps answers as repeatable as
 * the runtime allows. `fetchImpl` is injectable so tests never need a server.
 */
export function createOllamaLanguageModel(config: OllamaConfig, fetchImpl: typeof fetch = fetch): LanguageModel {
  const url = `${config.baseUrl}/api/chat`;

  return {
    modelId: config.model,
    generate: async ({ system, prompt, maxTokens }) => {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            stream: false,
            truncate: false,
            shift: false,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            options: { num_ctx: config.numCtx, num_predict: maxTokens, temperature: 0 },
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        throw new LanguageModelError(`language model request failed: could not get a reply from Ollama at ${config.baseUrl}: ${(err as Error).message}`);
      }

      const body = await res.text();
      if (!res.ok) {
        throw new LanguageModelError(`language model request failed (${res.status}): ${body.slice(0, 500)}`);
      }

      let parsed: OllamaChatResponse;
      try {
        parsed = JSON.parse(body) as OllamaChatResponse;
      } catch {
        throw new LanguageModelError("language model request failed: Ollama returned a non-JSON response");
      }
      if (typeof parsed.message?.content !== "string") {
        throw new LanguageModelError("language model request failed: Ollama response has no message content");
      }
      return { text: parsed.message.content, stopReason: toStopReason(parsed.done_reason) };
    },
  };
}
