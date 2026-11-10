import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UntangleService } from "./service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("library analysis", () => {
  it("clears stale topic examples when a fresh analysis starts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-fresh-analysis-"));
    tempDirs.push(dir);
    const service = new UntangleService(path.join(dir, "untangle.db"));
    service.db.prepare(
      `INSERT INTO topic_context(category, description, examples_json, updated_at)
       VALUES('Election', 'old assignment', '[]', '2026-11-10')`,
    ).run();

    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    await service.handle({ type: "analyzeLibrary" }, (event) => {
      if (event.type === "done" && event.command === "analyzeLibrary") finish();
    });
    await completed;

    const row = service.db.prepare(`SELECT COUNT(*) AS count FROM topic_context`).get() as { count: number };
    expect(row.count).toBe(0);
    service.db.close();
  });

  it("starts in the background and reads the library in 20-file chunks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-analysis-"));
    tempDirs.push(dir);
    const service = new UntangleService(path.join(dir, "untangle.db"));
    for (let i = 0; i < 21; i += 1) {
      const file = path.join(dir, `file-${i}.txt`);
      fs.writeFileSync(file, `file ${i}`);
      service.db.prepare(
        `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status)
         VALUES(?, 6, 1, '.txt', 'other', ?, 'seen')`,
      ).run(file, `sha-${i}`);
    }

    const events: Array<{ type: string; current?: number; total?: number; message?: string }> = [];
    let finish!: (event: { type: string; result?: unknown }) => void;
    const completed = new Promise<{ type: string; result?: unknown }>((resolve) => {
      finish = resolve;
    });
    const started = await service.handle({ type: "analyzeLibrary" }, (event) => {
      if (event.type === "progress") events.push(event);
      if (event.type === "done" && event.command === "analyzeLibrary") finish(event);
    }) as { started: boolean; active: boolean };

    expect(started).toMatchObject({ started: true, active: true });
    const done = await completed;
    expect(events.some((event) => event.message?.includes("Read 20 files"))).toBe(true);
    expect(done.result).toMatchObject({ total: 21, processed: 21, needsModel: 21, remaining: 0 });
    service.db.close();
  });
});
