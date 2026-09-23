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

  it("splits a long single-newline transcript at line boundaries, not mid-turn", () => {
    const words = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");
    const lines = Array.from({ length: 200 }, (_, i) => `${i % 2 ? "GUEST" : "HOST"}: ${words}.`);
    const rawText = lines.join("\n");

    const chunks = chunkText(rawText, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(rawText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
      expect(chunk.tokenCount).toBeLessThanOrEqual(500);
      expect(chunk.text).toMatch(/^(HOST|GUEST): /);
      expect(chunk.text.endsWith(`${words}.`)).toBe(true);
    }
    expect(chunks.map((c) => c.text).join("\n")).toBe(rawText);
  });

  it("falls back to word windows only for an oversized line inside a long paragraph", () => {
    const longLine = Array.from({ length: 1200 }, (_, i) => `long${i}`).join(" ");
    const rawText = `Intro line.\n${longLine}\nClosing line.`;

    const chunks = chunkText(rawText, 500);
    // Lines are packed as units: "Intro line." cannot fit beside a full
    // 500-word window, and "Closing line." fits after the 200-word remainder.
    expect(chunks.map((c) => c.tokenCount)).toEqual([2, 500, 500, 202]);
    expect(chunks[0].text).toBe("Intro line.");
    expect(chunks[1].text.startsWith("long0 ")).toBe(true);
    expect(chunks[3].text.endsWith("long1199\nClosing line.")).toBe(true);
    for (const chunk of chunks) {
      expect(rawText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("never produces chunks that start or end with whitespace, or whitespace-only chunks", () => {
    const longParagraph = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const rawText = `   ${longParagraph}   \n   \n\n  Tail paragraph.  \n\n   \n`;

    const chunks = chunkText(rawText, 500);
    expect(chunks.map((c) => c.text)).toEqual([longParagraph, "Tail paragraph."]);
    for (const chunk of chunks) {
      expect(rawText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("returns no chunks for whitespace-only text", () => {
    expect(chunkText("  \n\n \t \n")).toEqual([]);
  });

  it("keeps short paragraphs packed under the token target", () => {
    const rawText = Array.from({ length: 3 }, (_, i) => `Short paragraph ${i}.`).join("\n\n");
    const chunks = chunkText(rawText, 500);
    expect(chunks.length).toBe(1);
    expect(chunks[0].tokenCount).toBeLessThanOrEqual(500);
  });
});
