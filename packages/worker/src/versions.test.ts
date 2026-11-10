import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { setRoots } from "./roots.js";
import { findVersionGroups, pickWinner } from "./versions.js";
import { summaryMismatches } from "./diff.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("summaryMismatches", () => {
  it("shows word-level mismatch", () => {
    const m = summaryMismatches(
      { text: "hello world v1" },
      { text: "hello world v2" },
    );
    expect(m.some((x) => x.includes("v1") && x.includes("v2"))).toBe(true);
  });
});

describe("findVersionGroups + pickWinner", () => {
  it("does not group files when their extracted text is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-v-"));
    tmpDirs.push(root);
    const untangle = path.join(root, "Untangle");
    const messy = path.join(root, "Messy");
    fs.mkdirSync(untangle, { recursive: true });
    fs.mkdirSync(messy, { recursive: true });

    const db = openDb(path.join(root, "t.db"));
    setRoots(db, { messyPath: messy, untanglePath: untangle });
    for (const [name, sha] of [["pay.pdf", "pay"], ["certificate.pdf", "cert"]]) {
      const file = path.join(untangle, name);
      fs.writeFileSync(file, name);
      const id = (db.prepare(
        `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, fingerprint, status)
         VALUES(?, 10, 1, '.pdf', 'pdf', ?, 'empty-text', 'moved') RETURNING id`,
      ).get(file, sha) as { id: number }).id;
      db.prepare(`INSERT INTO extractions(file_id, summary_json, fingerprint) VALUES(?, ?, 'empty-text')`)
        .run(id, JSON.stringify({ kind: "pdf", text: "", length: 0 }));
    }

    expect(findVersionGroups(db).filter((g) => g.kind === "near")).toEqual([]);
    db.close();
  });

  it("clusters exact hashes and archives losers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-v-"));
    tmpDirs.push(root);
    const untangle = path.join(root, "Untangle");
    const messy = path.join(root, "Messy");
    fs.mkdirSync(path.join(untangle, "Docs"), { recursive: true });
    fs.mkdirSync(messy, { recursive: true });
    const a = path.join(untangle, "Docs", "a.txt");
    const b = path.join(untangle, "Docs", "b.txt");
    fs.writeFileSync(a, "same-bytes");
    fs.writeFileSync(b, "same-bytes");

    const db = openDb(path.join(root, "t.db"));
    setRoots(db, { messyPath: messy, untanglePath: untangle });
    const idA = (
      db
        .prepare(
          `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status)
           VALUES(?, 10, 1, '.txt', 'other', 'abc', 'moved') RETURNING id`,
        )
        .get(a) as { id: number }
    ).id;
    const idB = (
      db
        .prepare(
          `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status)
           VALUES(?, 10, 1, '.txt', 'other', 'abc', 'moved') RETURNING id`,
        )
        .get(b) as { id: number }
    ).id;

    const groups = findVersionGroups(db);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const exact = groups.find((g) => g.kind === "exact")!;
    expect(exact.members).toHaveLength(2);

    const result = pickWinner(db, exact.id, idA);
    expect(result.winnerPath).toBe(a);
    expect(result.archived).toHaveLength(1);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(result.archived[0])).toBe(true);

    const statusB = db
      .prepare(`SELECT status FROM files WHERE id = ?`)
      .get(idB) as { status: string };
    expect(statusB.status).toBe("archived");
    db.close();
  });
});
