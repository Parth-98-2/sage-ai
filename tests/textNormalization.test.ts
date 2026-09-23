import { describe, expect, it } from "vitest";
import { decodeUtf8Strict, normalizeText } from "../src/ingestion/textNormalization";
import { ValidationError } from "../src/ingestion/types";

describe("decodeUtf8Strict", () => {
  it("decodes valid UTF-8, including multi-byte characters", () => {
    expect(decodeUtf8Strict(Buffer.from("Café — naïve ✓", "utf-8"))).toBe("Café — naïve ✓");
  });

  it("drops a leading UTF-8 BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Hello")]);
    expect(decodeUtf8Strict(bytes)).toBe("Hello");
  });

  it("rejects invalid UTF-8 such as Windows-1252 bytes with a ValidationError", () => {
    const windows1252 = Buffer.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in Windows-1252
    expect(() => decodeUtf8Strict(windows1252)).toThrow(ValidationError);
  });
});

describe("normalizeText", () => {
  it("converts CRLF and lone CR line endings to LF", () => {
    expect(normalizeText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("strips a leading BOM but keeps other text untouched", () => {
    expect(normalizeText("\uFEFFHello\n\nWorld")).toBe("Hello\n\nWorld");
  });

  it("rejects NUL bytes with a ValidationError", () => {
    expect(() => normalizeText("a\u0000b")).toThrow(ValidationError);
  });
});
