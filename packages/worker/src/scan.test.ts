import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { setRoots } from "./roots.js";
import { getInventory, hashFile, hashPending, scanMessy } from "./scan.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function fixtureTree(): { root: string; messy: string; untangle: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-scan-"));
  tmpDirs.push(root);
  const messy = path.join(root, "Messy");
  const untangle = path.join(root, "Untangle");
  fs.mkdirSync(path.join(messy, "sub"), { recursive: true });
  fs.mkdirSync(untangle, { recursive: true });
  fs.writeFileSync(path.join(messy, "a.xlsx"), "fake");
  fs.writeFileSync(path.join(messy, "sub", "b.pdf"), "pdf");
  fs.writeFileSync(path.join(messy, "pic.jpg"), "img");
  return { root, messy, untangle, dbPath: path.join(root, "t.db") };
}

describe("scanMessy", () => {
  it("inventories files by type and resumes hashes", () => {
    const { messy, untangle, dbPath } = fixtureTree();
    const db = openDb(dbPath);
    setRoots(db, { messyPath: messy, untanglePath: untangle });

    const { seen } = scanMessy(db);
    expect(seen).toBe(3);
    const inv = getInventory(db);
    expect(inv.total).toBe(3);
    expect(inv.byType.xlsx).toBe(1);
    expect(inv.byType.pdf).toBe(1);
    expect(inv.byType.images).toBe(1);
    expect(inv.hashed).toBe(0);

    const { hashed } = hashPending(db, 10);
    expect(hashed).toBe(3);
    expect(getInventory(db).hashed).toBe(3);

    // Unchanged re-scan keeps hashes
    scanMessy(db);
    expect(getInventory(db).hashed).toBe(3);

    // Changed file clears hash
    fs.writeFileSync(path.join(messy, "a.xlsx"), "changed");
    // bump mtime
    const p = path.join(messy, "a.xlsx");
    const st = fs.statSync(p);
    fs.utimesSync(p, st.atime, new Date(st.mtimeMs + 1000));
    scanMessy(db);
    const row = db
      .prepare(`SELECT sha256 FROM files WHERE path LIKE '%a.xlsx'`)
      .get() as { sha256: string | null };
    expect(row.sha256).toBeNull();
    db.close();
  });

  it("reclaims a file the user moved back into Messy", () => {
    const { messy, untangle, dbPath } = fixtureTree();
    const db = openDb(dbPath);
    setRoots(db, { messyPath: messy, untanglePath: untangle });

    const src = path.join(messy, "a.xlsx");
    scanMessy(db);
    hashPending(db, 10);
    const sha = hashFile(src);

    const dest = path.join(untangle, "Election", "a.xlsx");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);

    const fileId = (
      db.prepare(`SELECT id FROM files WHERE path = ?`).get(src) as
        | { id: number }
        | undefined
    )?.id;
    // Path may still be messy until we simulate approveAndMove's DB update
    const id =
      fileId ??
      (db.prepare(`SELECT id FROM files WHERE sha256 = ?`).get(sha) as {
        id: number;
      }).id;
    db.prepare(
      `UPDATE files SET path = ?, status = 'moved' WHERE id = ?`,
    ).run(dest, id);
    db.prepare(
      `INSERT INTO proposals(file_id, suggested_relpath, confidence, evidence_json)
       VALUES(?, 'Election/a.xlsx', 1, '{}')`,
    ).run(id);

    // User puts the file back into Messy by hand
    fs.renameSync(dest, src);

    const result = scanMessy(db);
    expect(result.reclaimed).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare(`SELECT path, status FROM files WHERE id = ?`)
      .get(id) as { path: string; status: string };
    expect(row.path).toBe(src);
    expect(["seen", "extracted"]).toContain(row.status);

    const proposal = db
      .prepare(`SELECT id FROM proposals WHERE file_id = ?`)
      .get(id);
    expect(proposal).toBeUndefined();

    const inv = getInventory(db);
    expect(inv.byType.xlsx).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
