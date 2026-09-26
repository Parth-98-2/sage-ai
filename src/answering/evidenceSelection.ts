import type { SearchResult } from "../retrieval/types";

/**
 * Experimental, deterministic evidence selection (V1): picks the passages the
 * answer model sees from the hybrid retrieval candidates, without a model call.
 *
 * Hybrid ranking can bury a passage whose only link to the question is one
 * rare phrase (Q1: the single passage containing "five-year" ranked 9th,
 * behind passages that merely repeat "Bloomberg"). A second, rare-word
 * ranking scores each candidate by the question terms it contains, weighted
 * by how few candidates contain them; selection alternates between the two
 * rankings so each contributes its best passages.
 */

/** Words that carry no topic in a question; neither side counts them. */
const STOPWORDS = new Set(
  (
    "a an the this that these those it its he she they them his her their we our you your i me my " +
    "in on at as by for from to of with and but or nor so if then than when while after before because " +
    "also however both each one what who whom why how where which there here not no yes all some any most many more " +
    "such only even just do does did done doing be is are was were been being have has had having " +
    "say said says about according material suggest suggests should would could can will into"
  ).split(" ")
);

const WORD = /[a-z0-9]+(?:[-'][a-z0-9]+)*/g;

/** Crude suffix stripping, applied identically to question and passages: "plans" and "plan" meet. */
function stem(word: string): string {
  const base = word.replace(/'s$/, "").replace(/ies$/, "y");
  return base.replace(/(?:ing|ed|es|s)$/, (suffix) => (word.length - suffix.length >= 3 ? "" : suffix));
}

/**
 * The distinct stemmed, stopword-free terms of `text`. A hyphenated word
 * yields itself and its parts, so "five-year" matches "five-year" and "five year".
 */
export function selectionTerms(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'");
  const terms = new Set<string>();
  for (const [token] of normalized.matchAll(WORD)) {
    for (const word of token.includes("-") ? [token, ...token.split("-")] : [token]) {
      if (word.length > 1 && !STOPWORDS.has(word)) terms.add(stem(word));
    }
  }
  return terms;
}

/**
 * Each text's rare-word score for `question`: the sum, over the question
 * terms it contains, of ln((N + 1) / df), where df is how many of the N texts
 * contain the term. A term in every text adds the same small amount to all of
 * them, so it never changes their order. Presence counts, not repetition.
 */
export function rareWordScores(question: string, texts: string[]): number[] {
  const queryTerms = [...selectionTerms(question)];
  const textTerms = texts.map(selectionTerms);
  const weights = queryTerms.map((term) => {
    const df = textTerms.filter((terms) => terms.has(term)).length;
    return df === 0 ? 0 : Math.log((texts.length + 1) / df);
  });
  return textTerms.map((terms) => queryTerms.reduce((sum, term, i) => sum + (terms.has(term) ? weights[i] : 0), 0));
}

/**
 * Chooses `k` of the hybrid-ranked `candidates` by alternating hybrid rank 1,
 * rare-word rank 1, hybrid rank 2, rare-word rank 2, ..., skipping passages
 * already chosen. Rare-word ties keep hybrid order, so when no candidate
 * contains a question term the result is the hybrid top k. With k or fewer
 * candidates they are returned as they are. Candidate objects are returned
 * as is, never copied or changed.
 */
export function selectEvidence(question: string, candidates: readonly SearchResult[], k: number): SearchResult[] {
  if (candidates.length <= k) return [...candidates];

  const scores = rareWordScores(question, candidates.map((candidate) => candidate.passage.text));
  const rareOrder = candidates
    .map((candidate, index) => ({ candidate, index, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ candidate }) => candidate);

  const selected: SearchResult[] = [];
  for (let rank = 0; selected.length < k; rank++) {
    for (const candidate of [candidates[rank], rareOrder[rank]]) {
      if (selected.length < k && !selected.includes(candidate)) selected.push(candidate);
    }
  }
  return selected;
}
