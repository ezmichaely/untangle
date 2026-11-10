import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { getRoots, setRoots } from "./roots.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("db + roots", () => {
  it("persists dual roots", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-db-"));
    tmpDirs.push(dir);
    const db = openDb(path.join(dir, "t.db"));
    expect(getRoots(db)).toBeNull();
    setRoots(db, { messyPath: "/m", untanglePath: "/u" });
    expect(getRoots(db)).toEqual({ messyPath: "/m", untanglePath: "/u" });
    db.close();
  });
});
