import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool";
import { ingestText } from "../src/ingestion/ingestionService";
import { getDocumentWithPassages } from "../src/ingestion/repository";
import { ValidationError } from "../src/ingestion/types";

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
    const second = await ingestText(baseInput({ rawText: "A second, different document." }));

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

async function countRows(table: "documents" | "passages"): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
  return result.rows[0].count;
}

describe("ingestText idempotency", () => {
  it("returns the existing document with duplicate=true when the same text is ingested into the same source", async () => {
    const first = await ingestText(baseInput());
    const second = await ingestText(baseInput());

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(second.passages.map((p) => p.id)).toEqual(first.passages.map((p) => p.id));
    expect(await countRows("documents")).toBe(1);
    expect(await countRows("passages")).toBe(first.passages.length);
  });

  it("treats text differing only in line endings or a BOM as a duplicate", async () => {
    const first = await ingestText(baseInput({ rawText: "Line one.\nLine two.\n\nParagraph two." }));
    const second = await ingestText(baseInput({ rawText: "\uFEFFLine one.\r\nLine two.\r\n\r\nParagraph two." }));

    expect(second.duplicate).toBe(true);
    expect(second.document.id).toBe(first.document.id);
  });

  it("creates a new document for the same text in a different source", async () => {
    const first = await ingestText(baseInput());
    const second = await ingestText(baseInput({ suggestedTitle: "Another Source" }));

    expect(second.duplicate).toBe(false);
    expect(second.document.id).not.toBe(first.document.id);
    expect(await countRows("documents")).toBe(2);
  });

  it("creates a new document for different text in the same source", async () => {
    await ingestText(baseInput());
    const second = await ingestText(baseInput({ rawText: "Entirely different text." }));

    expect(second.duplicate).toBe(false);
    expect(await countRows("documents")).toBe(2);
  });

  it("records the uploader's person/role link even for a duplicate", async () => {
    await ingestText(baseInput());
    const second = await ingestText(baseInput({ personName: "Charles Babbage", personRole: "subject" }));

    expect(second.duplicate).toBe(true);
    const links = await pool.query(`SELECT role FROM source_people WHERE source_id = $1 ORDER BY role`, [
      second.source.id,
    ]);
    expect(links.rows.map((r) => r.role)).toEqual(["author", "subject"]);
  });

  it("creates only one document when identical ingests run concurrently", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ingestText(baseInput())));

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.document.id)).size).toBe(1);
    expect(await countRows("documents")).toBe(1);
  });
});

describe("ingestText normalisation", () => {
  it("stores normalised raw_text and computes offsets against it", async () => {
    const result = await ingestText(baseInput({ rawText: "\uFEFFFirst line.\r\nSecond line.\r\n\r\nNext paragraph." }));

    expect(result.document.raw_text).toBe("First line.\nSecond line.\n\nNext paragraph.");
    for (const passage of result.passages) {
      expect(result.document.raw_text.slice(passage.char_start, passage.char_end)).toBe(passage.text);
    }
  });

  it("rejects text containing NUL bytes with a ValidationError", async () => {
    await expect(ingestText(baseInput({ rawText: "a\u0000b" }))).rejects.toThrow(ValidationError);
  });
});

describe("ingestText optional field validation", () => {
  it.each(["2024-13-45", "2023-02-29", "2024-1-5", "yesterday", "2024-01-01T00:00:00Z"])(
    "rejects publishedAt %s",
    async (publishedAt) => {
      await expect(ingestText(baseInput({ publishedAt }))).rejects.toThrow(ValidationError);
    }
  );

  it("accepts a valid publishedAt, including a leap day", async () => {
    const result = await ingestText(baseInput({ publishedAt: "2024-02-29" }));
    expect(result.source.published_at).not.toBeNull();
  });

  it.each(["not a url", "example.com/page", "ftp://example.com/file", "javascript:alert(1)"])(
    "rejects externalUrl %s",
    async (externalUrl) => {
      await expect(ingestText(baseInput({ externalUrl }))).rejects.toThrow(ValidationError);
    }
  );

  it("accepts an http(s) externalUrl", async () => {
    const result = await ingestText(baseInput({ externalUrl: "https://example.com/essay" }));
    expect(result.source.external_url).toBe("https://example.com/essay");
  });

  it("treats blank optional fields as absent", async () => {
    const result = await ingestText(baseInput({ publishedAt: "  ", externalUrl: "" }));
    expect(result.source.published_at).toBeNull();
    expect(result.source.external_url).toBeNull();
  });
});
