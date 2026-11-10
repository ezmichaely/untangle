import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { extractXlsx } from "./xlsx.js";
import { extractMediaStub } from "./media.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("extractXlsx", () => {
  it("captures sheet names and headers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-x-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "t.xlsx");
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Finance");
    sheet.addRow(["Date", "Amount"]);
    sheet.addRow(["2024-01-01", 10]);
    await wb.xlsx.writeFile(file);

    const result = await extractXlsx(file);
    expect(result.summary.kind).toBe("xlsx");
    expect(result.summary.sheetCount).toBe(1);
    const sheets = result.summary.sheets as Array<{ name: string; headers: string[] }>;
    expect(sheets[0].name).toBe("Finance");
    expect(sheets[0].headers).toContain("Date");
    expect(result.fingerprint).toHaveLength(64);
  });
});

describe("extractMediaStub", () => {
  it("stores metadata only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-m-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "x.jpg");
    fs.writeFileSync(file, "abc");
    const result = extractMediaStub(file, "images");
    expect(result.summary.kind).toBe("images");
    expect(result.summary.size).toBe(3);
  });
});
