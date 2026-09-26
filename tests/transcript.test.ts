import { describe, expect, it } from "vitest";
import { findPromotionalRanges, parseTimestamps, planTranscript } from "../src/ingestion/transcript";

/** A Founders-style transcript, with sponsor wording taken from real episodes. */
const TRANSCRIPT = [
  "Walton opened his first store in Newport, Arkansas. He studied every competitor. Before we get back into this, I want to tell you about the presenting sponsor of this",
  "Starting point is 00:09:19",
  "podcast, Ramp. Ramp helps many of the most innovative businesses control costs. Go to ramp.com today. That is ramp.com. And so Walton kept visiting other stores to learn.",
  "Starting point is 00:10:01",
  "He borrowed ideas shamelessly. And before we get back into this, I want to tell you about Apploven. Apploven connects you with over a billion potential customers. " +
    "That's apploven.com. And then I want to tell you about Vanta. Vanta automates compliance. That is vanta.com forward slash founders. Walton's discount stores spread across small towns.",
  "Starting point is 01:02:03",
  "That is 999 books down, 1,000 to go. And I'll talk to you again soon. So I have this AI assistant I called Sage. Go to Founderspodcast.com for slash sage.",
].join("\n");

const removedText = (text: string) => findPromotionalRanges(text).map(({ start, end }) => text.slice(start, end));
const keptText = (text: string) => planTranscript(text).passages.map((passage) => passage.text).join("\n");

describe("parseTimestamps", () => {
  it("finds each timestamp line with its time, seconds and offset", () => {
    const markers = parseTimestamps(TRANSCRIPT);
    expect(markers.map(({ time, seconds }) => [time, seconds])).toEqual([
      ["00:09:19", 559],
      ["00:10:01", 601],
      ["01:02:03", 3723],
    ]);
    for (const { time, offset } of markers) expect(TRANSCRIPT.slice(offset).startsWith(`Starting point is ${time}\n`)).toBe(true);
  });

  it("ignores the phrase when it is not a line of its own", () => {
    expect(parseTimestamps("The starting point is 00:01:02 in his story.\nStarting point is 1:02:03")).toEqual([
      { time: "01:02:03", seconds: 3723, offset: 45 },
    ]);
  });
});

describe("findPromotionalRanges", () => {
  it("removes each sponsor read from its intro to its call to action, across timestamp lines", () => {
    const removed = removedText(TRANSCRIPT);
    expect(findPromotionalRanges(TRANSCRIPT).map((range) => range.reason)).toEqual(["sponsor", "sponsor", "sponsor", "post_roll"]);
    expect(removed[0]).toMatch(/^Before we get back into this, I want to tell you about the presenting sponsor of this\nStarting point is 00:09:19\npodcast, Ramp\..*That is ramp\.com\.$/s);
    expect(removed[1]).toMatch(/^And before we get back into this, I want to tell you about Apploven\..*That's apploven\.com\.$/);
    expect(removed[2]).toMatch(/^And then I want to tell you about Vanta\..*That is vanta\.com forward slash founders\.$/);
  });

  it("removes everything after the host's sign-off", () => {
    expect(removedText(TRANSCRIPT)[3]).toBe(" So I have this AI assistant I called Sage. Go to Founderspodcast.com for slash sage.");
  });

  it("keeps the episode content around the removed reads, including the sign-off", () => {
    const kept = keptText(TRANSCRIPT);
    for (const sentence of [
      "He studied every competitor.",
      "And so Walton kept visiting other stores to learn.",
      "He borrowed ideas shamelessly.",
      "Walton's discount stores spread across small towns.",
      "And I'll talk to you again soon.",
    ]) {
      expect(kept).toContain(sentence);
    }
    expect(kept).not.toMatch(/Ramp|Apploven|Vanta|Sage|\.com/);
  });

  it("keeps an intro that names no sponsor, and a read with no call to action", () => {
    const noSponsor = "Before we get back into this, let me read one more line about Walton. That is walmart.com history.";
    expect(findPromotionalRanges(noSponsor)).toEqual([]);
    const noClose = "And then I want to tell you about Vanta. Vanta automates compliance. Walton kept studying stores.";
    expect(findPromotionalRanges(noClose)).toEqual([]);
  });

  it("removes a sponsor that is not in the default list only when it is passed in", () => {
    const text = "Walton loved trucks. And then I want to tell you about Acme. Acme makes widgets. That is acme.com. Back to Walton.";
    expect(findPromotionalRanges(text)).toEqual([]);
    const [range] = findPromotionalRanges(text, ["Acme"]);
    expect(text.slice(range.start, range.end)).toBe("And then I want to tell you about Acme. Acme makes widgets. That is acme.com.");
  });
});

describe("planTranscript", () => {
  const plan = planTranscript(TRANSCRIPT);

  it("cuts passages that are exact slices of the raw transcript and never overlap a removed range", () => {
    expect(plan.passages.length).toBeGreaterThan(0);
    for (const passage of plan.passages) {
      expect(TRANSCRIPT.slice(passage.charStart, passage.charEnd)).toBe(passage.text);
      for (const range of plan.removed) expect(passage.charEnd <= range.start || passage.charStart >= range.end).toBe(true);
    }
  });

  it("records the transcript times each passage spans", () => {
    expect(plan.passages.map((passage) => [passage.text.slice(0, 20), passage.metadata])).toEqual([
      ["Walton opened his fi", { start_time: "00:00:00", end_time: "00:09:19" }],
      ["And so Walton kept v", { start_time: "00:09:19", end_time: "01:02:03" }],
      ["Walton's discount st", { start_time: "00:10:01", end_time: null }],
    ]);
  });

  it("chunks a transcript without promotions like any other text", () => {
    const plain = "First segment.\nStarting point is 00:00:30\nSecond segment.";
    expect(planTranscript(plain).removed).toEqual([]);
    expect(planTranscript(plain).passages.map((passage) => passage.text)).toEqual([plain]);
  });
});
