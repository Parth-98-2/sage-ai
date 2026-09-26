import { describe, expect, it } from "vitest";
import { checkAnswerSupport, parseCitationNumbers, resolveCitations } from "../src/answering/citations";
import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerPrompt,
  buildEvidence,
  formatEvidence,
  INSUFFICIENT_EVIDENCE_MARKER,
  SOURCES_HEADING,
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

  it("requires citations in source-backed answers but none in an insufficient-evidence reply", () => {
    expect(ANSWER_SYSTEM_PROMPT).toContain(
      "Every sentence in the FROM THE SOURCES section must cite the passage or passages that support it, using the evidence number in square brackets, e.g. [2] or [1][4]."
    );
    const rule = ANSWER_SYSTEM_PROMPT.split("\n").find((line) => line.includes(`reply with ${INSUFFICIENT_EVIDENCE_MARKER} on the first line`));
    expect(rule).toContain("This reply is not a source-backed answer: it contains no citations, so write no evidence numbers and no square brackets in it.");
    expect(rule).not.toMatch(/\bcit(e|ing)\b/);
  });

  it("requires a citation on every source sentence, never one citation for a paragraph", () => {
    for (const rule of [
      "Cite sentence by sentence. Each sentence must end with its own citation, even when several sentences come from the same passage.",
      "A citation supports only the sentence it ends; it never covers the sentences before it.",
      "Never put a single citation at the end of a paragraph of several sentences.",
      'Three source sentences need three citations: "Sentence one. [9] Sentence two. [9] Sentence three. [9]".',
      "Prefer short sentences that each state one claim from the evidence. Do not combine several claims into a paragraph and cite it once at the end.",
      'Every sentence ends with its own citation, e.g. "Sentence one. [9] Sentence two. [9]"; never one citation for several sentences.',
    ]) {
      expect(ANSWER_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it("keeps the attribution and APPLICATION rules", () => {
    expect(ANSWER_SYSTEM_PROMPT).toContain("When a host or author recounts, paraphrases or reads from another person's writing, say so.");
    expect(ANSWER_SYSTEM_PROMPT).toContain(
      "<Only if the question asks how the evidence applies to the asker's situation: your reasoning from the material above. No evidence numbers here. Do not name any person, company, product or number that is not in the evidence or the question.>"
    );
    expect(ANSWER_SYSTEM_PROMPT).toContain("Leave out the APPLICATION section when the question does not ask for application.");
  });

  it("requires third-person attribution or a named speaker for first-person source words", () => {
    expect(ANSWER_SYSTEM_PROMPT).toContain(
      "- Write the FROM THE SOURCES section in the third person. Never present a passage's first-person words (I, me, my, we, us, our) as your own. " +
        'Either restate them in the third person ("Bloomberg describes his advances as evolutionary rather than revolutionary. [9]") ' +
        `or keep them and name the speaker in the same sentence ("Senra reads from Bloomberg's book: every significant advance I or my companies ever made has been evolutionary. [9]").`
    );
    // The per-sentence citation and insufficient-evidence rules are unchanged.
    expect(ANSWER_SYSTEM_PROMPT).toContain("Cite sentence by sentence. Each sentence must end with its own citation");
    expect(ANSWER_SYSTEM_PROMPT).toContain("This reply is not a source-backed answer: it contains no citations");
  });
});

describe("checkAnswerSupport per-sentence citations", () => {
  // The live Bloomberg failure: the five-year-plan passage was supplied as evidence [9].
  const PASSAGE =
    "Don't devise a five-year plan or a great leap forward. central planning didn't work for Stalin or Mao, and it won't work for an entrepreneur either. " +
    "Every significant advance I or my companies ever made has been evolutionary rather than revolutionary. Small earned steps, not big lucky hits.";
  const evidence = buildEvidence([
    ...Array.from({ length: 8 }, (_, i) => result(String(i + 1), `Unrelated passage ${i + 1}.`)),
    result("9", PASSAGE),
  ]);
  const sources = (text: string) => ({ sources: text, application: null });
  const [one, two, three] = [
    "Central planning didn't work for Stalin or Mao, and it won't work for an entrepreneur either.",
    // First-person words need a named speaker (see the attribution tests below).
    "Senra reads that every significant advance I or my companies ever made has been evolutionary rather than revolutionary.",
    "Small earned steps, not big lucky hits.",
  ];

  it("rejects one citation at the end of a three-sentence paragraph (the live failure)", () => {
    expect(() => checkAnswerSupport(sources(`${one} ${two} ${three} [9]`), evidence, "q")).toThrow(InvalidModelResponseError);
    expect(() => checkAnswerSupport(sources(`${one} ${two} ${three} [9]`), evidence, "q")).toThrow(
      `source sentence has no citation: ${JSON.stringify(one)}`
    );
  });

  it("rejects a paragraph where only some sentences carry their own citation", () => {
    expect(() => checkAnswerSupport(sources(`${one} [9] ${two} ${three} [9]`), evidence, "q")).toThrow(
      `source sentence has no citation: ${JSON.stringify(two)}`
    );
  });

  it("accepts the same three sentences when each ends with its own citation", () => {
    expect(() => checkAnswerSupport(sources(`${one} [9] ${two} [9] ${three} [9]`), evidence, "q")).not.toThrow();
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

describe("checkAnswerSupport across adjacent passages", () => {
  // A story split across passages: the customer is named only in the first,
  // what their traders did only in the second (which says "they", not "Merrill").
  const evidence = buildEvidence([
    result("1", "When we first installed it, Merrill assigned two traders to work with us."),
    result("2", "When they said something didn't work, they could show us. Every day, our system got better as we fixed each problem they pointed out."),
  ]);
  const sources = (text: string) => ({ sources: text, application: null });

  it("accepts a sentence whose name comes from one cited passage and whose action comes from another", () => {
    expect(() =>
      checkAnswerSupport(sources("Merrill assigned two traders, and every day Bloomberg fixed each problem they pointed out [1][2]."), evidence, "q")
    ).not.toThrow();
  });

  it("rejects a name that appears only in a passage the sentence does not cite", () => {
    expect(() => checkAnswerSupport(sources("Merrill's traders showed where it didn't work [2]."), evidence, "q")).toThrow(
      /sentence cites \[2\] but "Merrill" does not appear in the cited evidence/
    );
  });
});

describe("checkAnswerSupport first-person attribution", () => {
  // An exact excerpt of the real Q1 evidence [9]: Bloomberg passage #6, a podcast whose only recorded person is its host.
  const Q1_PASSAGE =
    "Take lots of chances and make lots of individual spur-of-the-moment decisions. This is such a great line. Don't devise a five-year plan or a great leap forward. " +
    "central planning didn't work for Stalin or Mao, and it won't work for an entrepreneur either. Every significant advance I or my companies ever made has been " +
    "evolutionary rather than revolutionary. Small earned steps, not big lucky hits. I stay flexible. A reporter asked me what we at Bloomberg had failed at.";
  const q1Source = { ...result("9", "").source, title: "Founders #433 - How Michael Bloomberg Works (Clean)" };
  const evidence = buildEvidence([
    result("1", "Napoleon read constantly on campaign."),
    ...Array.from({ length: 7 }, (_, i) => result(String(i + 2), `Unrelated passage ${i + 2}.`)),
    result("9", Q1_PASSAGE, { source: q1Source }),
  ]);
  const check = (sources: string, application: string | null = null) => () => checkAnswerSupport({ sources, application }, evidence, "q");

  // The real llama3.1:8b Q1 answer, which passed before this check existed.
  const LLAMA_Q1 = [
    "Central planning didn't work for Stalin or Mao, and it won't work for an entrepreneur either. [9]",
    "Every significant advance I or my companies ever made has been evolutionary rather than revolutionary. [9]",
    "Don't devise a five-year plan or a great leap forward. [9]",
  ].join("\n");

  it("rejects the real Q1 answer's unattributed first-person sentence", () => {
    expect(check(LLAMA_Q1)).toThrow(
      'source sentence uses first-person words ("I", "my") without naming who is speaking: ' +
        '"Every significant advance I or my companies ever made has been evolutionary rather than revolutionary. [9]"'
    );
  });

  it("accepts the attributed version of the Q1 answer", () => {
    expect(
      check(
        "Bloomberg said that central planning didn't work for Stalin or Mao and wouldn't work for an entrepreneur either. [9] " +
          "He described his advances as evolutionary rather than revolutionary. [9] " +
          "He also said, 'Don't devise a five-year plan or a great leap forward.' [9]"
      )
    ).not.toThrow();
  });

  it("accepts first-person words with a recorded person named as the speaker", () => {
    expect(check("Senra reads from Bloomberg's book: every significant advance I or my companies ever made has been evolutionary. [9]")).not.toThrow();
  });

  it("accepts a speaker the cited passage names mid-sentence, though not a recorded person", () => {
    expect(check("Bloomberg writes that every significant advance I or my companies ever made has been evolutionary. [9]")).not.toThrow();
  });

  it("accepts a speaker given as a line label", () => {
    expect(check("Bloomberg: every significant advance I or my companies ever made has been evolutionary. [9]")).not.toThrow();
  });

  it("does not take speaker names from the source title", () => {
    expect(check("Founders says every significant advance I or my companies ever made has been evolutionary. [9]")).toThrow(
      /without naming who is speaking/
    );
    expect(check("Works says every significant advance I or my companies ever made has been evolutionary. [9]")).toThrow(
      /without naming who is speaking/
    );
  });

  it("does not take speaker names from a capital that only starts a sentence in the passage", () => {
    // "Take" and "Small" open sentences of the passage; they are not names.
    expect(check("Small says every significant advance I or my companies ever made has been evolutionary. [9]")).toThrow(
      /without naming who is speaking/
    );
  });

  it("rejects a speaker named only in a passage the sentence does not cite", () => {
    expect(check("Napoleon says every significant advance I or my companies ever made has been evolutionary. [9]")).toThrow(
      InvalidModelResponseError
    );
  });

  it("rejects a pronoun standing in for the speaker", () => {
    expect(check("He wrote: every significant advance I or my companies ever made has been evolutionary. [9]")).toThrow(
      /without naming who is speaking/
    );
  });

  it("flags we, our and a capitalised My, but not the all-capitals US", () => {
    const small = buildEvidence([result("1", "Terminals sold well in the US market, and we at Bloomberg kept building them for our customers.")]);
    const one = (sources: string) => () => checkAnswerSupport({ sources, application: null }, small, "q");
    expect(one("Terminals sold well in the US market. [1]")).not.toThrow();
    expect(one("We kept building them. [1]")).toThrow('source sentence uses first-person words ("We")');
    expect(one("Terminals were built for our customers. [1]")).toThrow('source sentence uses first-person words ("our")');
    expect(one("My terminals sold well. [1]")).toThrow('source sentence uses first-person words ("My")');
    expect(one("Senra says we kept building them for our customers. [1]")).not.toThrow();
  });

  it("does not apply to the APPLICATION section", () => {
    expect(check("Bloomberg advised against a five-year plan. [9]", "I would plan only the next few steps.")).not.toThrow();
  });

  it("leaves the existing checks in front of it", () => {
    expect(check("Every significant advance I or my companies ever made has been evolutionary.")).toThrow(/^source sentence has no citation/);
    expect(check("Bloomberg writes that every advance I made was evolutionary. [42]")).toThrow(/sentence cites \[42\] but "Bloomberg"/);
    expect(check("Like AppLovin, Bloomberg said every advance I made was evolutionary. [9]")).toThrow(/"Like", "AppLovin" do not appear in the cited evidence/);
  });
});
