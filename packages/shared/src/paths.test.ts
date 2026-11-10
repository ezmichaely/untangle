import { describe, expect, it } from "vitest";
import { uniqueDestPath } from "./paths.js";

describe("uniqueDestPath", () => {
  it("returns desired path when free", () => {
    expect(uniqueDestPath("/u/Finance/a.xlsx", () => false)).toBe(
      "/u/Finance/a.xlsx",
    );
  });

  it("appends (n) before extension on collision", () => {
    const taken = new Set(["/u/Finance/a.xlsx", "/u/Finance/a (2).xlsx"]);
    const exists = (p: string) => taken.has(p);
    expect(uniqueDestPath("/u/Finance/a.xlsx", exists)).toBe(
      "/u/Finance/a (3).xlsx",
    );
  });

  it("handles files without extension", () => {
    const exists = (p: string) => p === "/u/notes";
    expect(uniqueDestPath("/u/notes", exists)).toBe("/u/notes (2)");
  });
});
