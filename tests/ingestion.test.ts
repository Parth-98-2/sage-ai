import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool";
import { ingestText, ingestTranscript } from "../src/ingestion/ingestionService";
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

describe("ingestTranscript", () => {
  const TRANSCRIPT = [
    "Walton opened his first store in Newport, Arkansas. Before we get back into this, I want to tell you about the presenting sponsor of this",
    "Starting point is 00:09:19",
    "podcast, Ramp. Ramp helps businesses control costs. That is ramp.com. And so Walton kept visiting other stores to learn.",
    "Starting point is 00:10:01",
    "He borrowed ideas shamelessly. That is 999 books down, 1,000 to go. And I'll talk to you again soon. So I have this AI assistant I called Sage.",
  ].join("\n");

  function transcriptInput(overrides: Partial<Parameters<typeof ingestTranscript>[0]> = {}) {
    return {
      rawText: TRANSCRIPT,
      suggestedTitle: "Founders #999 - Sam Walton",
      sourceType: "podcast",
      personName: "David Senra",
      personRole: "host",
      additionalPeople: [{ name: "Sam Walton", role: "subject" }],
      ingestionMethod: "text_upload",
      originalFilename: "founders-999-sam-walton.txt",
      mimeType: "text/plain",
      ...overrides,
    };
  }

  it("stores the whole raw transcript, sponsor reads included, as the document", async () => {
    const result = await ingestTranscript(transcriptInput());

    expect(result.duplicate).toBe(false);
    expect(result.document.raw_text).toBe(TRANSCRIPT);
    expect(result.source).toMatchObject({ title: "Founders #999 - Sam Walton", source_type: "podcast" });
    expect(result.removed.map((range) => range.reason)).toEqual(["sponsor", "post_roll"]);
  });

  it("stores passages of episode content only, as exact slices with their transcript times", async () => {
    const result = await ingestTranscript(transcriptInput());
    const { passages } = (await getDocumentWithPassages(result.document.id))!;

    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages) {
      expect(TRANSCRIPT.slice(passage.char_start, passage.char_end)).toBe(passage.text);
      expect(passage.text).not.toMatch(/Ramp|ramp\.com|Sage/);
    }
    expect(passages.map((passage) => passage.metadata)).toEqual([
      { start_time: "00:00:00", end_time: "00:09:19" },
      { start_time: "00:09:19", end_time: null },
    ]);
    expect(passages.map((passage) => passage.text).join(" ")).toContain("And so Walton kept visiting other stores to learn.");
  });

  it("links the host and the episode's subject to the source", async () => {
    const result = await ingestTranscript(transcriptInput());
    const { rows } = await pool.query(
      "SELECT p.name, sp.role FROM source_people sp JOIN people p ON p.id = sp.person_id WHERE sp.source_id = $1 ORDER BY sp.role",
      [result.source.id]
    );
    expect(rows).toEqual([
      { name: "David Senra", role: "host" },
      { name: "Sam Walton", role: "subject" },
    ]);
  });

  it("creates nothing new when the same transcript is ingested again", async () => {
    const first = await ingestTranscript(transcriptInput());
    const second = await ingestTranscript(transcriptInput({ rawText: TRANSCRIPT.replace(/\n/g, "\r\n") }));

    expect(second.duplicate).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(second.passages.map((passage) => passage.id)).toEqual(first.passages.map((passage) => passage.id));
    expect(second.removed).toEqual(first.removed);
    const counts = await pool.query("SELECT (SELECT count(*) FROM documents)::int AS documents, (SELECT count(*) FROM passages)::int AS passages");
    expect(counts.rows[0]).toEqual({ documents: 1, passages: first.passages.length });
  });

  it("reuses the original ingestion when the same transcript is ingested under another title", async () => {
    const first = await ingestTranscript(transcriptInput({ suggestedTitle: "Founders #999 - Sam Walton" }));
    expect(first.duplicate).toBe(false);

    const second = await ingestTranscript(
      transcriptInput({ suggestedTitle: "Founders - Sam Walton", personName: "Someone Else", additionalPeople: [{ name: "Another Subject", role: "subject" }] })
    );

    expect(second.duplicate).toBe(true);
    expect(second.source).toEqual(first.source);
    expect(second.document.id).toBe(first.document.id);
    expect(second.passages.map((passage) => passage.id)).toEqual(first.passages.map((passage) => passage.id));
    expect(second.person.name).toBe("David Senra");
    expect(second.removed).toEqual(first.removed);

    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM sources)::int AS sources, (SELECT count(*) FROM documents)::int AS documents,
              (SELECT count(*) FROM passages)::int AS passages, (SELECT count(*) FROM people)::int AS people,
              (SELECT count(*) FROM source_people)::int AS links,
              (SELECT array_agg(title) FROM sources) AS titles`
    );
    expect(rows[0]).toEqual({
      sources: 1,
      documents: 1,
      passages: first.passages.length,
      people: 2,
      links: 2,
      titles: ["Founders #999 - Sam Walton"],
    });
  });

  it("still links newly given people when the same transcript is ingested under the same title", async () => {
    await ingestTranscript(transcriptInput());
    const again = await ingestTranscript(transcriptInput({ additionalPeople: [{ name: "Helen Walton", role: "subject" }] }));

    expect(again.duplicate).toBe(true);
    const { rows } = await pool.query("SELECT p.name FROM source_people sp JOIN people p ON p.id = sp.person_id WHERE sp.source_id = $1 ORDER BY p.name", [
      again.source.id,
    ]);
    expect(rows.map((row) => row.name)).toEqual(["David Senra", "Helen Walton", "Sam Walton"]);
  });

  it("creates a new source for a different transcript", async () => {
    const first = await ingestTranscript(transcriptInput());
    const other = await ingestTranscript(transcriptInput({ rawText: `${TRANSCRIPT}\nOne more line.`, suggestedTitle: "Founders #1000 - Sam Walton, part 2" }));

    expect(other.duplicate).toBe(false);
    expect(other.source.id).not.toBe(first.source.id);
    expect(other.document.id).not.toBe(first.document.id);
  });

  it("rejects an additional person with an invalid role", async () => {
    await expect(ingestTranscript(transcriptInput({ additionalPeople: [{ name: "Sam Walton", role: "hero" }] }))).rejects.toThrow(ValidationError);
  });
});
