import mammoth from "mammoth";
import { createHash } from "node:crypto";
import type { ExtractResult } from "./index.js";

export async function extractDocx(filePath: string): Promise<ExtractResult> {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = (result.value || "").replace(/\s+/g, " ").trim();
  const sample = text.slice(0, 3_000);
  const fingerprint = createHash("sha256").update(text).digest("hex");
  return {
    summary: {
      kind: "docx",
      titleGuess: sample.slice(0, 120),
      text: sample,
      length: text.length,
    },
    fingerprint,
  };
}
