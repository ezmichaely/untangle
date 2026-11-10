import { describe, expect, it } from "vitest";
import {
  normalizeFolderName,
  polishPlacement,
  listTopLevelCategories,
} from "./categories.js";

describe("normalizeFolderName", () => {
  it("splits glued CamelCase", () => {
    expect(normalizeFolderName("Content MigrationWebsite Pages")).toBe(
      "Content Migration Website Pages",
    );
    expect(normalizeFolderName("Election StatisticsVoter Turnout")).toBe(
      "Election Statistics Voter Turnout",
    );
  });
});

describe("polishPlacement", () => {
  it("reuses Election Statistics for related election files", () => {
    const out = polishPlacement(
      "Election StatisticsVoter Turnout by Demographics",
      undefined,
      ["Election Statistics", "Content Migration"],
    );
    expect(out.category).toBe("Election Statistics");
    expect(out.subcategory?.toLowerCase()).toContain("voter");
  });

  it("collapses to a short shared keyword folder when present", () => {
    const out = polishPlacement("Election Turnout Report", undefined, [
      "Election",
    ]);
    expect(out.category).toBe("Election");
    expect(out.subcategory?.toLowerCase()).toContain("turnout");
  });

  it("keeps short new topics to at most two words", () => {
    const out = polishPlacement(
      "Annual Budget Planning Spreadsheet Archive",
      undefined,
      [],
    );
    expect(out.category.split(" ").length).toBeLessThanOrEqual(2);
    expect(out.subcategory).toBeTruthy();
  });
});

describe("listTopLevelCategories", () => {
  it("dedupes first path segments", () => {
    expect(
      listTopLevelCategories([
        "Election Statistics/a.xlsx",
        "Election Statistics/b.xlsx",
        "Finance/c.xlsx",
      ]),
    ).toEqual(["Election Statistics", "Finance"]);
  });
});
