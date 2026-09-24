import { describe, expect, it } from "vitest";
import { parseCitationNumbers, resolveCitations } from "../src/answering/citations";
import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerPrompt,
  buildEvidence,
  formatEvidence,
  INSUFFICIENT_EVIDENCE_MARKER,
} from "../src/answering/prompt";
import { InvalidModelResponseError } from "../src/answering/types";
import type { SearchResult } from "../src/retrieval/types";

function result(id: string, text: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    passage: { id: `passage-${id}`, ordinal: Number(id), text, char_start: 0, char_end: text.length, token_count: 5 },
    snippet: `**snippet** for ${id}`,
    score: 0.5,
    document: {
      id: `document-${id}`,
      ingestion_method: "text_upload",
      original_filename: "founders.txt",
      source_url: null,
      created_at: "2026-09-01T00:00:00.000Z",
    },
    source: {
      id: `source-${id}`,
      title: "founders-433-michael-bloomberg",
      source_type: "podcast",
      external_url: null,
      published_at: null,
    },
    people: [{ id: "p-senra", name: "David Senra", role: "host" }],
    ...overrides,
  };
}

const results = [
  result("1", "Bloomberg writes: don't devise a five-year plan."),
  result("2", "He was fired from Salomon Brothers after fifteen years."),
  result("3", "Napoleon read constantly on campaign."),
];

describe("buildEvidence", () => {
  it("numbers passages 1..N in retrieval order", () => {
    const evidence = buildEvidence(results);
    expect(evidence.map((e) => [e.number, e.result.passage.id])).toEqual([
      [1, "passage-1"],
      [2, "passage-2"],
      [3, "passage-3"],
    ]);
  });
});

describe("buildAnswerPrompt", () => {
  it("is deterministic", () => {
    const a = buildAnswerPrompt("What about plans?", buildEvidence(results));
    const b = buildAnswerPrompt("What about plans?", buildEvidence(results.map((r) => structuredClone(r))));
    expect(a).toEqual(b);
  });

  it("uses a fixed system prompt with no request data in it", () => {
    const { system } = buildAnswerPrompt("What about plans?", buildEvidence(results));
    expect(system).toBe(ANSWER_SYSTEM_PROMPT);
    expect(system).not.toContain("plans?");
    expect(system).toContain(INSUFFICIENT_EVIDENCE_MARKER);
  });

  it("sends the full passage text, never the search snippet", () => {
    const { prompt } = buildAnswerPrompt("q", buildEvidence(results));
    for (const r of results) {
      expect(prompt).toContain(`<passage>\n${r.passage.text}\n</passage>`);
      expect(prompt).not.toContain(r.snippet);
    }
  });

  it("lists every evidence block in order and puts the question last", () => {
    const { prompt } = buildAnswerPrompt("What did Bloomberg say about five-year plans?", buildEvidence(results));
    const positions = [1, 2, 3].map((n) => prompt.indexOf(`<evidence number="${n}">`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(prompt.endsWith("Question: What did Bloomberg say about five-year plans?")).toBe(true);
  });
});

describe("formatEvidence attribution metadata", () => {
  it("separates the source's voices from people who are only discussed", () => {
    const block = formatEvidence({
      number: 4,
      result: result("4", "Bloomberg built terminals.", {
        people: [
          { id: "p1", name: "David Senra", role: "host" },
          { id: "p2", name: "Michael Bloomberg", role: "subject" },
        ],
      }),
    });
    expect(block).toBe(
      [
        '<evidence number="4">',
        "Source: founders-433-michael-bloomberg",
        "Source type: podcast",
        "Voice: David Senra (host)",
        "Discussed: Michael Bloomberg (subject)",
        "Passage position: 4 in its document",
        "<passage>",
        "Bloomberg built terminals.",
        "</passage>",
        "</evidence>",
      ].join("\n")
    );
  });

  it("says when no people are recorded", () => {
    const block = formatEvidence({ number: 1, result: result("1", "Text.", { people: [] }) });
    expect(block).toContain("Voice: none recorded\nDiscussed: none recorded");
  });

  it("formats a DATE published_at without depending on locale or time zone", () => {
    const source = { ...result("1", "t").source, published_at: new Date(2024, 2, 5) as unknown as string };
    expect(formatEvidence({ number: 1, result: result("1", "t", { source }) })).toContain("Published: 2024-03-05");
  });

  it("instructs the model not to attribute a host's narration to the person discussed", () => {
    expect(ANSWER_SYSTEM_PROMPT).toContain("they are not speaking in the source");
    expect(ANSWER_SYSTEM_PROMPT).toContain("Do not use outside or general knowledge");
  });
});

describe("parseCitationNumbers", () => {
  it("returns unique numbers in order of first appearance", () => {
    expect(parseCitationNumbers("A [2]. B [1][2]. C [3, 1]. D [ 4 ].")).toEqual([2, 1, 3, 4]);
  });

  it("ignores bracketed text that is not a citation", () => {
    expect(parseCitationNumbers("He [sic] wrote [a] note [1a] [].")).toEqual([]);
  });

  it("parses zero and out-of-range numbers so they can be rejected", () => {
    expect(parseCitationNumbers("[0] [99]")).toEqual([0, 99]);
  });
});

describe("resolveCitations", () => {
  const evidence = buildEvidence(results);

  it("maps each number to the passage supplied under that number, with full provenance", () => {
    const citations = resolveCitations([3, 1], evidence);
    expect(citations.map((c) => [c.number, c.passage.id])).toEqual([
      [3, "passage-3"],
      [1, "passage-1"],
    ]);
    expect(citations[0]).toEqual({
      number: 3,
      passage: results[2].passage,
      document: results[2].document,
      source: results[2].source,
      people: results[2].people,
    });
  });

  it.each([[[0]], [[4]], [[1, 7]]])("rejects numbers that were not supplied: %j", (numbers) => {
    expect(() => resolveCitations(numbers, evidence)).toThrow(InvalidModelResponseError);
  });

  it("names the invalid numbers in the error", () => {
    expect(() => resolveCitations([2, 5, 9], evidence)).toThrow(/\[5\], \[9\] \(valid: 1-3\)/);
  });
});
