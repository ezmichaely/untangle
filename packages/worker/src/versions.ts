import fs from "node:fs";
import path from "node:path";
import { uniqueDestPath, type VersionGroupView } from "@untangle/shared";
import type { Db } from "./db.js";
import { getRoots } from "./roots.js";
import { summaryMismatches } from "./diff.js";
import { moveFileSafe } from "./moves.js";
import { hashFile } from "./scan.js";

function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function findVersionGroups(db: Db): VersionGroupView[] {
  // Clear prior ephemeral groups
  db.exec(`DELETE FROM version_members; DELETE FROM version_groups;`);

  const groups: VersionGroupView[] = [];

  // Exact hash clusters among moved files
  const exact = db
    .prepare(
      `SELECT sha256 FROM files
       WHERE status IN ('moved','archived') AND sha256 IS NOT NULL
       GROUP BY sha256 HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ sha256: string }>;

  for (const { sha256 } of exact) {
    const members = db
      .prepare(
        `SELECT id AS fileId, path, sha256 FROM files WHERE sha256 = ? AND status IN ('moved','archived')`,
      )
      .all(sha256) as Array<{ fileId: number; path: string; sha256: string }>;

    const info = db
      .prepare(
        `INSERT INTO version_groups(kind, summary_json) VALUES('exact', ?) RETURNING id`,
      )
      .get(JSON.stringify({ sha256, count: members.length })) as { id: number };

    const insertMember = db.prepare(
      `INSERT INTO version_members(group_id, file_id) VALUES(?, ?)`,
    );
    for (const m of members) insertMember.run(info.id, m.fileId);

    groups.push({
      id: info.id,
      kind: "exact",
      summary: { sha256, count: members.length },
      members: members.map((m) => ({
        fileId: m.fileId,
        path: m.path,
        sha256: m.sha256,
      })),
      mismatches: [],
    });
  }

  // Near duplicates: same fingerprint, different sha, among moved
  const nearKeys = db
    .prepare(
      `SELECT fingerprint FROM files
       WHERE status = 'moved' AND fingerprint IS NOT NULL
       GROUP BY fingerprint HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ fingerprint: string }>;

  for (const { fingerprint } of nearKeys) {
    const members = db
      .prepare(
        `SELECT id AS fileId, path, sha256 FROM files
         WHERE fingerprint = ? AND status = 'moved'`,
      )
      .all(fingerprint) as Array<{
      fileId: number;
      path: string;
      sha256: string | null;
    }>;

    const shas = new Set(members.map((m) => m.sha256).filter(Boolean));
    if (shas.size <= 1) continue; // already covered as exact

    const summaries = members.map((m) => {
      const row = db
        .prepare(`SELECT summary_json FROM extractions WHERE file_id = ?`)
        .get(m.fileId) as { summary_json: string } | undefined;
      return row
        ? (JSON.parse(row.summary_json) as Record<string, unknown>)
        : {};
    });

    const mismatches =
      summaries.length >= 2
        ? summaryMismatches(summaries[0], summaries[1])
        : [];

    const info = db
      .prepare(
        `INSERT INTO version_groups(kind, summary_json) VALUES('near', ?) RETURNING id`,
      )
      .get(
        JSON.stringify({ fingerprint, count: members.length, mismatches }),
      ) as { id: number };

    const insertMember = db.prepare(
      `INSERT INTO version_members(group_id, file_id) VALUES(?, ?)`,
    );
    for (const m of members) insertMember.run(info.id, m.fileId);

    groups.push({
      id: info.id,
      kind: "near",
      summary: { fingerprint, count: members.length },
      members: members.map((m) => ({
        fileId: m.fileId,
        path: m.path,
        sha256: m.sha256,
      })),
      mismatches,
    });
  }

  return groups;
}

export function pickWinner(
  db: Db,
  groupId: number,
  winnerFileId: number,
): { archived: string[]; winnerPath: string } {
  const roots = getRoots(db);
  if (!roots) throw new Error("Roots not set");

  const group = db
    .prepare(`SELECT id, kind FROM version_groups WHERE id = ?`)
    .get(groupId) as { id: number; kind: string } | undefined;
  if (!group) throw new Error(`group not found: ${groupId}`);

  const members = db
    .prepare(
      `SELECT f.id AS fileId, f.path, f.sha256
       FROM version_members vm
       JOIN files f ON f.id = vm.file_id
       WHERE vm.group_id = ?`,
    )
    .all(groupId) as Array<{
    fileId: number;
    path: string;
    sha256: string | null;
  }>;

  if (!members.some((m) => m.fileId === winnerFileId)) {
    throw new Error("winner not in group");
  }

  const winner = members.find((m) => m.fileId === winnerFileId)!;
  const archived: string[] = [];
  const archiveRoot = path.join(roots.untanglePath, "_Archive");

  for (const m of members) {
    if (m.fileId === winnerFileId) continue;
    if (!pathExists(m.path)) continue;

    const rel = path.relative(roots.untanglePath, m.path);
    const desired = path.join(archiveRoot, rel);
    const dest = uniqueDestPath(desired, (p) => {
      if (pathExists(p)) return true;
      const claimed = db
        .prepare(`SELECT id FROM files WHERE path = ?`)
        .get(p) as { id: number } | undefined;
      return !!claimed && claimed.id !== m.fileId;
    });
    moveFileSafe(m.path, dest);

    let sha = m.sha256;
    try {
      sha = hashFile(dest);
    } catch {
      /* keep */
    }

    db.prepare(
      `INSERT INTO actions(kind, before_path, after_path, sha256, created_at, undone)
       VALUES('archive', ?, ?, ?, ?, 0)`,
    ).run(m.path, dest, sha, new Date().toISOString());

    db.prepare(`UPDATE files SET path = ?, status = 'archived' WHERE id = ?`).run(
      dest,
      m.fileId,
    );
    archived.push(dest);
  }

  return { archived, winnerPath: winner.path };
}
