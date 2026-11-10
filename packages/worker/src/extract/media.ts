import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { QueueType } from "@untangle/shared";
import type { ExtractResult } from "./index.js";

export function extractMediaStub(
  filePath: string,
  queueType: QueueType | "other",
): ExtractResult {
  const st = fs.statSync(filePath);
  const summary = {
    kind: queueType,
    name: path.basename(filePath),
    size: st.size,
    mtimeMs: Math.trunc(st.mtimeMs),
    ext: path.extname(filePath).toLowerCase(),
  };
  const fingerprint = createHash("sha256")
    .update(`${summary.name}|${summary.size}|${summary.mtimeMs}`)
    .digest("hex");
  return { summary, fingerprint };
}
