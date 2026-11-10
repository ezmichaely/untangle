import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { setRoots } from "./roots.js";
import { approveAndMove, undoLastAction, listActions } from "./moves.js";
import { hashFile } from "./scan.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("approveAndMove", () => {
  it("moves with collision rename and supports undo", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-mv-"));
    tmpDirs.push(root);
    const messy = path.join(root, "Messy");
    const untangle = path.join(root, "Untangle");
    fs.mkdirSync(messy, { recursive: true });
    fs.mkdirSync(path.join(untangle, "Finance"), { recursive: true });
    const src = path.join(messy, "report.xlsx");
    fs.writeFileSync(src, "payload-one");
    // occupying destination
    fs.writeFileSync(path.join(untangle, "Finance", "report.xlsx"), "taken");

    const db = openDb(path.join(root, "t.db"));
    setRoots(db, { messyPath: messy, untanglePath: untangle });
    const sha = hashFile(src);
    const fileId = (
      db
        .prepare(
          `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status)
           VALUES(?, ?, 1, '.xlsx', 'xlsx', ?, 'proposed') RETURNING id`,
        )
        .get(src, fs.statSync(src).size, sha) as { id: number }
    ).id;
    const proposalId = (
      db
        .prepare(
          `INSERT INTO proposals(file_id, suggested_relpath, confidence, evidence_json)
           VALUES(?, 'Finance/report.xlsx', 1, '{}') RETURNING id`,
        )
        .get(fileId) as { id: number }
    ).id;

    const result = approveAndMove(db, proposalId);
    expect(result.afterPath.endsWith("report (2).xlsx")).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(result.afterPath)).toBe(true);
    expect(hashFile(result.afterPath)).toBe(sha);

    const undone = undoLastAction(db);
    expect(undone.undone).toBe(true);
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.existsSync(result.afterPath)).toBe(false);
    expect(listActions(db)[0].undone).toBe(true);
    db.close();
  });

  it("avoids UNIQUE(files.path) when an already-moved twin claims the dest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-mv-dup-"));
    tmpDirs.push(root);
    const messy = path.join(root, "Messy");
    const untangle = path.join(root, "Untangle");
    const destDir = path.join(untangle, "Election");
    fs.mkdirSync(messy, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });

    const twinPath = path.join(destDir, "report.xlsx");
    const copyPath = path.join(messy, "report.xlsx");
    fs.writeFileSync(twinPath, "same-bytes");
    fs.writeFileSync(copyPath, "same-bytes");

    const db = openDb(path.join(root, "t.db"));
    setRoots(db, { messyPath: messy, untanglePath: untangle });
    const sha = hashFile(copyPath);

    db.prepare(
      `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status)
       VALUES(?, ?, 1, '.xlsx', 'xlsx', ?, 'moved')`,
    ).run(twinPath, fs.statSync(twinPath).size, sha);

    const fileId = (
      db
        .prepare(
          `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status)
           VALUES(?, ?, 1, '.xlsx', 'xlsx', ?, 'proposed') RETURNING id`,
        )
        .get(copyPath, fs.statSync(copyPath).size, sha) as { id: number }
    ).id;
    const proposalId = (
      db
        .prepare(
          `INSERT INTO proposals(file_id, suggested_relpath, confidence, evidence_json)
           VALUES(?, 'Election/report.xlsx', 1, '{}') RETURNING id`,
        )
        .get(fileId) as { id: number }
    ).id;

    const result = approveAndMove(db, proposalId);
    expect(result.afterPath).not.toBe(twinPath);
    expect(result.afterPath.endsWith("report (2).xlsx")).toBe(true);
    expect(fs.existsSync(result.afterPath)).toBe(true);
    expect(fs.existsSync(twinPath)).toBe(true);

    const paths = db
      .prepare(`SELECT path FROM files ORDER BY id`)
      .all() as Array<{ path: string }>;
    expect(new Set(paths.map((p) => p.path)).size).toBe(paths.length);
    db.close();
  });

  it("avoids UNIQUE(files.path) when dest is free on disk but claimed in DB", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-mv-stale-"));
    tmpDirs.push(root);
    const messy = path.join(root, "Messy");
    const untangle = path.join(root, "Untangle");
    const destDir = path.join(untangle, "Election");
    fs.mkdirSync(messy, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });

    const claimedPath = path.join(destDir, "report.xlsx");
    const copyPath = path.join(messy, "report.xlsx");
    fs.writeFileSync(copyPath, "copy-bytes");
    // Claimed in DB only — no file on disk at claimedPath

    const db = openDb(path.join(root, "t.db"));
    setRoots(db, { messyPath: messy, untanglePath: untangle });
    const sha = hashFile(copyPath);

    db.prepare(
      `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status)
       VALUES(?, 11, 1, '.xlsx', 'xlsx', ?, 'moved')`,
    ).run(claimedPath, "deadbeef");

    const fileId = (
      db
        .prepare(
          `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status)
           VALUES(?, ?, 1, '.xlsx', 'xlsx', ?, 'proposed') RETURNING id`,
        )
        .get(copyPath, fs.statSync(copyPath).size, sha) as { id: number }
    ).id;
    const proposalId = (
      db
        .prepare(
          `INSERT INTO proposals(file_id, suggested_relpath, confidence, evidence_json)
           VALUES(?, 'Election/report.xlsx', 1, '{}') RETURNING id`,
        )
        .get(fileId) as { id: number }
    ).id;

    const result = approveAndMove(db, proposalId);
    expect(result.afterPath).not.toBe(claimedPath);
    expect(fs.existsSync(result.afterPath)).toBe(true);
    db.close();
  });
});
