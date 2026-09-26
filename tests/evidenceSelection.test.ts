import { describe, expect, it } from "vitest";
import { rareWordScores, selectEvidence } from "../src/answering/evidenceSelection";
import type { SearchResult } from "../src/retrieval/types";

/** A hybrid candidate with only what selection reads filled in meaningfully. */
function candidate(id: string, text: string): SearchResult {
  return {
    passage: { id, ordinal: 0, text, char_start: 0, char_end: text.length, token_count: 0 },
    snippet: "",
    score: 0,
    document: { id: `doc-${id}`, ingestion_method: "text_upload", original_filename: null, source_url: null, created_at: "2026-01-01" },
    source: { id: `src-${id}`, title: "Founders", source_type: "podcast", external_url: null, published_at: null },
    people: [],
  };
}

/** `count` candidates that share only filler words, ids c1..cN in hybrid order. */
function fillers(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, i) => candidate(`c${i + 1}`, `Senra talks about the episode, part ${i + 1}.`));
}

const ids = (results: SearchResult[]) => results.map((result) => result.passage.id);

const Q1 = "What did Michael Bloomberg say about five-year plans?";
const Q1_PASSAGE =
  "It is said that 80% of life is just showing up. Both at business and at home, I've never let planning get in the way of doing. " +
  "Don't devise a five-year plan or a great leap forward.";

/** Twenty Q1 candidates: filler repeating the common question words, and the five-year passage at hybrid rank 9. */
function q1Candidates(): SearchResult[] {
  const filler = Array.from({ length: 20 }, (_, i) =>
    candidate(`b${i + 1}`, `Michael Bloomberg said Bloomberg says Bloomberg would say, year after year, part ${i + 1}.`)
  );
  filler[8] = candidate("five-year", Q1_PASSAGE);
  return filler;
}

describe("selectEvidence", () => {
  it.each([0, 1, 3, 4])("returns %i candidates (k or fewer) unchanged and in order", (count) => {
    const candidates = fillers(count);
    const selected = selectEvidence("five-year plans", candidates, 4);
    expect(ids(selected)).toEqual(ids(candidates));
    selected.forEach((result, i) => expect(result).toBe(candidates[i]));
  });

  it("selects exactly 4 of 20 candidates, without duplicates", () => {
    const selected = selectEvidence(Q1, q1Candidates(), 4);
    expect(selected).toHaveLength(4);
    expect(new Set(ids(selected)).size).toBe(4);
  });

  it("returns the original candidate objects, neither copied nor changed", () => {
    const candidates = q1Candidates();
    const before = JSON.stringify(candidates);
    const selected = selectEvidence(Q1, candidates, 4);
    for (const result of selected) expect(candidates).toContain(result);
    expect(JSON.stringify(candidates)).toBe(before);
  });

  it("Q1: selects the five-year passage, at hybrid rank 9, within the first 2", () => {
    const selected = selectEvidence(Q1, q1Candidates(), 4);
    expect(ids(selected).slice(0, 2)).toContain("five-year");
  });

  it("gives a word in every candidate no discriminating weight, however often a passage repeats it", () => {
    const candidates = [
      candidate("a", "Bloomberg built a terminal."),
      candidate("b", "Bloomberg, Bloomberg, Bloomberg, Bloomberg."),
      candidate("c", "Bloomberg ran for mayor."),
      candidate("d", "Bloomberg gave to charity."),
      candidate("e", "Bloomberg was fired."),
    ];
    const scores = rareWordScores("Bloomberg", candidates.map((c) => c.passage.text));
    expect(new Set(scores).size).toBe(1);
    expect(ids(selectEvidence("Bloomberg", candidates, 4))).toEqual(["a", "b", "c", "d"]);
  });

  it("always selects hybrid ranks 1 and 2, even when both have no rare-word score", () => {
    const candidates = fillers(20);
    candidates[10] = candidate("rare-1", "Napoleon read a travelling library.");
    candidates[15] = candidate("rare-2", "Napoleon kept a library on campaign.");
    const selected = selectEvidence("Napoleon library", candidates, 4);
    expect(ids(selected)).toEqual(["c1", "rare-1", "c2", "rare-2"]);
  });

  it("falls back to the hybrid top k when no candidate contains a question term", () => {
    const candidates = fillers(20);
    expect(ids(selectEvidence("What did Napoleon read?", candidates, 4))).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it('matches "five-year plans" to both "five-year plan" and "five year plan"', () => {
    const texts = ["Never devise a five-year plan.", "Never devise a five year plan.", "Senra talks about the episode."];
    const [hyphenated, spaced, unrelated] = rareWordScores("five-year plans", texts);
    expect(hyphenated).toBeGreaterThan(0);
    expect(spaced).toBeGreaterThan(0);
    expect(unrelated).toBe(0);

    const candidates = fillers(20);
    candidates[12] = candidate("hyphenated", texts[0]);
    candidates[17] = candidate("spaced", texts[1]);
    expect(ids(selectEvidence("five-year plans", candidates, 4))).toEqual(["c1", "hyphenated", "c2", "spaced"]);
  });

  it("returns identical output for identical input", () => {
    const first = selectEvidence(Q1, q1Candidates(), 4);
    const second = selectEvidence(Q1, q1Candidates(), 4);
    expect(ids(second)).toEqual(ids(first));
  });

  it("breaks rare-word ties by hybrid order", () => {
    const candidates = fillers(20);
    candidates[6] = candidate("tie-rank-7", "Napoleon read constantly.");
    candidates[4] = candidate("tie-rank-5", "Napoleon read on campaign.");
    candidates[13] = candidate("tie-rank-14", "Napoleon read at night.");
    const selected = selectEvidence("What did Napoleon read?", candidates, 4);
    expect(ids(selected)).toEqual(["c1", "tie-rank-5", "c2", "tie-rank-7"]);
  });
});
