import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_LIMIT, parseLimit } from "../scripts/sage";
import { MAX_ANSWER_LIMIT } from "../src/answering/types";

describe("sage session /limit", () => {
  it("defaults to 10 passages", () => {
    expect(DEFAULT_SESSION_LIMIT).toBe(10);
  });

  it.each([
    ["1", 1],
    ["5", 5],
    [String(MAX_ANSWER_LIMIT), MAX_ANSWER_LIMIT],
  ])("accepts %s", (arg, expected) => {
    expect(parseLimit(arg)).toBe(expected);
  });

  it.each(["", "0", String(MAX_ANSWER_LIMIT + 1), "-1", "2.5", "ten", "5 6"])("rejects %j", (arg) => {
    expect(parseLimit(arg)).toBeNull();
  });
});
