import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { setRoots } from "./roots.js";
import { proposeBatch, listProposals, proposeLibraryBatch } from "./propose.js";
import type { ClassifyInput, ClassifyOutput } from "./ollama.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function seedExtracted(dbPath: string, filePath: string, sha: string, summary: object) {
  const db = openDb(dbPath);
  setRoots(db, {
    messyPath: path.dirname(filePath),
    untanglePath: path.join(path.dirname(dbPath), "U"),
  });
  const info = db
    .prepare(
      `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status, fingerprint)
       VALUES(?, 1, 1, '.xlsx', 'xlsx', ?, 'extracted', 'fp1') RETURNING id`,
    )
    .get(filePath, sha) as { id: number };
  db.prepare(
    `INSERT INTO extractions(file_id, summary_json, fingerprint) VALUES(?, ?, 'fp1')`,
  ).run(info.id, JSON.stringify(summary));
  return { db, fileId: info.id };
}

describe("proposeBatch", () => {
  it("uses local vision evidence when analyzing an image", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-image-topic-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "dumbbells.png");
    fs.writeFileSync(file, Buffer.from("local image bytes"));
    const { db } = seedExtracted(path.join(dir, "t.db"), file, "image-sha", {
      kind: "images", name: "dumbbells.png", size: 17, ext: ".png",
    });
    db.prepare(`UPDATE files SET queue_type = 'images'`).run();

    let visionInput: { filename: string; imageBase64: string } | undefined;
    let analystFile: { summary: Record<string, unknown>; evidenceQuality: string } | undefined;
    const fake = {
      async status() { return { ok: true, model: "test" }; },
      async describeImage(input: { filename: string; imageBase64: string }) {
        visionInput = input;
        return "A pair of adjustable dumbbells on a gym floor.";
      },
      async analyzeBatch({ files }: { files: Array<{ summary: Record<string, unknown>; evidenceQuality: string }> }) {
        analystFile = files[0];
        return { groups: [{
          category: "Fitness", fileIds: [1], confidence: 0.9,
          rationale: "The image visibly shows dumbbells.", evidenceQuality: "content" as const,
        }] };
      },
    };

    await proposeLibraryBatch(db, 8, fake);
    expect(visionInput).toEqual({ model: "qwen2.5vl:7b", filename: "dumbbells.png", imageBase64: Buffer.from("local image bytes").toString("base64") });
    expect(analystFile?.summary.visualDescription).toBe("A pair of adjustable dumbbells on a gym floor.");
    expect(analystFile?.evidenceQuality).toBe("content");
    db.close();
  });

  it("marks a PDF with no extracted text as metadata evidence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-empty-pdf-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "dumbbells.pdf");
    fs.writeFileSync(file, "x");
    const { db } = seedExtracted(path.join(dir, "t.db"), file, "pdf-sha", {
      kind: "pdf", pages: 1, text: "", length: 0,
    });
    db.prepare(`UPDATE files SET queue_type = 'pdf'`).run();

    let quality: string | undefined;
    const fake = {
      async status() { return { ok: true, model: "test" }; },
      async analyzeBatch({ files }: { files: Array<{ evidenceQuality: string }> }) {
        quality = files[0]?.evidenceQuality;
        return { groups: [{
          category: "Fitness", fileIds: [1], confidence: 0.5,
          rationale: "filename only", evidenceQuality: "metadata" as const,
        }] };
      },
    };

    await proposeLibraryBatch(db, 8, fake);
    expect(quality).toBe("metadata");
    db.close();
  });

  it("marks needs_model when ollama fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-p-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "a.xlsx");
    fs.writeFileSync(file, "x");
    const { db } = seedExtracted(path.join(dir, "t.db"), file, "aaa", {
      kind: "xlsx",
    });

    const fake = {
      async status() {
        return { ok: false, model: "x", error: "down" };
      },
      async classify(_input: ClassifyInput): Promise<ClassifyOutput> {
        throw new Error("should not call");
      },
    };

    const result = await proposeBatch(db, "xlsx", 10, fake);
    expect(result.needsModel).toBe(1);
    expect(result.proposed).toBe(0);
    const status = db
      .prepare(`SELECT status FROM files`)
      .get() as { status: string };
    expect(status.status).toBe("needs_model");
    db.close();
  });

  it("creates proposal from ollama JSON", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-p2-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "budget.xlsx");
    fs.writeFileSync(file, "x");
    const { db } = seedExtracted(path.join(dir, "t.db"), file, "bbb", {
      kind: "xlsx",
    });

    const fake = {
      async status() {
        return { ok: true, model: "qwen2.5:7b" };
      },
      async classify(): Promise<ClassifyOutput> {
        return {
          category: "Finance",
          subcategory: "Budgets",
          confidence: 0.9,
          rationale: "budget sheet",
        };
      },
    };

    const result = await proposeBatch(db, "xlsx", 10, fake);
    expect(result.proposed).toBe(1);
    const proposals = listProposals(db);
    expect(proposals[0].suggestedRelpath).toBe("Finance/Budgets/budget.xlsx");
    expect(proposals[0].confidence).toBe(0.9);
    db.close();
  });

  it("flags exact sha duplicate against moved file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-p3-"));
    tmpDirs.push(dir);
    const messy = path.join(dir, "M");
    const untangle = path.join(dir, "U");
    fs.mkdirSync(messy, { recursive: true });
    fs.mkdirSync(path.join(untangle, "Finance"), { recursive: true });
    const moved = path.join(untangle, "Finance", "a.xlsx");
    const dup = path.join(messy, "a copy.xlsx");
    fs.writeFileSync(moved, "same");
    fs.writeFileSync(dup, "same");

    const db = openDb(path.join(dir, "t.db"));
    setRoots(db, { messyPath: messy, untanglePath: untangle });
    const movedId = (
      db
        .prepare(
          `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status, fingerprint)
           VALUES(?, 4, 1, '.xlsx', 'xlsx', 'deadbeef', 'moved', 'fpX') RETURNING id`,
        )
        .get(moved) as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO proposals(file_id, suggested_relpath, confidence, evidence_json, model)
       VALUES(?, 'Finance/a.xlsx', 1, '{}', NULL)`,
    ).run(movedId);

    const dupId = (
      db
        .prepare(
          `INSERT INTO files(path, size, mtime_ms, ext, queue_type, sha256, status, fingerprint)
           VALUES(?, 4, 1, '.xlsx', 'xlsx', 'deadbeef', 'extracted', 'fpY') RETURNING id`,
        )
        .get(dup) as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO extractions(file_id, summary_json, fingerprint) VALUES(?, '{}', 'fpY')`,
    ).run(dupId);

    const fake = {
      async status() {
        return { ok: true, model: "x" };
      },
      async classify(): Promise<ClassifyOutput> {
        throw new Error("should use exact rule");
      },
    };

    await proposeBatch(db, "xlsx", 10, fake);
    const proposals = listProposals(db);
    expect(proposals[0].suggestedRelpath).toBe("Finance/a copy.xlsx");
    expect((proposals[0].evidence as { rule: string }).rule).toBe(
      "exact_sha256_duplicate",
    );
    db.close();
  });
});
