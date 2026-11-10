import { describe, expect, it } from "vitest";
import { validateClassify } from "./ollama.js";

describe("validateClassify", () => {
  it("accepts valid payload", () => {
    expect(
      validateClassify({
        category: "Finance",
        subcategory: "Taxes",
        confidence: 0.8,
        rationale: "headers look fiscal",
      }),
    ).toEqual({
      category: "Finance",
      subcategory: "Taxes",
      confidence: 0.8,
      rationale: "headers look fiscal",
    });
  });

  it("rejects garbage", () => {
    expect(() => validateClassify("nope")).toThrow(/non-JSON object/);
    expect(() => validateClassify({ confidence: 1 })).toThrow(/missing category/);
  });
});
