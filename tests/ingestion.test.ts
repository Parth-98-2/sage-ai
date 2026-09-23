import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool";
import { ingestText } from "../src/ingestion/ingestionService";
import { getDocumentWithPassages } from "../src/ingestion/repository";

const sampleText = `${"alpha ".repeat(400).trim()}\n\n${"beta ".repeat(400).trim()}`;

beforeEach(async () => {
  await pool.query("TRUNCATE passages, source_people, documents, sources, people RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function baseInput(overrides: Partial<Parameters<typeof ingestText>[0]> = {}) {
  return {
    rawText: sampleText,
    suggestedTitle: "Test Source",
    sourceType: "essay",
    personName: "Ada Lovelace",
    personRole: "author",
    ingestionMethod: "text_upload",
    originalFilename: "test.txt",
    mimeType: "text/plain",
    ...overrides,
  };
}

describe("ingestText", () => {
  it("creates a Person, Source, Document, and Passages", async () => {
    const result = await ingestText(baseInput());

    expect(result.person.name).toBe("Ada Lovelace");
    expect(result.source.title).toBe("Test Source");
    expect(result.source.source_type).toBe("essay");
    expect(result.document.raw_text).toBe(sampleText);
    expect(result.document.source_id).toBe(result.source.id);
    expect(result.passages.length).toBe(2);
  });

  it("orders passages by ordinal starting at 0", async () => {
    const result = await ingestText(baseInput());
    result.passages.forEach((passage, index) => {
      expect(passage.ordinal).toBe(index);
    });
  });

  it("stores char_start/char_end that correctly slice the original raw_text", async () => {
    const result = await ingestText(baseInput());
    for (const passage of result.passages) {
      expect(sampleText.slice(passage.char_start, passage.char_end)).toBe(passage.text);
    }
  });

  it("retrieves the document and its passages via getDocumentWithPassages", async () => {
    const result = await ingestText(baseInput());
    const fetched = await getDocumentWithPassages(result.document.id);

    expect(fetched).not.toBeNull();
    expect(fetched?.document.id).toBe(result.document.id);
    expect(fetched?.passages.length).toBe(result.passages.length);
    expect(fetched?.passages.map((p) => p.ordinal)).toEqual([0, 1]);
  });

  it("reuses the same Person and Source when ingesting a second document for them", async () => {
    const first = await ingestText(baseInput());
    const second = await ingestText(baseInput());

    expect(second.person.id).toBe(first.person.id);
    expect(second.source.id).toBe(first.source.id);
    expect(second.document.id).not.toBe(first.document.id);
  });

  it("rejects empty rawText", async () => {
    await expect(ingestText(baseInput({ rawText: "   " }))).rejects.toThrow();
  });

  it("rejects an invalid sourceType", async () => {
    await expect(ingestText(baseInput({ sourceType: "not-a-real-type" }))).rejects.toThrow();
  });
});
