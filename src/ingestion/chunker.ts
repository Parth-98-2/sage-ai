export interface Chunk {
  text: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

interface Range {
  start: number;
  end: number;
}

const PARAGRAPH_REGEX = /[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]*)*/g;
const LINE_REGEX = /[^\r\n]+/g;
const WORD_REGEX = /\S+/g;

/**
 * token_count is a whitespace word-count approximation, not a true
 * BPE/LLM tokenizer count. Real tokenization is deferred to the
 * embeddings step, which isn't built yet.
 */
function countTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function matchRanges(rawText: string, range: Range, regex: RegExp): Range[] {
  const slice = rawText.slice(range.start, range.end);
  const ranges: Range[] = [];
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(slice)) !== null) {
    ranges.push({ start: range.start + match.index, end: range.start + match.index + match[0].length });
  }
  return ranges;
}

/** Shrinks a range to its non-whitespace bounds; null if it is all whitespace. */
function trimRange(rawText: string, range: Range): Range | null {
  let { start, end } = range;
  while (start < end && /\s/.test(rawText[start])) start++;
  while (end > start && /\s/.test(rawText[end - 1])) end--;
  return start < end ? { start, end } : null;
}

function splitRangeIntoWordWindows(rawText: string, range: Range, targetTokens: number): Range[] {
  const words = matchRanges(rawText, range, WORD_REGEX);
  const windows: Range[] = [];
  for (let i = 0; i < words.length; i += targetTokens) {
    const group = words.slice(i, i + targetTokens);
    windows.push({ start: group[0].start, end: group[group.length - 1].end });
  }
  return windows;
}

/**
 * Breaks an oversized paragraph into lines (e.g. transcript speaker turns
 * separated by single newlines). Only a line that is itself oversized falls
 * back to fixed-size word windows.
 */
function splitOversizedParagraph(rawText: string, paragraph: Range, targetTokens: number): Range[] {
  const units: Range[] = [];
  for (const line of matchRanges(rawText, paragraph, LINE_REGEX)) {
    const trimmed = trimRange(rawText, line);
    if (!trimmed) continue;
    if (countTokens(rawText.slice(trimmed.start, trimmed.end)) > targetTokens * 1.5) {
      units.push(...splitRangeIntoWordWindows(rawText, trimmed, targetTokens));
    } else {
      units.push(trimmed);
    }
  }
  return units;
}

function makeChunk(rawText: string, range: Range): Chunk {
  const text = rawText.slice(range.start, range.end);
  return { text, charStart: range.start, charEnd: range.end, tokenCount: countTokens(text) };
}

/**
 * Splits raw text into ~targetTokens-sized passages, preferring paragraph
 * boundaries, then line boundaries within a paragraph much longer than the
 * target, and only then fixed-size word windows. Chunks never start or end
 * with whitespace, and every returned chunk's `text` is exactly
 * rawText.slice(charStart, charEnd).
 */
export function chunkText(rawText: string, targetTokens = 500): Chunk[] {
  const units: Range[] = [];
  for (const match of matchRanges(rawText, { start: 0, end: rawText.length }, PARAGRAPH_REGEX)) {
    const paragraph = trimRange(rawText, match);
    if (!paragraph) continue;
    const tokenCount = countTokens(rawText.slice(paragraph.start, paragraph.end));
    if (tokenCount > targetTokens * 1.5) {
      units.push(...splitOversizedParagraph(rawText, paragraph, targetTokens));
    } else {
      units.push(paragraph);
    }
  }

  const chunks: Chunk[] = [];
  let current: Range | null = null;
  let currentTokens = 0;

  for (const unit of units) {
    const unitTokens = countTokens(rawText.slice(unit.start, unit.end));
    if (current === null) {
      current = { ...unit };
      currentTokens = unitTokens;
    } else if (currentTokens + unitTokens <= targetTokens) {
      current.end = unit.end;
      currentTokens += unitTokens;
    } else {
      chunks.push(makeChunk(rawText, current));
      current = { ...unit };
      currentTokens = unitTokens;
    }
  }
  if (current !== null) {
    chunks.push(makeChunk(rawText, current));
  }

  return chunks;
}
