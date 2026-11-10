import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  TYPE_ORDER,
  extToQueueType,
  type InventoryCounts,
  type QueueType,
} from "@untangle/shared";
import type { Db } from "./db.js";
import { getRoots } from "./roots.js";

export type ProgressFn = (p: {
  phase: string;
  current: number;
  total: number;
  message?: string;
}) => void;

function pathExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isUnderRoot(filePath: string, root: string): boolean {
  const resolved = path.resolve(filePath);
  const rootResolved = path.resolve(root);
  return (
    resolved === rootResolved ||
    resolved.startsWith(rootResolved + path.sep)
  );
}

function walkDir(root: string, onFile: (abs: string, st: fs.Stats) => void): void {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        try {
          const st = fs.lstatSync(abs);
          if (st.isFile()) onFile(abs, st);
        } catch {
          /* skip */
        }
      }
    }
  }
}

export interface RefreshResult {
  seen: number;
  upserted: number;
  reclaimed: number;
  missingMoved: number;
}

/**
 * Re-read the Messy folder and sync the index.
 * Detects files the user put back after an Untangle move and reopens them
 * for extract/propose.
 */
export function scanMessy(db: Db, onProgress?: ProgressFn): RefreshResult {
  const roots = getRoots(db);
  if (!roots) throw new Error("Roots not set");

  const diskFiles: Array<{ path: string; size: number; mtime_ms: number; ext: string }> =
    [];
  walkDir(roots.messyPath, (abs, st) => {
    diskFiles.push({
      path: abs,
      size: st.size,
      mtime_ms: Math.trunc(st.mtimeMs),
      ext: path.extname(abs),
    });
  });

  const byPath = db.prepare(`SELECT id, path, size, mtime_ms, sha256, status FROM files WHERE path = ?`);
  const insertNew = db.prepare(`
    INSERT INTO files(path, size, mtime_ms, ext, queue_type, status)
    VALUES(?, ?, ?, ?, ?, 'seen')
  `);
  const updateExisting = db.prepare(`
    UPDATE files SET
      size = @size,
      mtime_ms = @mtime_ms,
      ext = @ext,
      queue_type = @queue_type,
      sha256 = CASE
        WHEN size = @size AND mtime_ms = @mtime_ms THEN sha256
        ELSE NULL
      END,
      status = CASE
        WHEN status IN ('moved', 'archived') THEN status
        WHEN size = @size AND mtime_ms = @mtime_ms THEN status
        ELSE 'seen'
      END
    WHERE id = @id
  `);

  const findMovedMissingByNameSize = db.prepare(`
    SELECT id, path, sha256, status FROM files
    WHERE status IN ('moved', 'archived') AND size = ? AND path LIKE ?
  `);

  const reclaim = db.prepare(`
    UPDATE files SET
      path = @path,
      size = @size,
      mtime_ms = @mtime_ms,
      ext = @ext,
      queue_type = @queue_type,
      sha256 = @sha256,
      status = @status
    WHERE id = @id
  `);

  const deleteProposal = db.prepare(`DELETE FROM proposals WHERE file_id = ?`);
  const hasExtraction = db.prepare(
    `SELECT 1 AS ok FROM extractions WHERE file_id = ?`,
  );

  let seen = 0;
  let upserted = 0;
  let reclaimed = 0;

  const tx = db.transaction(() => {
    for (const file of diskFiles) {
      seen += 1;
      const queue_type = extToQueueType(file.ext);
      const existing = byPath.get(file.path) as
        | {
            id: number;
            path: string;
            size: number;
            mtime_ms: number;
            sha256: string | null;
            status: string;
          }
        | undefined;

      if (existing) {
        // File already indexed at this Messy path — refresh metadata.
        // If it was somehow still marked moved while sitting in Messy, reopen it.
        if (existing.status === "moved" || existing.status === "archived") {
          deleteProposal.run(existing.id);
          const keepExtract =
            existing.sha256 &&
            existing.size === file.size &&
            existing.mtime_ms === file.mtime_ms &&
            hasExtraction.get(existing.id);
          reclaim.run({
            id: existing.id,
            path: file.path,
            size: file.size,
            mtime_ms: file.mtime_ms,
            ext: file.ext,
            queue_type,
            sha256:
              existing.size === file.size && existing.mtime_ms === file.mtime_ms
                ? existing.sha256
                : null,
            status: keepExtract ? "extracted" : "seen",
          });
          reclaimed += 1;
        } else {
          updateExisting.run({
            id: existing.id,
            size: file.size,
            mtime_ms: file.mtime_ms,
            ext: file.ext,
            queue_type,
          });
        }
        upserted += 1;
        continue;
      }

      // New path under Messy — maybe a file the user dragged back from Untangle.
      const base = path.basename(file.path);
      let donor:
        | { id: number; path: string; sha256: string | null; status: string }
        | undefined;

      // Cheap match first: same name + size, old Untangle path gone.
      const byName = findMovedMissingByNameSize.all(
        file.size,
        `%${base}`,
      ) as Array<{
        id: number;
        path: string;
        sha256: string | null;
        status: string;
      }>;
      donor = byName.find(
        (c) => path.basename(c.path) === base && !pathExists(c.path),
      );

      let sha: string | null = null;
      if (!donor) {
        // Hash only when there are missing moved files to match against.
        const missingMoved = (
          db
            .prepare(
              `SELECT id, path, sha256, status FROM files
               WHERE status IN ('moved', 'archived')`,
            )
            .all() as Array<{
            id: number;
            path: string;
            sha256: string | null;
            status: string;
          }>
        ).filter((c) => !pathExists(c.path));

        if (missingMoved.length) {
          try {
            sha = hashFile(file.path);
          } catch {
            sha = null;
          }
          if (sha) {
            donor = missingMoved.find((c) => c.sha256 === sha);
          }
        }
      } else if (donor.sha256) {
        // Verify name/size candidate when we can hash cheaply later; keep sha from donor
        sha = donor.sha256;
      }

      if (donor) {
        deleteProposal.run(donor.id);
        if (!sha) {
          try {
            sha = hashFile(file.path);
          } catch {
            sha = donor.sha256;
          }
        }
        const keepExtract =
          !!sha && donor.sha256 === sha && !!hasExtraction.get(donor.id);
        reclaim.run({
          id: donor.id,
          path: file.path,
          size: file.size,
          mtime_ms: file.mtime_ms,
          ext: file.ext,
          queue_type,
          sha256: sha,
          status: keepExtract ? "extracted" : "seen",
        });
        reclaimed += 1;
        upserted += 1;
        onProgress?.({
          phase: "scan",
          current: seen,
          total: diskFiles.length,
          message: `reclaimed ${path.basename(file.path)}`,
        });
        continue;
      }

      insertNew.run(
        file.path,
        file.size,
        file.mtime_ms,
        file.ext,
        queue_type,
      );
      upserted += 1;
    }
  });
  tx();

  // Moved/archived rows whose destination file is gone and not reclaimed
  let missingMoved = 0;
  const movedRows = db
    .prepare(
      `SELECT id, path FROM files WHERE status IN ('moved', 'archived')`,
    )
    .all() as Array<{ id: number; path: string }>;
  const markMissing = db.prepare(
    `UPDATE files SET status = 'missing' WHERE id = ?`,
  );
  for (const row of movedRows) {
    if (!pathExists(row.path) && !isUnderRoot(row.path, roots.messyPath)) {
      markMissing.run(row.id);
      missingMoved += 1;
    }
  }

  onProgress?.({
    phase: "scan",
    current: seen,
    total: seen,
    message: `scan complete (${reclaimed} returned by hand)`,
  });
  return { seen, upserted, reclaimed, missingMoved };
}

export function hashPending(
  db: Db,
  limit = 500,
  onProgress?: ProgressFn,
): { hashed: number } {
  const rows = db
    .prepare(
      `SELECT id, path FROM files
       WHERE sha256 IS NULL AND status IN ('seen', 'extracted', 'proposed', 'needs_model')
       ORDER BY id LIMIT ?`,
    )
    .all(limit) as Array<{ id: number; path: string }>;

  const update = db.prepare(`UPDATE files SET sha256 = ? WHERE id = ?`);

  let hashed = 0;
  for (const row of rows) {
    try {
      if (!pathExists(row.path)) continue;
      const hash = hashFile(row.path);
      update.run(hash, row.id);
      hashed += 1;
      onProgress?.({
        phase: "hash",
        current: hashed,
        total: rows.length,
        message: row.path,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return { hashed };
}

export function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Inventory of files currently living under the Messy root (work queue). */
export function getInventory(db: Db): InventoryCounts {
  const roots = getRoots(db);
  const messy = roots?.messyPath ? path.resolve(roots.messyPath) : null;

  const rows = db
    .prepare(
      `SELECT path, queue_type AS t, sha256, status FROM files
       WHERE status NOT IN ('moved', 'archived', 'missing')`,
    )
    .all() as Array<{
    path: string;
    t: QueueType;
    sha256: string | null;
    status: string;
  }>;

  const active = messy
    ? rows.filter((r) => isUnderRoot(r.path, messy))
    : rows;

  const byType = Object.fromEntries(
    TYPE_ORDER.map((t) => [t, 0]),
  ) as Record<QueueType, number>;

  let hashed = 0;
  for (const r of active) {
    if (r.t in byType) byType[r.t] += 1;
    if (r.sha256) hashed += 1;
  }

  return { total: active.length, hashed, byType };
}
