import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import type { ExtractResult } from "./index.js";

export async function extractXlsx(filePath: string): Promise<ExtractResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const sheets: Array<{
    name: string;
    headers: string[];
    sampleRows: string[][];
  }> = [];

  const fpParts: string[] = [];

  wb.eachSheet((sheet) => {
    const headers: string[] = [];
    const sampleRows: string[][] = [];
    const row1 = sheet.getRow(1);
    row1.eachCell({ includeEmpty: false }, (cell, col) => {
      headers[col - 1] = String(cell.value ?? "");
    });
    const maxSample = Math.min(sheet.rowCount, 6);
    for (let r = 2; r <= maxSample; r++) {
      const row = sheet.getRow(r);
      const vals: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col > 12) return;
        vals[col - 1] = String(cell.value ?? "");
      });
      sampleRows.push(vals);
    }
    sheets.push({ name: sheet.name, headers, sampleRows });
    fpParts.push(`${sheet.name}|${headers.join(",")}`);
  });

  const fingerprint = createHash("sha256")
    .update(fpParts.join("\n"))
    .digest("hex");

  return {
    summary: {
      kind: "xlsx",
      sheetCount: sheets.length,
      sheets,
    },
    fingerprint,
  };
}
