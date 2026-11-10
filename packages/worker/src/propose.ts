import path from "node:path";
import type { ProposalView, QueueType } from "@untangle/shared";
import type { Db } from "./db.js";
import { getModel } from "./roots.js";
import { createOllamaClient, type ClassifyOutput } from "./ollama.js";
import {
  listTopLevelCategories,
  normalizeFolderName,
  polishPlacement,
} from "./categories.js";

function relpathFor(
  category: string,
  subcategory: string | undefined,
  filename: string,
): string {
  const parts = [normalizeFolderName(category)];
  if (subcategory) parts.push(normalizeFolderName(subcategory));
  parts.push(filename);
  return parts.join("/");
}

/** All known top-level topic folders (categories table + prior proposals). */
export function listCategories(db: Db): string[] {
  const fromTable = (
    db.prepare(`SELECT relpath FROM categories`).all() as Array<{
      relpath: string;
    }>
  ).map((r) => r.relpath);
  const fromProposals = (
    db.prepare(`SELECT suggested_relpath AS relpath FROM proposals`).all() as Array<{
      relpath: string;
    }>
  ).map((r) => r.relpath);
  return listTopLevelCategories([...fromTable, ...fromProposals]);
}

export function ensureCategory(db: Db, relpath: string, label: string): void {
  db.prepare(
    `INSERT INTO categories(relpath, label) VALUES(?, ?)
     ON CONFLICT(relpath) DO NOTHING`,
  ).run(relpath, label);
}

export async function proposeBatch(
  db: Db,
  queueType: QueueType,
  limit = 50,
  ollama = createOllamaClient(),
): Promise<{ proposed: number; needsModel: number }> {
  const model = getModel(db);
  const rows = db
    .prepare(
      `SELECT f.id, f.path, f.sha256, e.summary_json, e.fingerprint
       FROM files f
       JOIN extractions e ON e.file_id = f.id
       WHERE f.queue_type = ? AND f.status = 'extracted'
       ORDER BY f.id LIMIT ?`,
    )
    .all(queueType, limit) as Array<{
    id: number;
    path: string;
    sha256: string;
    summary_json: string;
    fingerprint: string;
  }>;

  let proposed = 0;
  let needsModel = 0;

  for (const row of rows) {
    const filename = path.basename(row.path);
    const evidence: Record<string, unknown> = {};

    const exact = db
      .prepare(
        `SELECT id, path FROM files
         WHERE sha256 = ? AND status = 'moved' AND id != ?
         LIMIT 1`,
      )
      .get(row.sha256, row.id) as { id: number; path: string } | undefined;

    let suggested: string;
    let confidence: number;
    let modelUsed: string | null = null;

    if (exact) {
      // Place next to the already-moved twin's category folder when possible
      const twinProposal = db
        .prepare(
          `SELECT suggested_relpath FROM proposals WHERE file_id = ?`,
        )
        .get(exact.id) as { suggested_relpath: string } | undefined;
      const twinDir = twinProposal
        ? path.posix.dirname(twinProposal.suggested_relpath)
        : "Duplicates";
      suggested = `${twinDir}/${filename}`;
      confidence = 1;
      evidence.rule = "exact_sha256_duplicate";
      evidence.twinFileId = exact.id;
      evidence.twinPath = exact.path;
    } else {
      const movedSameFp = db
        .prepare(
          `SELECT f.id, f.path, p.suggested_relpath
           FROM files f
           JOIN proposals p ON p.file_id = f.id
           WHERE f.fingerprint = ? AND f.status = 'moved' AND f.id != ?
           LIMIT 1`,
        )
        .get(row.fingerprint, row.id) as
        | { id: number; path: string; suggested_relpath: string }
        | undefined;

      if (movedSameFp) {
        const dir = path.posix.dirname(movedSameFp.suggested_relpath);
        suggested = `${dir}/${filename}`;
        confidence = 0.9;
        evidence.rule = "fingerprint_match";
        evidence.twinFileId = movedSameFp.id;
      } else {
        const categories = listCategories(db);
        const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
        let classified: ClassifyOutput | null = null;
        try {
          const st = await ollama.status(model);
          if (!st.ok) throw new Error(st.error ?? "ollama unavailable");
          classified = await ollama.classify({
            model,
            summary,
            categories,
            filename,
          });
          modelUsed = model;
          evidence.rule = "ollama";
          evidence.rationale = classified.rationale;
        } catch (err) {
          db.prepare(`UPDATE files SET status = 'needs_model' WHERE id = ?`).run(
            row.id,
          );
          needsModel += 1;
          evidence.rule = "needs_model";
          evidence.error = err instanceof Error ? err.message : String(err);
          // still record a placeholder proposal? Spec: status needs_model, no move.
          // Skip proposal insert.
          continue;
        }
        const polished = polishPlacement(
          classified.category,
          classified.subcategory,
          categories,
        );
        evidence.rawCategory = classified.category;
        evidence.rawSubcategory = classified.subcategory ?? null;
        evidence.polishedCategory = polished.category;
        evidence.polishedSubcategory = polished.subcategory ?? null;
        suggested = relpathFor(
          polished.category,
          polished.subcategory,
          filename,
        );
        confidence = classified.confidence;
        ensureCategory(db, polished.category, polished.category);
        if (polished.subcategory) {
          ensureCategory(
            db,
            `${polished.category}/${polished.subcategory}`,
            polished.subcategory,
          );
        }
      }
    }

    db.prepare(
      `INSERT INTO proposals(file_id, suggested_relpath, confidence, evidence_json, model)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         suggested_relpath = excluded.suggested_relpath,
         confidence = excluded.confidence,
         evidence_json = excluded.evidence_json,
         model = excluded.model`,
    ).run(
      row.id,
      suggested,
      confidence,
      JSON.stringify(evidence),
      modelUsed,
    );
    db.prepare(`UPDATE files SET status = 'proposed' WHERE id = ?`).run(row.id);
    proposed += 1;
  }

  return { proposed, needsModel };
}

export function listProposals(db: Db): ProposalView[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.file_id AS fileId, f.path AS sourcePath,
              p.suggested_relpath AS suggestedRelpath, p.confidence,
              p.evidence_json AS evidenceJson, p.model
       FROM proposals p
       JOIN files f ON f.id = p.file_id
       WHERE f.status = 'proposed'
       ORDER BY p.id`,
    )
    .all() as Array<{
    id: number;
    fileId: number;
    sourcePath: string;
    suggestedRelpath: string;
    confidence: number;
    evidenceJson: string;
    model: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    fileId: r.fileId,
    sourcePath: r.sourcePath,
    suggestedRelpath: r.suggestedRelpath,
    confidence: r.confidence,
    evidence: JSON.parse(r.evidenceJson),
    model: r.model,
  }));
}
