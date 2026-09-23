import { ValidationError } from "./types";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes bytes as UTF-8, rejecting invalid sequences instead of silently
 * substituting U+FFFD (e.g. for a Windows-1252 export). A leading BOM is
 * dropped by the decoder.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new ValidationError("file is not valid UTF-8 text");
  }
}

/**
 * Canonical form for stored raw_text: no leading BOM and LF line endings.
 * Passage offsets and the document checksum are computed against this form,
 * so re-uploading the same text with CRLF line endings is a duplicate.
 * NUL bytes cannot be stored in a Postgres TEXT column, so they are rejected.
 */
export function normalizeText(text: string): string {
  if (text.includes("\u0000")) {
    throw new ValidationError("text must not contain NUL bytes");
  }
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}
