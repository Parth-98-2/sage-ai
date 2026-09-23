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

function extractParagraphs(rawText: string): Range[] {
  const paragraphs: Range[] = [];
  let match: RegExpExecArray | null;
  PARAGRAPH_REGEX.lastIndex = 0;
  while ((match = PARAGRAPH_REGEX.exec(rawText)) !== null) {
    paragraphs.push({ start: match.index, end: match.index + match[0].length });
  }
  return paragraphs;
}

function splitRangeIntoWordWindows(rawText: string, range: Range, targetTokens: number): Range[] {
  const slice = rawText.slice(range.start, range.end);
  const words: Range[] = [];
  let match: RegExpExecArray | null;
  WORD_REGEX.lastIndex = 0;
  while ((match = WORD_REGEX.exec(slice)) !== null) {
    words.push({ start: range.start + match.index, end: range.start + match.index + match[0].length });
  }

  const windows: Range[] = [];
  for (let i = 0; i < words.length; i += targetTokens) {
    const group = words.slice(i, i + targetTokens);
    windows.push({ start: group[0].start, end: group[group.length - 1].end });
  }
  return windows;
}

function makeChunk(rawText: string, range: Range): Chunk {
  const text = rawText.slice(range.start, range.end);
  return { text, charStart: range.start, charEnd: range.end, tokenCount: countTokens(text) };
}

/**
 * Splits raw text into ~targetTokens-sized passages, preferring paragraph
 * boundaries. A paragraph much longer than the target (e.g. a transcript
 * with no blank-line breaks) falls back to fixed-size word windows.
 * Every returned chunk's `text` is exactly rawText.slice(charStart, charEnd).
 */
export function chunkText(rawText: string, targetTokens = 500): Chunk[] {
  const paragraphs = extractParagraphs(rawText);

  const units: Range[] = [];
  for (const paragraph of paragraphs) {
    const tokenCount = countTokens(rawText.slice(paragraph.start, paragraph.end));
    if (tokenCount > targetTokens * 1.5) {
      units.push(...splitRangeIntoWordWindows(rawText, paragraph, targetTokens));
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
