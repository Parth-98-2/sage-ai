import { InvalidModelResponseError, type Citation, type Evidence } from "./types";

/** A citation group: [3] or [1, 4]. Any other bracketed text is not a citation. */
const CITATION_GROUP = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;

/** The evidence numbers cited in `text`, unique, in order of first appearance. */
export function parseCitationNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(CITATION_GROUP)) {
    for (const part of match[1].split(",")) seen.add(Number(part.trim()));
  }
  return [...seen];
}

/** `text` without its citation groups, and without the spaces they leave before punctuation or each other. */
export function stripCitations(text: string): string {
  return text
    .replace(CITATION_GROUP, "")
    .replace(/[ \t]+(?=[.,;:!?)]|$)/gm, "")
    .replace(/[ \t]{2,}/g, " ");
}

/**
 * Maps cited numbers to the evidence actually supplied to the model. A
 * number that was not supplied means the model invented a source, so the
 * whole response is rejected rather than silently repaired.
 */
export function resolveCitations(numbers: number[], evidence: Evidence[]): Citation[] {
  const byNumber = new Map(evidence.map((item) => [item.number, item.result]));
  const invalid = numbers.filter((number) => !byNumber.has(number));
  if (invalid.length > 0) {
    throw new InvalidModelResponseError(
      `model cited evidence that was not supplied: ${invalid.map((n) => `[${n}]`).join(", ")} (valid: 1-${evidence.length})`
    );
  }
  return numbers.map((number) => {
    const result = byNumber.get(number)!;
    return { number, passage: result.passage, document: result.document, source: result.source, people: result.people };
  });
}

/** The two parts of a grounded reply (see the answer format in the system prompt). */
export interface AnswerSections {
  /** What the evidence says; every sentence cites. */
  sources: string;
  /** The model's application of the evidence to the asker; never cites. Null when absent. */
  application: string | null;
}

/** Heading lines, tolerating markdown decoration and text on the same line after the colon. */
const SOURCES_HEADING_LINE = /^[ \t#*_>]*FROM THE SOURCES[ \t*_]*(?::[ \t*_]*|$)/gim;
const APPLICATION_HEADING_LINE = /^[ \t#*_>]*APPLICATION(?:[ \t]*\([^)\n]*\))?[ \t*_]*(?::[ \t*_]*|$)/gim;

/**
 * Splits a grounded reply into its sections. The sources section is required
 * and comes first, with nothing before it; the application section is
 * optional and comes after it.
 */
export function parseAnswerSections(reply: string): AnswerSections {
  const sources = [...reply.matchAll(SOURCES_HEADING_LINE)];
  const application = [...reply.matchAll(APPLICATION_HEADING_LINE)];
  if (sources.length !== 1) {
    throw new InvalidModelResponseError(`model answer must contain the FROM THE SOURCES heading exactly once (found ${sources.length})`);
  }
  if (application.length > 1) {
    throw new InvalidModelResponseError(`model answer contains the APPLICATION heading ${application.length} times`);
  }
  const sourcesAt = sources[0].index!;
  const applicationAt = application.length === 1 ? application[0].index! : reply.length;
  if (applicationAt < sourcesAt) throw new InvalidModelResponseError("model answer puts APPLICATION before FROM THE SOURCES");
  if (reply.slice(0, sourcesAt).trim() !== "") throw new InvalidModelResponseError("model answer has text before FROM THE SOURCES");

  const sourcesText = reply.slice(sourcesAt + sources[0][0].length, applicationAt).trim();
  if (!sourcesText) throw new InvalidModelResponseError("model answer has an empty FROM THE SOURCES section");
  const applicationText = application.length === 1 ? reply.slice(applicationAt + application[0][0].length).trim() : "";
  return { sources: sourcesText, application: applicationText || null };
}

/**
 * Sentence breaks: after . ! or ? (and any closing quotes or citations that
 * follow), before anything that is not lowercase or a citation. Deliberately
 * simple: an abbreviation such as "U.S." can split a sentence, which then
 * fails as uncited rather than passing unchecked.
 */
const SENTENCE_BREAK = /(?<=[.!?]["'”’)]*(?:\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\])*)\s+(?=[^a-z\s[])/;
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;
/** A short leading "Label:" on a line, as in "What they noticed: ...". */
const LINE_LABEL = /^([A-Za-z][A-Za-z'’ ]{0,40}):\s*/;
/** Capitalised words and words with an internal capital (AppLovin, iPhone): candidate names. */
const NAME_WORD = /\b(?:[A-Z][A-Za-z]*|[a-z]+[A-Z][A-Za-z]*)\b/g;
/** First-person words: "I" only in capitals, the rest lowercase or capitalised, so "US" (the country) is not one. */
const FIRST_PERSON = /\b(?:I|[Mm]e|[Mm]y|[Mm]ine|[Mm]yself|[Ww]e|[Uu]s|[Oo]urs?|[Oo]urselves)\b/g;
/** The text just before a word that starts a sentence or a line. */
const SENTENCE_START = /(?:^|[.!?]["'”’)]*\s+|\n\s*)$/;
const NUMBER = /\d+(?:[.,]\d+)*/g;

/**
 * Common capitalised words that are never names: sentence starters, pronouns,
 * and the imperative verbs advice in the application section tends to open with.
 */
const COMMON_WORDS = new Set(
  (
    "a an the this that these those it its he she they them his her their we our you your i me my " +
    "in on at as by for from to of with and but or nor so if then than when while after before because " +
    "also however instead both each one what who whom why how where which there here not no yes all " +
    "some any most many more such only even just first next finally later " +
    "do don start stop build try ask find look focus consider keep make use test write pick choose " +
    "talk list run spend set treat watch notice measure track"
  ).split(" ")
);

interface Sentence {
  /** The leading "Label:" of the line this sentence starts, if any; it may also come from the question. */
  label: string;
  text: string;
}

function splitSentences(section: string): Sentence[] {
  const sentences: Sentence[] = [];
  for (const rawLine of section.split(/\r?\n/)) {
    let line = rawLine.replace(LIST_MARKER, "").replace(/[*_#`]/g, "").trim();
    const labelMatch = line.match(LINE_LABEL);
    const label = labelMatch && labelMatch[1].trim().split(/\s+/).length <= 4 ? labelMatch[1] : "";
    if (label) line = line.slice(labelMatch![0].length);
    line.split(SENTENCE_BREAK).forEach((text, i) => {
      if (/[A-Za-z0-9]/.test(text.replace(CITATION_GROUP, ""))) sentences.push({ label: i === 0 ? label : "", text: text.trim() });
    });
  }
  return sentences;
}

interface Vocabulary {
  words: Set<string>;
  numbers: Set<string>;
}

/** Lowercased words and comma-free numbers of `texts`, for support lookups. */
function vocabulary(texts: string[]): Vocabulary {
  const joined = texts.join("\n");
  return {
    words: new Set(joined.toLowerCase().match(/[a-z0-9]+/g) ?? []),
    numbers: new Set((joined.match(NUMBER) ?? []).map((n) => n.replace(/,/g, ""))),
  };
}

/** Names and numbers in `text` that `allowed` does not contain. */
function unsupportedTerms(text: string, allowed: Vocabulary): string[] {
  const bare = text.replace(CITATION_GROUP, " ");
  const missing = new Set<string>();
  for (const [word] of bare.matchAll(NAME_WORD)) {
    const lower = word.toLowerCase();
    if (!COMMON_WORDS.has(lower) && !allowed.words.has(lower)) missing.add(word);
  }
  for (const [number] of bare.matchAll(NUMBER)) {
    if (!allowed.numbers.has(number.replace(/,/g, ""))) missing.add(number);
  }
  return [...missing];
}

/** The text a passage licenses: the passage, its source title, and its recorded people and their roles. */
function evidenceTexts({ result }: Evidence): string[] {
  return [result.passage.text, result.source.title, ...result.people.map((person) => `${person.name} ${person.role}`)];
}

/**
 * Who a sentence citing `items` may name as the speaker of first-person words:
 * the passages' recorded people, and people the passages name themselves,
 * taken as capitalised words the passage text uses mid-sentence (a capital
 * at the start of a sentence says nothing). Source titles are not used, so
 * title words such as "Founders" or "Works" never count.
 */
function speakerNames(items: Evidence[]): Set<string> {
  const names = new Set<string>();
  const add = (word: string) => {
    if (!COMMON_WORDS.has(word.toLowerCase())) names.add(word.toLowerCase());
  };
  for (const { result } of items) {
    for (const person of result.people) for (const [word] of person.name.matchAll(NAME_WORD)) add(word);
    const text = result.passage.text;
    for (const match of text.matchAll(NAME_WORD)) {
      if (!SENTENCE_START.test(text.slice(Math.max(0, match.index! - 8), match.index))) add(match[0]);
    }
  }
  return names;
}

function quote(text: string): string {
  return JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}...` : text);
}

function listTerms(terms: string[]): string {
  return terms.map((term) => `"${term}"`).join(", ");
}

/**
 * Deterministic support check for a grounded reply. It cannot judge meaning;
 * it enforces what can be checked mechanically:
 * - every sentence in the sources section cites evidence, and every name and
 *   number in it appears in a passage that sentence cites (a line label such
 *   as "What they did:" may also come from the question);
 * - a sources sentence with first-person words (I, my, we, ...) names its
 *   speaker: a recorded person of a cited passage, or someone that passage
 *   names (see speakerNames);
 * - the application section cites nothing, and its names and numbers appear
 *   in the evidence or the question.
 * Violations reject the whole reply rather than being repaired.
 */
export function checkAnswerSupport(sections: AnswerSections, evidence: Evidence[], question: string): void {
  const byNumber = new Map(evidence.map((item) => [item.number, item]));

  for (const { label, text } of splitSentences(sections.sources)) {
    const cited = parseCitationNumbers(text);
    if (cited.length === 0) throw new InvalidModelResponseError(`source sentence has no citation: ${quote(text)}`);
    const licensed = cited.flatMap((number) => (byNumber.has(number) ? evidenceTexts(byNumber.get(number)!) : []));
    const missing = unsupportedTerms(text, vocabulary(licensed));
    if (label) missing.push(...unsupportedTerms(label, vocabulary([...licensed, question])));
    if (missing.length > 0) {
      throw new InvalidModelResponseError(
        `sentence cites ${cited.map((n) => `[${n}]`).join("")} but ${listTerms(missing)} ` +
          `${missing.length === 1 ? "does" : "do"} not appear in the cited evidence: ${quote(text)}`
      );
    }
    const firstPerson = [...new Set(text.match(FIRST_PERSON) ?? [])];
    if (firstPerson.length > 0) {
      const speakers = speakerNames(cited.flatMap((number) => (byNumber.has(number) ? [byNumber.get(number)!] : [])));
      if (![...`${label} ${text}`.matchAll(NAME_WORD)].some(([word]) => speakers.has(word.toLowerCase()))) {
        throw new InvalidModelResponseError(
          `source sentence uses first-person words (${listTerms(firstPerson)}) without naming who is speaking: ${quote(text)}`
        );
      }
    }
  }

  if (sections.application === null) return;
  const cited = parseCitationNumbers(sections.application);
  if (cited.length > 0) {
    throw new InvalidModelResponseError(`the APPLICATION section must not cite evidence, but cites ${cited.map((n) => `[${n}]`).join("")}`);
  }
  const missing = unsupportedTerms(sections.application, vocabulary([...evidence.flatMap(evidenceTexts), question]));
  if (missing.length > 0) {
    throw new InvalidModelResponseError(
      `the APPLICATION section names ${listTerms(missing)}, which ${missing.length === 1 ? "is" : "are"} not in the evidence or the question`
    );
  }
}
