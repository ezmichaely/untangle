import fs from "node:fs";
import path from "node:path";
import type { ProposalView, QueueType } from "@untangle/shared";
import type { Db } from "./db.js";
import { getModel } from "./roots.js";
import { createOllamaClient, type ClassifyOutput } from "./ollama.js";
import type {
  BatchAnalyzeFile,
  TopicContext,
  EvidenceQuality,
} from "./ollama.js";
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

const ANALYST_BATCH_SIZE = 8;
const TOPIC_CONTEXT_LIMIT = 8;
const TOPIC_MEMORY_LIMIT = 200;
type ClassifyClient = Pick<ReturnType<typeof createOllamaClient>, "status" | "classify">;
type BatchAnalyzeClient = Pick<ReturnType<typeof createOllamaClient>, "status" | "analyzeBatch"> &
  Partial<Pick<ReturnType<typeof createOllamaClient>, "describeImage">>;
const TOPIC_EXAMPLES_LIMIT = 2;
const IMAGE_MODEL = "qwen2.5vl:7b";
const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024;

type LibraryRow = {
  id: number;
  path: string;
  queue_type: string;
  sha256: string;
  summary_json: string;
  fingerprint: string;
};

function evidenceQuality(row: LibraryRow, summary: Record<string, unknown>): EvidenceQuality {
  if (row.queue_type === "images" || row.queue_type === "videos" || row.queue_type === "other") {
    return "metadata";
  }
  const hasContent = (value: unknown, key = ""): boolean => {
    if (["kind", "name", "ext", "size", "mtimeMs", "pages", "slideCount", "sheetCount", "length"].includes(key)) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.some((item) => hasContent(item));
    if (value && typeof value === "object") {
      return Object.entries(value).some(([childKey, child]) => hasContent(child, childKey));
    }
    return false;
  };
  return hasContent(summary) ? "content" : "metadata";
}

function compactSummary(summary: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(summary);
  if (serialized.length <= 700) return summary;
  const text = typeof summary.text === "string" ? summary.text : undefined;
  const title = typeof summary.titleGuess === "string" ? summary.titleGuess : undefined;
  return {
    kind: summary.kind ?? "unknown",
    ...(title ? { titleGuess: title.slice(0, 120) } : {}),
    excerpt: (text ?? serialized).slice(0, 700),
  };
}

function getTopicContext(db: Db): TopicContext[] {
  const known = listCategories(db);
  const saved = db
    .prepare(`SELECT category, description, examples_json, updated_at FROM topic_context`)
    .all() as Array<{ category: string; description: string; examples_json: string; updated_at: string }>;
  const savedByCategory = new Map(saved.map((row) => [row.category, row]));
  const topics = new Map<string, TopicContext>();
  for (const category of known) {
    const memory = savedByCategory.get(category);
    let examples: TopicContext["examples"] = [];
    try {
      examples = memory ? JSON.parse(memory.examples_json) as TopicContext["examples"] : [];
    } catch {
      examples = [];
    }
    topics.set(category, {
      category,
      description: memory?.description.slice(0, 300) ?? "",
      examples: examples.slice(0, TOPIC_EXAMPLES_LIMIT),
    });
  }

  const prior = db.prepare(
    `SELECT p.suggested_relpath, f.id, f.path, f.queue_type, f.status,
            e.summary_json, p.evidence_json
     FROM proposals p
     JOIN files f ON f.id = p.file_id
     JOIN extractions e ON e.file_id = f.id
     ORDER BY CASE WHEN f.status = 'moved' THEN 0 ELSE 1 END, f.id DESC
     LIMIT 100`,
  ).all() as Array<{
    suggested_relpath: string;
    id: number;
    path: string;
    queue_type: string;
    status: string;
    summary_json: string;
    evidence_json: string;
  }>;
  for (const row of prior) {
    const category = path.posix.dirname(row.suggested_relpath).split("/")[0];
    const topic = topics.get(category);
    const filename = path.basename(row.path);
    if (row.status === "moved") {
      for (const existing of topics.values()) {
        existing.examples = existing.examples.filter((example) => example.id !== row.id);
      }
    }
    if (!topic || topic.examples.some((example) => example.id === row.id) || topic.examples.length >= TOPIC_EXAMPLES_LIMIT) continue;
    let summary: Record<string, unknown>;
    let evidence: Record<string, unknown> = {};
    try {
      summary = JSON.parse(row.summary_json) as Record<string, unknown>;
      evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    topic.examples.push({
      id: row.id,
      filename,
      queueType: row.queue_type,
        summary: JSON.stringify(compactSummary(summary)).slice(0, 400),
    });
    if (row.status === "moved" && typeof evidence.rationale === "string") {
      topic.description = evidence.rationale.slice(0, 300);
    }
  }
  return [...topics.values()]
    .sort((a, b) =>
      (savedByCategory.get(b.category)?.updated_at ?? "").localeCompare(
        savedByCategory.get(a.category)?.updated_at ?? "",
      ) || a.category.localeCompare(b.category),
    )
    .slice(0, TOPIC_CONTEXT_LIMIT);
}

function saveTopicContext(
  db: Db,
  category: string,
  rationale: string,
  file: BatchAnalyzeFile,
): void {
  const current = db.prepare(
    `SELECT description, examples_json FROM topic_context WHERE category = ?`,
  ).get(category) as { description: string; examples_json: string } | undefined;
  let examples: TopicContext["examples"] = [];
  try {
    examples = current ? JSON.parse(current.examples_json) as TopicContext["examples"] : [];
  } catch {
    examples = [];
  }
  const next = [
    ...examples.filter((example) => example.id !== file.id),
    {
      id: file.id,
      filename: file.filename,
      queueType: file.queueType,
      summary: JSON.stringify(compactSummary(file.summary)).slice(0, 400),
    },
  ].slice(-TOPIC_EXAMPLES_LIMIT);
  db.prepare(
    `INSERT INTO topic_context(category, description, examples_json, updated_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(category) DO UPDATE SET
       description = CASE WHEN topic_context.description = '' THEN excluded.description ELSE topic_context.description END,
       examples_json = excluded.examples_json,
       updated_at = excluded.updated_at`,
  ).run(category, rationale.slice(0, 300), JSON.stringify(next), new Date().toISOString());
  db.prepare(
    `DELETE FROM topic_context WHERE category IN (
       SELECT category FROM topic_context
       ORDER BY updated_at DESC, category LIMIT -1 OFFSET ?
     )`,
  ).run(TOPIC_MEMORY_LIMIT);
}

/** Analyze a bounded mixed-type batch using durable topic context. */
export async function proposeLibraryBatch(
  db: Db,
  limit = ANALYST_BATCH_SIZE,
  ollama: BatchAnalyzeClient = createOllamaClient(),
): Promise<{ proposed: number; needsModel: number }> {
  const rows = db.prepare(
    `SELECT f.id, f.path, f.queue_type, f.sha256, f.fingerprint, e.summary_json
     FROM files f JOIN extractions e ON e.file_id = f.id
     WHERE f.status = 'extracted'
     ORDER BY f.id LIMIT ?`,
  ).all(Math.min(Math.max(1, limit), ANALYST_BATCH_SIZE)) as LibraryRow[];
  if (!rows.length) return { proposed: 0, needsModel: 0 };

  let proposed = 0;
  let needsModel = 0;
  const remaining: Array<{ row: LibraryRow; input: BatchAnalyzeFile }> = [];
  for (const row of rows) {
    const filename = path.basename(row.path);
    const exact = db.prepare(
      `SELECT id, path FROM files WHERE sha256 = ? AND status = 'moved' AND id != ? LIMIT 1`,
    ).get(row.sha256, row.id) as { id: number; path: string } | undefined;
    const near = exact ? undefined : db.prepare(
      `SELECT f.id, f.path, p.suggested_relpath
       FROM files f JOIN proposals p ON p.file_id = f.id
       WHERE f.fingerprint = ? AND f.status = 'moved' AND f.id != ? LIMIT 1`,
    ).get(row.fingerprint, row.id) as { id: number; path: string; suggested_relpath: string } | undefined;
    if (exact || near) {
      const twin = exact ?? near!;
      const twinProposal = exact
        ? db.prepare(`SELECT suggested_relpath FROM proposals WHERE file_id = ?`).get(twin.id) as { suggested_relpath: string } | undefined
        : near;
      const dir = twinProposal ? path.posix.dirname(twinProposal.suggested_relpath) : "Duplicates";
      const evidence = exact
        ? { rule: "exact_sha256_duplicate", twinFileId: twin.id, twinPath: twin.path }
        : { rule: "fingerprint_match", twinFileId: twin.id };
      db.prepare(
        `INSERT INTO proposals(file_id, suggested_relpath, confidence, evidence_json, model)
         VALUES(?, ?, ?, ?, NULL)
         ON CONFLICT(file_id) DO UPDATE SET suggested_relpath=excluded.suggested_relpath,
         confidence=excluded.confidence, evidence_json=excluded.evidence_json, model=NULL`,
      ).run(row.id, `${dir}/${filename}`, exact ? 1 : 0.9, JSON.stringify(evidence));
      db.prepare(`UPDATE files SET status = 'proposed' WHERE id = ?`).run(row.id);
      proposed += 1;
      continue;
    }
    const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
    remaining.push({
      row,
      input: {
        id: row.id,
        queueType: row.queue_type,
        filename,
        summary: compactSummary(summary),
        evidenceQuality: evidenceQuality(row, summary),
      },
    });
  }
  if (!remaining.length) return { proposed, needsModel };

  const model = getModel(db);
  if (ollama.describeImage) {
    const images = remaining.filter(({ input }) => input.queueType === "images");
    if (images.length) {
      try {
        if ((await ollama.status(IMAGE_MODEL)).ok) {
          for (const { row, input } of images) {
            try {
              if (fs.statSync(row.path).size > MAX_VISION_IMAGE_BYTES) continue;
              const visualDescription = await ollama.describeImage({
                model: IMAGE_MODEL,
                filename: input.filename,
                imageBase64: fs.readFileSync(row.path).toString("base64"),
              });
              input.summary = { ...input.summary, visualDescription };
              input.evidenceQuality = "content";
            } catch {
              // Keep metadata-only evidence if a file cannot be read or described.
            }
          }
        }
      } catch {
        // The main text analyst can still use filenames if the vision model is unavailable.
      }
    }
  }

  let analysis: Awaited<ReturnType<typeof ollama.analyzeBatch>>;
  try {
    const status = await ollama.status(model);
    if (!status.ok) throw new Error(status.error ?? "ollama unavailable");
    analysis = await ollama.analyzeBatch({
      model,
      files: remaining.map(({ input }) => input),
      topics: getTopicContext(db),
    });
  } catch {
    for (const { row } of remaining) {
      db.prepare(`UPDATE files SET status = 'needs_model' WHERE id = ?`).run(row.id);
      needsModel += 1;
    }
    return { proposed, needsModel };
  }

  const byId = new Map(remaining.map(({ input, row }) => [input.id, { input, row }]));
  db.transaction(() => {
    for (const group of analysis.groups) {
      for (const fileId of group.fileIds) {
        const candidate = byId.get(fileId)!;
        const polished = polishPlacement(group.category, group.subcategory, listCategories(db));
        const relpath = relpathFor(polished.category, polished.subcategory, candidate.input.filename);
        const quality = candidate.input.evidenceQuality === "metadata" ? "metadata" : group.evidenceQuality;
        const evidence = {
          rule: "ollama_batch",
          rationale: group.rationale,
          evidenceQuality: quality,
          queueType: candidate.input.queueType,
          topic: polished.category,
        };
        ensureCategory(db, polished.category, polished.category);
        if (polished.subcategory) ensureCategory(db, `${polished.category}/${polished.subcategory}`, polished.subcategory);
        db.prepare(
          `INSERT INTO proposals(file_id, suggested_relpath, confidence, evidence_json, model)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(file_id) DO UPDATE SET suggested_relpath=excluded.suggested_relpath,
           confidence=excluded.confidence, evidence_json=excluded.evidence_json, model=excluded.model`,
        ).run(fileId, relpath, group.confidence, JSON.stringify(evidence), model);
        db.prepare(`UPDATE files SET status = 'proposed' WHERE id = ?`).run(fileId);
        saveTopicContext(db, polished.category, group.rationale, candidate.input);
        proposed += 1;
      }
    }
  })();
  return { proposed, needsModel };
}

export async function proposeBatch(
  db: Db,
  queueType: QueueType,
  limit = 50,
  ollama: ClassifyClient = createOllamaClient(),
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
