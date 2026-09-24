import { InvalidModelResponseError, type Citation, type Evidence } from "./types";

/** A citation group: [3] or [1, 4]. Any other bracketed text is not a citation. */
const CITATION_GROUP = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;

/** The evidence numbers cited in `text`, unique, in order of first appearance. */
export function parseCitationNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(CITATION_GROUP)) {
    for (const part of match[1].split(",")) seen.add(Number(part.trim()));
  }
  return [...seen];
}

/**
 * Maps cited numbers to the evidence actually supplied to the model. A
 * number that was not supplied means the model invented a source, so the
 * whole response is rejected rather than silently repaired.
 */
export function resolveCitations(numbers: number[], evidence: Evidence[]): Citation[] {
  const byNumber = new Map(evidence.map((item) => [item.number, item.result]));
  const invalid = numbers.filter((number) => !byNumber.has(number));
  if (invalid.length > 0) {
    throw new InvalidModelResponseError(
      `model cited evidence that was not supplied: ${invalid.map((n) => `[${n}]`).join(", ")} (valid: 1-${evidence.length})`
    );
  }
  return numbers.map((number) => {
    const result = byNumber.get(number)!;
    return { number, passage: result.passage, document: result.document, source: result.source, people: result.people };
  });
}
