import fs from "node:fs";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import type { ExtractResult } from "./index.js";

function stripXml(xml: string): string {
  return xml
    .replace(/<a:t[^>]*>/g, "")
    .replace(/<\/a:t>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function extractPptx(filePath: string): Promise<ExtractResult> {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort();

  const slides: string[] = [];
  for (const name of slideNames.slice(0, 20)) {
    const xml = await zip.files[name].async("string");
    const text = stripXml(xml);
    if (text) slides.push(text.slice(0, 500));
  }

  const joined = slides.join("\n");
  const fingerprint = createHash("sha256").update(joined).digest("hex");
  return {
    summary: {
      kind: "pptx",
      slideCount: slideNames.length,
      text: joined.slice(0, 3_000),
    },
    fingerprint,
  };
}
