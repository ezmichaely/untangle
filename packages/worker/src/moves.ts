import fs from "node:fs";
import path from "node:path";
import { uniqueDestPath } from "@untangle/shared";
import type { ActionView } from "@untangle/shared";
import type { Db } from "./db.js";
import { getRoots } from "./roots.js";
import { hashFile } from "./scan.js";

function sameVolume(a: string, b: string): boolean {
  // On macOS/Windows, compare resolved root; for same drive letters / mount.
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === "win32") {
    return ra.slice(0, 2).toLowerCase() === rb.slice(0, 2).toLowerCase();
  }
  // Best-effort: if both under same top-level volume path prefix from roots
  return true;
}

function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** True if path is on disk or claimed by another files row (SQLite UNIQUE). */
function pathTaken(
  db: Db,
  absolutePath: string,
  exceptFileId?: number,
): boolean {
  if (pathExists(absolutePath)) return true;
  const row = db
    .prepare(`SELECT id FROM files WHERE path = ?`)
    .get(absolutePath) as { id: number } | undefined;
  if (!row) return false;
  return exceptFileId === undefined || row.id !== exceptFileId;
}

/** Free a stale index row that still claims `absolutePath` but is gone on disk. */
function releaseStalePathClaim(db: Db, absolutePath: string): void {
  if (pathExists(absolutePath)) return;
  const row = db
    .prepare(`SELECT id FROM files WHERE path = ?`)
    .get(absolutePath) as { id: number } | undefined;
  if (!row) return;
  db.prepare(`UPDATE files SET path = ?, status = 'missing' WHERE id = ?`).run(
    `${absolutePath}#missing-${row.id}`,
    row.id,
  );
}

export function moveFileSafe(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (pathExists(dest)) {
    throw new Error(`destination exists: ${dest}`);
  }
  try {
    if (sameVolume(src, dest)) {
      fs.renameSync(src, dest);
      return;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw err;
  }
  // cross-device: copy → verify → delete
  fs.copyFileSync(src, dest);
  const srcHash = hashFile(src);
  const destHash = hashFile(dest);
  if (srcHash !== destHash) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
    throw new Error("copy verify failed");
  }
  fs.unlinkSync(src);
}

export function approveAndMove(
  db: Db,
  proposalId: number,
  destRelpath?: string,
): { beforePath: string; afterPath: string } {
  const roots = getRoots(db);
  if (!roots) throw new Error("Roots not set");

  const row = db
    .prepare(
      `SELECT p.id, p.file_id AS fileId, p.suggested_relpath AS suggested,
              f.path AS sourcePath, f.sha256 AS sha256, f.status AS status
       FROM proposals p
       JOIN files f ON f.id = p.file_id
       WHERE p.id = ?`,
    )
    .get(proposalId) as
    | {
        id: number;
        fileId: number;
        suggested: string;
        sourcePath: string;
        sha256: string | null;
        status: string;
      }
    | undefined;

  if (!row) throw new Error(`proposal not found: ${proposalId}`);
  if (row.status !== "proposed") {
    throw new Error(`file status is ${row.status}, expected proposed`);
  }
  if (!pathExists(row.sourcePath)) {
    throw new Error(`source missing: ${row.sourcePath}`);
  }

  const rel = (destRelpath ?? row.suggested).replace(/^\/+/, "");
  const desired = path.join(roots.untanglePath, rel);
  // Avoid UNIQUE(files.path) when an already-organized twin (or stale row)
  // already claims this destination — even if the disk file was removed.
  const dest = uniqueDestPath(desired, (p) => pathTaken(db, p, row.fileId));

  // Ensure category row for parent
  const parentRel = path.posix.dirname(rel.replace(/\\/g, "/"));
  if (parentRel && parentRel !== ".") {
    db.prepare(
      `INSERT INTO categories(relpath, label) VALUES(?, ?)
       ON CONFLICT(relpath) DO NOTHING`,
    ).run(parentRel, path.posix.basename(parentRel));
  }

  moveFileSafe(row.sourcePath, dest);

  let sha = row.sha256;
  try {
    sha = hashFile(dest);
  } catch {
    /* keep prior */
  }
  if (row.sha256 && sha && row.sha256 !== sha) {
    // unexpected mutation — still journal but surface
    throw new Error("destination hash mismatch after move");
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO actions(kind, before_path, after_path, sha256, created_at, undone)
     VALUES('move', ?, ?, ?, ?, 0)`,
  ).run(row.sourcePath, dest, sha, now);

  db.prepare(
    `UPDATE files SET path = ?, status = 'moved' WHERE id = ?`,
  ).run(dest, row.fileId);

  if (destRelpath) {
    db.prepare(`UPDATE proposals SET suggested_relpath = ? WHERE id = ?`).run(
      rel,
      proposalId,
    );
  }

  return { beforePath: row.sourcePath, afterPath: dest };
}

export function undoLastAction(db: Db): ActionView {
  const row = db
    .prepare(
      `SELECT id, kind, before_path AS beforePath, after_path AS afterPath,
              sha256, created_at AS createdAt, undone
       FROM actions
       WHERE undone = 0
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as
    | {
        id: number;
        kind: string;
        beforePath: string;
        afterPath: string;
        sha256: string | null;
        createdAt: string;
        undone: number;
      }
    | undefined;

  if (!row) throw new Error("no actions to undo");
  if (row.kind !== "move" && row.kind !== "archive") {
    throw new Error(`cannot undo kind ${row.kind}`);
  }
  if (!pathExists(row.afterPath)) {
    throw new Error(`undo target missing: ${row.afterPath}`);
  }
  if (pathExists(row.beforePath)) {
    throw new Error(`undo source already occupied: ${row.beforePath}`);
  }
  // Exact-copy / rescan rows can still claim beforePath in SQLite after the
  // disk file was removed — free that claim so UNIQUE(path) won't fail.
  releaseStalePathClaim(db, row.beforePath);

  moveFileSafe(row.afterPath, row.beforePath);
  db.prepare(`UPDATE actions SET undone = 1 WHERE id = ?`).run(row.id);

  const nextStatus = row.kind === "archive" ? "moved" : "proposed";
  db.prepare(`UPDATE files SET path = ?, status = ? WHERE path = ?`).run(
    row.beforePath,
    nextStatus,
    row.afterPath,
  );

  return {
    id: row.id,
    kind: row.kind,
    beforePath: row.beforePath,
    afterPath: row.afterPath,
    sha256: row.sha256,
    createdAt: row.createdAt,
    undone: true,
  };
}

export function listActions(db: Db, limit = 50): ActionView[] {
  const rows = db
    .prepare(
      `SELECT id, kind, before_path AS beforePath, after_path AS afterPath,
              sha256, created_at AS createdAt, undone
       FROM actions ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    kind: string;
    beforePath: string;
    afterPath: string;
    sha256: string | null;
    createdAt: string;
    undone: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    beforePath: r.beforePath,
    afterPath: r.afterPath,
    sha256: r.sha256,
    createdAt: r.createdAt,
    undone: !!r.undone,
  }));
}
