import fs from "node:fs";
import path from "node:path";
import type { QueueType } from "@untangle/shared";
import { extractXlsx } from "./xlsx.js";
import { extractDocx } from "./docx.js";
import { extractPdf } from "./pdf.js";
import { extractPptx } from "./pptx.js";
import { extractMediaStub } from "./media.js";

export interface ExtractResult {
  summary: Record<string, unknown>;
  fingerprint: string;
}

const SUMMARY_CAP = 8_000;

export function capSummary(summary: Record<string, unknown>): Record<string, unknown> {
  let json = JSON.stringify(summary);
  if (json.length <= SUMMARY_CAP) return summary;
  const clone: Record<string, unknown> = { ...summary, _truncated: true };
  if (typeof clone.sample === "string") {
    clone.sample = clone.sample.slice(0, 2_000);
  }
  if (typeof clone.text === "string") {
    clone.text = clone.text.slice(0, 2_000);
  }
  json = JSON.stringify(clone);
  if (json.length > SUMMARY_CAP) {
    return {
      kind: summary.kind ?? "unknown",
      _truncated: true,
      text: JSON.stringify(summary).slice(0, 1_500),
    };
  }
  return clone;
}

export async function extractFile(
  filePath: string,
  queueType: QueueType,
): Promise<ExtractResult> {
  let result: ExtractResult;
  switch (queueType) {
    case "xlsx":
      result = await extractXlsx(filePath);
      break;
    case "docx":
      result = await extractDocx(filePath);
      break;
    case "pdf":
      result = await extractPdf(filePath);
      break;
    case "pptx":
      result = await extractPptx(filePath);
      break;
    case "images":
    case "videos":
      result = extractMediaStub(filePath, queueType);
      break;
    default:
      result = extractMediaStub(filePath, "other");
  }
  return {
    summary: capSummary(result.summary),
    fingerprint: result.fingerprint,
  };
}

export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function basenameOf(p: string): string {
  return path.basename(p);
}
