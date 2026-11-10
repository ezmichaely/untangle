import type { QueueType } from "@untangle/shared";
import type { Db } from "../db.js";
import type { ProgressFn } from "../scan.js";
import { extractFile } from "./index.js";

export async function extractTypeBatch(
  db: Db,
  queueType: QueueType | null,
  limit = 100,
  onProgress?: ProgressFn,
  afterId = 0,
): Promise<{ extracted: number; failed: number; scanned: number; lastId: number | null }> {
  const rows = db
    .prepare(
      `SELECT id, path, queue_type FROM files
       WHERE (? IS NULL OR queue_type = ?) AND status = 'seen' AND sha256 IS NOT NULL AND id > ?
       ORDER BY id LIMIT ?`,
    )
    .all(queueType, queueType, afterId, limit) as Array<{
      id: number;
      path: string;
      queue_type: QueueType;
    }>;

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
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await extractFile(row.path, queueType ?? row.queue_type);
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
      failed += 1;
      if (queueType === null) {
        db.prepare(`UPDATE files SET status = 'extract_failed' WHERE id = ?`).run(row.id);
      }
      onProgress?.({
        phase: "extract",
        current: extracted,
        total: rows.length,
        message: `failed: ${row.path}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { extracted, failed, scanned: rows.length, lastId: rows.at(-1)?.id ?? null };
}

export function extractLibraryBatch(
  db: Db,
  limit = 20,
  afterId = 0,
  onProgress?: ProgressFn,
): Promise<{ extracted: number; failed: number; scanned: number; lastId: number | null }> {
  return extractTypeBatch(db, null, limit, onProgress, afterId);
}
