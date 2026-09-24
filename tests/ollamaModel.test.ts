import { describe, expect, it } from "vitest";
import { LanguageModelConfigError, LanguageModelError } from "../src/llm/errors";
import {
  createOllamaLanguageModel,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_NUM_CTX,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  ollamaConfigFromEnv,
  type OllamaConfig,
} from "../src/llm/ollamaModel";
import { createLanguageModelForProvider, createLanguageModelFromEnv, llmProviderFromEnv } from "../src/llm/provider";

const config: OllamaConfig = { baseUrl: "http://ollama.test:11434", model: "qwen2.5:7b", numCtx: 32768, timeoutMs: 1000 };
const request = { system: "SYSTEM", prompt: "EVIDENCE AND QUESTION", maxTokens: 16000 };

interface FakeFetch {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
}

/** A fetch stand-in that records each call and answers with a fixed status and body. */
function fakeFetch(status: number, body: unknown): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch: impl as typeof fetch, calls };
}

const ok = (content: string, done_reason = "stop") =>
  fakeFetch(200, { model: "qwen2.5:7b", message: { role: "assistant", content }, done: true, done_reason });

describe("createOllamaLanguageModel", () => {
  it("posts one non-streaming chat request with the system prompt, user prompt and limits", async () => {
    const fake = ok("An answer [1].");
    await createOllamaLanguageModel(config, fake.fetch).generate(request);

    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.calls[0];
    expect(url).toBe("http://ollama.test:11434/api/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "qwen2.5:7b",
      stream: false,
      truncate: false,
      shift: false,
      messages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "EVIDENCE AND QUESTION" },
      ],
      options: { num_ctx: 32768, num_predict: 16000, temperature: 0 },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the reply text unchanged and reports the model id", async () => {
    const model = createOllamaLanguageModel(config, ok("  Senra recounts it [2].  ").fetch);
    expect(model.modelId).toBe("qwen2.5:7b");
    expect(await model.generate(request)).toEqual({ text: "  Senra recounts it [2].  ", stopReason: "end" });
  });

  it.each([
    ["stop", "end"],
    ["length", "max_tokens"],
    ["load", "other"],
    [undefined, "other"],
  ])("maps done_reason %s to stop reason %s", async (doneReason, stopReason) => {
    const fake = fakeFetch(200, { message: { content: "x" }, done_reason: doneReason });
    expect((await createOllamaLanguageModel(config, fake.fetch).generate(request)).stopReason).toBe(stopReason);
  });

  it("surfaces an HTTP error, including a context overflow, as a LanguageModelError", async () => {
    const overflow = fakeFetch(400, {
      error: '{"error":{"code":400,"message":"request (40000 tokens) exceeds the available context size (32768 tokens)","type":"exceed_context_size_error"}}',
    });
    const generation = createOllamaLanguageModel(config, overflow.fetch).generate(request);
    await expect(generation).rejects.toThrow(LanguageModelError);
    await expect(createOllamaLanguageModel(config, overflow.fetch).generate(request)).rejects.toThrow(/\(400\).*exceeds the available context size/);

    const missing = fakeFetch(404, { error: "model 'qwen2.5:7b' not found" });
    await expect(createOllamaLanguageModel(config, missing.fetch).generate(request)).rejects.toThrow(/\(404\).*not found/);
  });

  it("surfaces an unreachable server as a LanguageModelError", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(createOllamaLanguageModel(config, refused).generate(request)).rejects.toThrow(
      /could not get a reply from Ollama at http:\/\/ollama\.test:11434: fetch failed/
    );
  });

  it("rejects a malformed response instead of treating it as an answer", async () => {
    await expect(createOllamaLanguageModel(config, fakeFetch(200, "not json").fetch).generate(request)).rejects.toThrow(/non-JSON/);
    await expect(createOllamaLanguageModel(config, fakeFetch(200, { done: true }).fetch).generate(request)).rejects.toThrow(
      /no message content/
    );
  });
});

describe("ollamaConfigFromEnv", () => {
  it("requires OLLAMA_MODEL and defaults the rest", () => {
    expect(() => ollamaConfigFromEnv({})).toThrow(LanguageModelConfigError);
    expect(ollamaConfigFromEnv({ OLLAMA_MODEL: " qwen2.5:7b " })).toEqual({
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      model: "qwen2.5:7b",
      numCtx: DEFAULT_OLLAMA_NUM_CTX,
      timeoutMs: DEFAULT_OLLAMA_TIMEOUT_MS,
    });
  });

  it("reads overrides and strips a trailing slash from the base URL", () => {
    expect(
      ollamaConfigFromEnv({ OLLAMA_MODEL: "m", OLLAMA_BASE_URL: "http://gpu-box:11434/", OLLAMA_NUM_CTX: "16384", OLLAMA_TIMEOUT_MS: "60000" })
    ).toEqual({ baseUrl: "http://gpu-box:11434", model: "m", numCtx: 16384, timeoutMs: 60000 });
  });

  it.each(["0", "-1", "1.5", "lots"])("rejects OLLAMA_NUM_CTX=%s", (value) => {
    expect(() => ollamaConfigFromEnv({ OLLAMA_MODEL: "m", OLLAMA_NUM_CTX: value })).toThrow(/OLLAMA_NUM_CTX must be a positive integer/);
  });
});

describe("provider selection", () => {
  it("defaults to ollama and accepts either provider, case-insensitively", () => {
    expect(llmProviderFromEnv({})).toBe("ollama");
    expect(llmProviderFromEnv({ LLM_PROVIDER: "" })).toBe("ollama");
    expect(llmProviderFromEnv({ LLM_PROVIDER: " Anthropic " })).toBe("anthropic");
    expect(llmProviderFromEnv({ LLM_PROVIDER: "ollama" })).toBe("ollama");
  });

  it("rejects an unknown provider", () => {
    expect(() => llmProviderFromEnv({ LLM_PROVIDER: "openai" })).toThrow(/LLM_PROVIDER must be one of: ollama, anthropic/);
  });

  it("builds an Ollama model from the environment", () => {
    expect(createLanguageModelForProvider({ OLLAMA_MODEL: "qwen2.5:7b" }).modelId).toBe("qwen2.5:7b");
    expect(() => createLanguageModelForProvider({ LLM_PROVIDER: "ollama" })).toThrow(/OLLAMA_MODEL is required/);
  });

  it("routes LLM_PROVIDER=anthropic to the Anthropic implementation", () => {
    // Under NODE_ENV=test the Anthropic implementation refuses to start; hitting
    // its own guard shows the factory delegated to it.
    expect(() => createLanguageModelForProvider({ LLM_PROVIDER: "anthropic" })).toThrow(/disabled under NODE_ENV=test/);
  });

  it("never builds a real model under NODE_ENV=test, whatever the provider", () => {
    for (const LLM_PROVIDER of ["ollama", "anthropic"]) {
      expect(() => createLanguageModelFromEnv({ NODE_ENV: "test", LLM_PROVIDER, OLLAMA_MODEL: "m" })).toThrow(LanguageModelConfigError);
    }
  });
});
