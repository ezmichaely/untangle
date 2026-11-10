import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ExtractResult } from "./index.js";

const require = createRequire(import.meta.url);
// pdf-parse v1 is CJS
const pdfParse = require("pdf-parse") as (
  buf: Buffer,
) => Promise<{ text: string; numpages: number; info?: Record<string, unknown> }>;

export async function extractPdf(filePath: string): Promise<ExtractResult> {
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  const text = (data.text || "").replace(/\s+/g, " ").trim();
  const sample = text.slice(0, 3_000);
  const fingerprint = createHash("sha256").update(text).digest("hex");
  return {
    summary: {
      kind: "pdf",
      pages: data.numpages,
      title: (data.info as { Title?: string } | undefined)?.Title ?? null,
      text: sample,
      length: text.length,
    },
    fingerprint,
  };
}
