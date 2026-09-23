import { describe, expect, it } from "vitest";
import { chunkText } from "../src/ingestion/chunker";

describe("chunkText", () => {
  it("returns an empty array for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("produces chunks whose text exactly matches rawText.slice(charStart, charEnd)", () => {
    const rawText =
      "Paragraph one line one.\nParagraph one line two.\n\n" +
      "Paragraph two.\n\n" +
      "word ".repeat(600).trim();

    const chunks = chunkText(rawText, 500);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(rawText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("produces non-overlapping chunks in increasing order", () => {
    const rawText = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}. `.repeat(80)).join("\n\n");
    const chunks = chunkText(rawText, 500);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charStart).toBeGreaterThanOrEqual(chunks[i - 1].charEnd);
    }
  });

  it("splits a single very long paragraph using word windows", () => {
    const rawText = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(rawText, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(rawText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("keeps short paragraphs packed under the token target", () => {
    const rawText = Array.from({ length: 3 }, (_, i) => `Short paragraph ${i}.`).join("\n\n");
    const chunks = chunkText(rawText, 500);
    expect(chunks.length).toBe(1);
    expect(chunks[0].tokenCount).toBeLessThanOrEqual(500);
  });
});
