import { describe, expect, it } from "vitest";
import { textMismatches } from "./diff.js";

describe("textMismatches", () => {
  it("lists differing lines", () => {
    expect(textMismatches("a\nb\nc", "a\nx\nc")).toEqual([
      'L2: "b" ≠ "x"',
    ]);
  });
});
