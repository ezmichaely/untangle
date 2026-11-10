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

function updateApprovedTopicContext(db: Db, fileId: number, category: string): void {
  const row = db.prepare(
    `SELECT f.path, f.queue_type, e.summary_json, p.evidence_json
     FROM files f JOIN extractions e ON e.file_id = f.id
     JOIN proposals p ON p.file_id = f.id WHERE f.id = ?`,
  ).get(fileId) as {
    path: string;
    queue_type: string;
    summary_json: string;
    evidence_json: string;
  } | undefined;
  if (!row) return;

  const contexts = db.prepare(`SELECT category, examples_json FROM topic_context`).all() as Array<{
    category: string;
    examples_json: string;
  }>;
  for (const context of contexts) {
    try {
      const examples = JSON.parse(context.examples_json) as Array<{ id?: number }>;
      const filtered = examples.filter((example) => example.id !== fileId);
      if (filtered.length !== examples.length) {
        db.prepare(`UPDATE topic_context SET examples_json = ? WHERE category = ?`).run(
          JSON.stringify(filtered),
          context.category,
        );
      }
    } catch {
      // A malformed topic memory must not block an approved move.
    }
  }

  let summary: Record<string, unknown> = {};
  let rationale = "";
  try {
    summary = JSON.parse(row.summary_json) as Record<string, unknown>;
    const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
    if (typeof evidence.rationale === "string") rationale = evidence.rationale.slice(0, 300);
  } catch {
    // Keep an empty summary and retain the approved category.
  }
  const serialized = JSON.stringify(summary);
  const exampleSummary = serialized.length <= 700
    ? serialized
    : JSON.stringify({ kind: summary.kind ?? "unknown", excerpt: serialized.slice(0, 400) });
  const current = db.prepare(
    `SELECT description, examples_json FROM topic_context WHERE category = ?`,
  ).get(category) as { description: string; examples_json: string } | undefined;
  let examples: Array<{ id?: number; filename: string; queueType: string; summary: string }> = [];
  try {
    examples = current ? JSON.parse(current.examples_json) as typeof examples : [];
  } catch {
    examples = [];
  }
  examples = [
    ...examples.filter((example) => example.id !== fileId),
    {
      id: fileId,
      filename: path.basename(row.path),
      queueType: row.queue_type,
      summary: exampleSummary,
    },
  ].slice(-2);
  db.prepare(
    `INSERT INTO topic_context(category, description, examples_json, updated_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(category) DO UPDATE SET
       description = CASE WHEN excluded.description = '' THEN topic_context.description ELSE excluded.description END,
       examples_json = excluded.examples_json,
       updated_at = excluded.updated_at`,
  ).run(category, rationale, JSON.stringify(examples), new Date().toISOString());
  db.prepare(
    `DELETE FROM topic_context WHERE category IN (
       SELECT category FROM topic_context
       ORDER BY updated_at DESC, category LIMIT -1 OFFSET 200
     )`,
  ).run();
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

  updateApprovedTopicContext(db, row.fileId, rel.replace(/\\/g, "/").split("/")[0]);

  return { beforePath: row.sourcePath, afterPath: dest };
}

export function approveTopicGroup(
  db: Db,
  topicFolder: string,
  proposalIds: number[],
  skippedProposalIds: number[],
  destinationFolder: string,
): { moved: number; skipped: number; failed: Array<{ proposalId: number; error: string }> } {
  const normalizedTopic = topicFolder.replace(/\\/g, "/");
  const destination = destinationFolder.replace(/\\/g, "/");
  if (destination.startsWith("/")) throw new Error("destination must be a relative folder path");
  const normalizedDestination = destination.replace(/\/+$/g, "");
  const segments = normalizedDestination.split("/");
  if (!normalizedTopic || normalizedTopic.startsWith("/") || normalizedTopic.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("invalid topic folder");
  }
  if (!normalizedDestination || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("destination must be a relative folder path");
  }
  const allIds = [...proposalIds, ...skippedProposalIds];
  if (!allIds.length || new Set(allIds).size !== allIds.length || allIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("topic group must contain unique proposal ids");
  }
  const rows = db.prepare(
    `SELECT p.id, p.suggested_relpath AS suggested, f.path AS sourcePath,
            f.sha256 AS sha256, f.status AS status
     FROM proposals p JOIN files f ON f.id = p.file_id
     WHERE f.status = 'proposed'
     ORDER BY p.id`,
  ).all() as Array<{
    id: number; suggested: string; sourcePath: string; sha256: string | null; status: string;
  }>;
  const groupRows = rows.filter((row) => path.posix.dirname(row.suggested.replace(/\\/g, "/")) === normalizedTopic);
  const actualIds = groupRows.map((row) => row.id).sort((a, b) => a - b);
  const requestedIds = [...allIds].sort((a, b) => a - b);
  if (JSON.stringify(actualIds) !== JSON.stringify(requestedIds)) {
    throw new Error("topic group changed; refresh proposals before approving");
  }
  if (groupRows.some((row) => row.status !== "proposed")) {
    throw new Error("all topic files must still be proposed");
  }

  let moved = 0;
  let skipped = 0;
  const failed: Array<{ proposalId: number; error: string }> = [];
  for (const proposalId of proposalIds) {
    const row = groupRows.find((item) => item.id === proposalId)!;
    try {
      const filename = path.posix.basename(row.suggested.replace(/\\/g, "/"));
      approveAndMove(db, proposalId, `${normalizedDestination}/${filename}`);
      moved++;
    } catch (error) {
      failed.push({ proposalId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const skipOne = db.transaction((proposalId: number) => {
    const row = groupRows.find((item) => item.id === proposalId)!;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO actions(kind, before_path, after_path, sha256, created_at, undone)
      VALUES('skip', ?, ?, ?, ?, 0)`).run(row.sourcePath, row.sourcePath, row.sha256, now);
    db.prepare(`UPDATE files SET status = 'skipped' WHERE path = ? AND status = 'proposed'`).run(row.sourcePath);
  });
  for (const proposalId of skippedProposalIds) {
    try {
      skipOne(proposalId);
      skipped++;
    } catch (error) {
      failed.push({ proposalId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { moved, skipped, failed };
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
  if (row.kind === "skip") {
    db.prepare(`UPDATE files SET status = 'proposed' WHERE path = ? AND status = 'skipped'`).run(row.beforePath);
    db.prepare(`UPDATE actions SET undone = 1 WHERE id = ?`).run(row.id);
    return { ...row, undone: true };
  }
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
