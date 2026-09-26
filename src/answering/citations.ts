import { selectionTerms } from "./evidenceSelection";
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

const citeList = (numbers: number[]) => numbers.map((n) => `[${n}]`).join("");

/** Double quotation marks, straight or curly. Single quotes are left alone: they double as apostrophes. */
const QUOTE_MARK = /["“”]/g;

/**
 * The quoted spans of a sentence, and the sentence without them. Marks pair
 * up in order; an unpaired mark is a quotation split across sentences, so it
 * quotes to the end of the sentence (an opening mark) or from its start (a
 * closing one).
 */
function splitQuotes(text: string): { quotes: string[]; rest: string } {
  const marks = [...text.matchAll(QUOTE_MARK)].map((match) => match.index!);
  const ranges: Array<[number, number]> = [];
  if (marks.length % 2 === 1) {
    if (/(?:^|[\s([{:—-])$/.test(text.slice(0, marks[0]))) ranges.push([marks.pop()! + 1, text.length]);
    else ranges.push([0, marks.shift()!]);
  }
  for (let i = 0; i + 1 < marks.length; i += 2) ranges.push([marks[i] + 1, marks[i + 1]]);
  ranges.sort((a, b) => a[0] - b[0]);

  let rest = "";
  let at = 0;
  for (const [start, end] of ranges) {
    rest += `${text.slice(at, Math.max(at, start - 1))} `;
    at = end + 1;
  }
  rest += text.slice(at);
  return { quotes: ranges.map(([start, end]) => text.slice(start, end)).filter((q) => /[A-Za-z0-9]/.test(q)), rest };
}

/** Transcript timestamps that interrupt passage text mid-sentence. */
const TIMESTAMP = /starting point is \d{1,2}:\d{2}(?::\d{2})?/gi;

/** Lowercased words joined by single spaces, ignoring punctuation and timestamps: the unit of verbatim comparison. */
function wordSequence(text: string): string {
  const words = text.replace(TIMESTAMP, " ").toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) ?? [];
  return words.join(" ");
}

/** The parts of a quotation, split at ellipses, that do not appear word for word in any of `passages`. */
function unquotedParts(quotation: string, passages: string[]): string[] {
  const sequences = passages.map((text) => ` ${wordSequence(text)} `);
  return quotation
    .split(/\.{3}|…/)
    .map((part) => wordSequence(part))
    .filter((part) => part !== "" && !sequences.some((sequence) => sequence.includes(` ${part} `)));
}

/**
 * Claims that the evidence does not say something. Retrieved passages are
 * positive evidence only: a passage not mentioning something never shows the
 * person did not say it, so such a claim is never source-backed.
 */
const ABSENCE_CLAIM = new RegExp(
  [
    String.raw`\b(?:does|do|did|is|are|was|were|has|have|had)(?:\s+not|n['’]t)\s+(?:\w+\s+){0,2}?(?:mention|say|said|discuss|address|quote|cover|provide|contain|state|talk|describe|specify|include|refer|speak|comment|explain)`,
    String.raw`\bthere\s+(?:is|are|was|were)\s+no\b`,
    String.raw`\bno\s+(?:mention|discussion|reference|evidence|information|quotes?|details?)\b`,
    String.raw`\bnever\s+(?:mentions?|mentioned|says|said|discuss(?:es|ed)?|address(?:es|ed)?)\b`,
    String.raw`\b(?:evidence|passages?|sources?|text|excerpts?|material)\s+(?:does|do|did)(?:\s+not|n['’]t)\b`,
  ].join("|"),
  "i"
);

/** Verbs that present words or views as someone's. */
const SPEECH_VERBS =
  "says|said|states|stated|writes|wrote|notes|noted|argues|argued|advises|advised|believes|believed|explains|explained|" +
  "recounts|recounted|emphasizes|emphasized|admits|admitted|claims|claimed|describes|described|mentions|mentioned|tells|told|" +
  "asks|asked|insists|insisted|declares|declared|quotes|quoted|reads|recalls|recalled|warns|warned|adds|added|replies|replied|" +
  "repeats|repeated|puts it";
const NAME = String.raw`(?:[A-Z][A-Za-z]*|[a-z]+[A-Z][A-Za-z]*)`;
const WORKS = String.raw`book|autobiography|memoir|letters?|words|maxims?|quote|line|writing|advice`;
/** "Bloomberg said", "Bloomberg also writes", "according to Bloomberg", "Bloomberg's book": the named person is credited with words. */
const ATTRIBUTION = new RegExp(
  String.raw`\b(${NAME})\s+(?:(?:also|then|later|once|often|repeatedly|explicitly|directly|further|famously|simply|just)\s+)?(?:${SPEECH_VERBS})\b` +
    String.raw`|\baccording to (?:the\s+)?(${NAME})\b` +
    String.raw`|\b(${NAME})['’]s\s+(?:${WORKS})\b`,
  "g"
);
/** How a passage itself marks someone as speaking or being quoted. */
const PASSAGE_SPEAKER = new RegExp(
  String.raw`\b(${NAME})(?:['’]s)?\s+(?:also\s+|then\s+|just\s+)?(?:${SPEECH_VERBS})\b` +
    String.raw`|\b(?:${SPEECH_VERBS}|according to|quoting|quote from|line from|words of|quote by|line by|book by)\s+(?:${NAME}\s+)?(${NAME})\b` +
    String.raw`|\b(${NAME})['’]s\s+(?:${WORKS})\b`,
  "g"
);

/** The capitalised, non-common names captured by `pattern` in `text`. */
function capturedNames(pattern: RegExp, text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const name = match.slice(1).find((group) => group !== undefined);
    if (name && !COMMON_WORDS.has(name.toLowerCase())) names.push(name);
  }
  return names;
}

/**
 * Who cited passages can support crediting with words: their recorded
 * people, the people their source titles name (the episode's subject, whose
 * words the host reads), and anyone the passage text itself presents as
 * speaking or being quoted. A name merely mentioned in a passage does not count.
 */
function sourceNames(items: Evidence[]): Set<string> {
  const names = new Set<string>();
  for (const { result } of items) {
    for (const person of result.people) for (const [word] of person.name.matchAll(NAME_WORD)) names.add(word.toLowerCase());
    // Titles may be lowercase slugs ("founders-433-michael-bloomberg"), so every title word counts.
    for (const word of result.source.title.toLowerCase().match(/[a-z]+/g) ?? []) if (!COMMON_WORDS.has(word)) names.add(word);
    for (const name of capturedNames(PASSAGE_SPEAKER, result.passage.text)) names.add(name.toLowerCase());
  }
  return names;
}

/** Stemmed terms this short carry too little to place a sentence's wording in a passage. */
const LOCALITY_MIN_TERM_LENGTH = 4;
/** Distinctive terms a sentence must share with one uncited passage before its citation is judged misplaced. */
const LOCALITY_MIN_TERMS = 2;

/**
 * An obvious citation mismatch: at least LOCALITY_MIN_TERMS of the sentence's
 * terms appear in no cited passage but in exactly one other supplied passage,
 * the same one. Paraphrase is untouched: words the cited passage lacks only
 * count against it when they point unambiguously at another passage.
 */
function misplacedWording(text: string, cited: number[], passageTerms: Map<number, Set<string>>): { number: number; terms: string[] } | null {
  const citedTerms = cited.map((number) => passageTerms.get(number)).filter((terms): terms is Set<string> => terms !== undefined);
  const pointers = new Map<number, string[]>();
  for (const term of selectionTerms(text.replace(CITATION_GROUP, " "))) {
    if (term.length < LOCALITY_MIN_TERM_LENGTH || citedTerms.some((terms) => terms.has(term))) continue;
    const holders = [...passageTerms].filter(([, terms]) => terms.has(term)).map(([number]) => number);
    if (holders.length === 1) pointers.set(holders[0], [...(pointers.get(holders[0]) ?? []), term]);
  }
  for (const [number, terms] of pointers) if (terms.length >= LOCALITY_MIN_TERMS) return { number, terms };
  return null;
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
 * - a sources sentence makes no absence claim ("does not mention", "there is
 *   no ..."): retrieved passages cannot establish what was never said;
 * - every quotation in a sources sentence appears word for word in a cited
 *   passage (case, punctuation and transcript timestamps aside);
 * - a person a sources sentence credits with words ("X said", "according to
 *   X", "X's book") is a speaker or source of a cited passage (see sourceNames);
 * - a sources sentence's distinctive wording does not point unambiguously at
 *   a passage it does not cite (see misplacedWording);
 * - the application section cites nothing, and its names and numbers appear
 *   in the evidence or the question.
 * Violations reject the whole reply rather than being repaired.
 */
export function checkAnswerSupport(sections: AnswerSections, evidence: Evidence[], question: string): void {
  const byNumber = new Map(evidence.map((item) => [item.number, item]));
  const passageTerms = new Map(evidence.map((item) => [item.number, selectionTerms(item.result.passage.text)]));

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
    const citedItems = cited.flatMap((number) => (byNumber.has(number) ? [byNumber.get(number)!] : []));
    const firstPerson = [...new Set(text.match(FIRST_PERSON) ?? [])];
    if (firstPerson.length > 0) {
      const speakers = speakerNames(citedItems);
      if (![...`${label} ${text}`.matchAll(NAME_WORD)].some(([word]) => speakers.has(word.toLowerCase()))) {
        throw new InvalidModelResponseError(
          `source sentence uses first-person words (${listTerms(firstPerson)}) without naming who is speaking: ${quote(text)}`
        );
      }
    }

    const { quotes, rest } = splitQuotes(text.replace(CITATION_GROUP, " "));
    if (ABSENCE_CLAIM.test(rest)) {
      throw new InvalidModelResponseError(`source sentence claims what the evidence does not say, which retrieved passages cannot show: ${quote(text)}`);
    }
    for (const quotation of quotes) {
      const absent = unquotedParts(quotation, citedItems.map(({ result }) => result.passage.text));
      if (absent.length > 0) {
        throw new InvalidModelResponseError(`quoted text ${quote(quotation.trim())} does not appear verbatim in the cited evidence ${citeList(cited)}`);
      }
    }
    const credited = capturedNames(ATTRIBUTION, rest);
    if (credited.length > 0) {
      const sources = sourceNames(citedItems);
      const unsupported = [...new Set(credited.filter((name) => !sources.has(name.toLowerCase())))];
      if (unsupported.length > 0) {
        throw new InvalidModelResponseError(
          `source sentence credits ${listTerms(unsupported)} with words, but the cited evidence ${citeList(cited)} ` +
            `does not present ${unsupported.length === 1 ? "them" : "any of them"} as a speaker or source: ${quote(text)}`
        );
      }
    }
    const misplaced = misplacedWording(text, cited, passageTerms);
    if (misplaced) {
      throw new InvalidModelResponseError(
        `sentence cites ${citeList(cited)} but its wording (${listTerms(misplaced.terms)}) comes from [${misplaced.number}]: ${quote(text)}`
      );
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
