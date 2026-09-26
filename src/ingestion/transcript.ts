import { chunkText, type Chunk } from "./chunker";

/**
 * Founders-style podcast transcripts: text segments separated by
 * "Starting point is HH:MM:SS" lines, with sponsor reads and an end-of-episode
 * promotion mixed into the text.
 *
 * Cleaning never rewrites the transcript. It only decides which character
 * ranges of the raw transcript are episode content, so every passage stays an
 * exact slice of the stored raw text and can be traced back to its timestamp.
 */

export interface TimestampMarker {
  /** As written in the transcript, e.g. "00:09:19". */
  time: string;
  seconds: number;
  /** Offset of the start of the marker line; the segment it heads follows the line. */
  offset: number;
}

export type RemovalReason = "sponsor" | "post_roll";

export interface RemovedRange {
  start: number;
  end: number;
  reason: RemovalReason;
}

export interface TranscriptPassage extends Chunk {
  metadata: {
    /** Time of the segment the passage starts in. */
    start_time: string;
    /** Time of the segment after the passage, or null when it runs to the end of the transcript. */
    end_time: string | null;
  };
}

export interface TranscriptPlan {
  markers: TimestampMarker[];
  removed: RemovedRange[];
  passages: TranscriptPassage[];
}

const TIMESTAMP_LINE = /^Starting point is (\d{1,2}):(\d{2}):(\d{2})[ \t]*$/gm;

/** The "Starting point is HH:MM:SS" lines of a transcript, in order. */
export function parseTimestamps(text: string): TimestampMarker[] {
  return [...text.matchAll(TIMESTAMP_LINE)].map((match) => {
    const [hours, minutes, seconds] = match.slice(1).map(Number);
    return { time: `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}`, seconds: hours * 3600 + minutes * 60 + seconds, offset: match.index! };
  });
}

/** Sponsors read on Founders; the transcriber's spellings are included ("Apploven", "App Loven"). */
export const DEFAULT_SPONSORS = ["Ramp", "AppLovin", "Apploven", "App Loven", "Vanta"];

/** How far past a sponsor intro its call to action may be; beyond that the intro is left alone. */
const MAX_SPONSOR_CHARS = 6000;
/** How soon after "before we get back into this" the sponsor (or the word "sponsor") must be named. */
const SPONSOR_NAME_WINDOW = 200;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The host's two ways into a sponsor read: "(And) before we get back into
 * this, I want to tell you about ..." and, for a second sponsor straight after
 * the first, "(And then) I want to tell you about <sponsor>".
 */
function sponsorIntro(sponsors: string[]): RegExp {
  const names = sponsors.map(escapeRegExp).join("|");
  return new RegExp(String.raw`(?:\bAnd\s+)?\bbefore we get back into (?:this|it)\b|(?:\bAnd\s+(?:then\s+)?)?\bI want to tell you about\s+(?:${names})\b`, "gi");
}

/** The call to action that ends a read: "That is ramp.com.", "That's apploven.com.", "That is vanta.com forward slash founders." */
const SPONSOR_CLOSE = /\bThat(?:['’]s| is) [a-z0-9-]+\.com\b(?:,?\s+(?:forward\s+|for\s+)?slash\s+[a-z0-9-]+)?[.!]?/gi;

/** The host's sign-off; what follows it is end-of-episode promotion. */
const SIGN_OFF = /\bI['’]ll talk to you (?:again )?soon\b[.!]?/gi;

/**
 * The promotional ranges of a transcript, sorted and non-overlapping:
 * - a sponsor read, from its intro to the end of its call to action, when a
 *   known sponsor (or the word "sponsor") is named right after the intro and
 *   the call to action follows within MAX_SPONSOR_CHARS; otherwise the text
 *   is kept, since removing content is worse than keeping an ad;
 * - everything after the last sign-off ("I'll talk to you again soon").
 */
export function findPromotionalRanges(text: string, sponsors: string[] = DEFAULT_SPONSORS): RemovedRange[] {
  const removed: RemovedRange[] = [];
  const named = new RegExp(String.raw`\b(?:sponsor|${sponsors.map(escapeRegExp).join("|")})\b`, "i");
  const intro = sponsorIntro(sponsors);

  for (let at = 0; ; ) {
    intro.lastIndex = at;
    const start = intro.exec(text);
    if (!start) break;
    const afterIntro = start.index + start[0].length;
    at = afterIntro;

    const lead = text.slice(start.index, afterIntro + SPONSOR_NAME_WINDOW).replace(TIMESTAMP_LINE, " ");
    if (!named.test(lead)) continue;
    SPONSOR_CLOSE.lastIndex = afterIntro;
    const close = SPONSOR_CLOSE.exec(text);
    if (!close) continue;
    const end = close.index + close[0].length;
    if (end - start.index > MAX_SPONSOR_CHARS) continue;

    removed.push({ start: start.index, end, reason: "sponsor" });
    at = end;
  }

  const signOff = [...text.matchAll(SIGN_OFF)].pop();
  if (signOff) {
    const end = signOff.index! + signOff[0].length;
    const lastSponsorEnd = removed.length > 0 ? removed[removed.length - 1].end : 0;
    if (text.slice(end).trim() !== "" && end >= lastSponsorEnd) removed.push({ start: end, end: text.length, reason: "post_roll" });
  }
  return removed;
}

/** The time of the segment containing `offset`: the last marker at or before it, or 00:00:00 before the first. */
function timeAt(markers: TimestampMarker[], offset: number): string {
  let time = "00:00:00";
  for (const marker of markers) {
    if (marker.offset > offset) break;
    time = marker.time;
  }
  return time;
}

/**
 * Splits a transcript into passages of episode content: the text between
 * promotional ranges is chunked with the standard chunker, so no passage
 * spans a removed range, and each passage records the transcript times it
 * covers. `text` must already be normalised (see normalizeText).
 */
export function planTranscript(text: string, sponsors: string[] = DEFAULT_SPONSORS): TranscriptPlan {
  const markers = parseTimestamps(text);
  const removed = findPromotionalRanges(text, sponsors);

  const kept: Array<[number, number]> = [];
  let at = 0;
  for (const range of removed) {
    if (range.start > at) kept.push([at, range.start]);
    at = Math.max(at, range.end);
  }
  if (at < text.length) kept.push([at, text.length]);

  const passages = kept.flatMap(([start, end]) =>
    chunkText(text.slice(start, end)).map((chunk): TranscriptPassage => {
      const charStart = start + chunk.charStart;
      const charEnd = start + chunk.charEnd;
      const next = markers.find((marker) => marker.offset >= charEnd);
      return {
        ...chunk,
        charStart,
        charEnd,
        metadata: { start_time: timeAt(markers, charStart), end_time: next ? next.time : null },
      };
    })
  );
  return { markers, removed, passages };
}
