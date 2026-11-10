import type { QueueType } from "@untangle/shared";
import type { Db } from "../db.js";
import type { ProgressFn } from "../scan.js";
import { extractFile } from "./index.js";

export async function extractTypeBatch(
  db: Db,
  queueType: QueueType,
  limit = 100,
  onProgress?: ProgressFn,
): Promise<{ extracted: number }> {
  const rows = db
    .prepare(
      `SELECT id, path FROM files
       WHERE queue_type = ? AND status IN ('seen') AND sha256 IS NOT NULL
       ORDER BY id LIMIT ?`,
    )
    .all(queueType, limit) as Array<{ id: number; path: string }>;

  const upsertExtraction = db.prepare(`
    INSERT INTO extractions(file_id, summary_json, fingerprint)
    VALUES(?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET
      summary_json = excluded.summary_json,
      fingerprint = excluded.fingerprint
  `);
  const updateFile = db.prepare(`
    UPDATE files SET status = 'extracted', fingerprint = ? WHERE id = ?
  `);

  let extracted = 0;
  for (const row of rows) {
    try {
      const result = await extractFile(row.path, queueType);
      upsertExtraction.run(
        row.id,
        JSON.stringify(result.summary),
        result.fingerprint,
      );
      updateFile.run(result.fingerprint, row.id);
      extracted += 1;
      onProgress?.({
        phase: "extract",
        current: extracted,
        total: rows.length,
        message: row.path,
      });
    } catch (err) {
      onProgress?.({
        phase: "extract",
        current: extracted,
        total: rows.length,
        message: `failed: ${row.path}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { extracted };
}
