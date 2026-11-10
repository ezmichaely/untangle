import type {
  AnalysisStatus,
  WorkerCommand,
  WorkerEvent,
  QueueType,
} from "@untangle/shared";
import type { Db } from "./db.js";
import { getMeta, openDb, setMeta } from "./db.js";
import { getRoots, setRoots, getModel, setModel } from "./roots.js";
import { scanMessy, hashPending, getInventory } from "./scan.js";
import { extractLibraryBatch, extractTypeBatch } from "./extract/run.js";
import { proposeBatch, proposeLibraryBatch, listProposals } from "./propose.js";
import { approveAndMove, approveTopicGroup, undoLastAction, listActions } from "./moves.js";
import { findVersionGroups, pickWinner } from "./versions.js";
import { createOllamaClient } from "./ollama.js";

export type EmitFn = (event: WorkerEvent) => void;

export class UntangleService {
  readonly db: Db;
  private ollama = createOllamaClient();
  private analysisJob: Promise<void> | null = null;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
  }

  private getAnalysisStatus(): AnalysisStatus {
    const cursor = Number(getMeta(this.db, "analysis_cursor") ?? 0);
    const count = (sql: string, ...params: unknown[]) => {
      const row = this.db.prepare(sql).get(...params) as { count: number };
      return row.count;
    };
    const total = count(
      `SELECT COUNT(*) AS count FROM files WHERE sha256 IS NOT NULL AND status != 'missing'`,
    );
    const extracted = count(
      `SELECT COUNT(*) AS count FROM files WHERE status = 'extracted'`,
    );
    const seen = count(
      `SELECT COUNT(*) AS count FROM files WHERE status = 'seen' AND sha256 IS NOT NULL AND id > ?`,
      cursor,
    );
    const remaining = extracted + seen;
    return {
      active: getMeta(this.db, "analysis_active") === "1",
      total,
      processed: Math.max(0, total - remaining),
      remaining,
      extracted,
      proposed: count(`SELECT COUNT(*) AS count FROM files WHERE status = 'proposed'`),
      needsModel: count(`SELECT COUNT(*) AS count FROM files WHERE status = 'needs_model'`),
      extractionFailed: count(`SELECT COUNT(*) AS count FROM files WHERE status = 'extract_failed'`),
    };
  }

  private async runLibraryAnalysis(emit: EmitFn): Promise<void> {
    for (;;) {
      const state = this.getAnalysisStatus();
      if (state.extracted > 0) {
        const result = await proposeLibraryBatch(this.db, 8, this.ollama);
        const updated = this.getAnalysisStatus();
        emit({
          type: "progress",
          phase: "analysis",
          current: updated.processed,
          total: updated.total,
          message: `Prepared ${result.proposed} suggestions; ${result.needsModel} need the local model; ${updated.remaining} files remain.`,
        });
      } else {
        const cursor = Number(getMeta(this.db, "analysis_cursor") ?? 0);
        const result = await extractLibraryBatch(this.db, 20, cursor);
        if (result.lastId === null) {
          setMeta(this.db, "analysis_active", "0");
          const completed = this.getAnalysisStatus();
          emit({ type: "done", command: "analyzeLibrary", result: completed });
          return;
        }
        setMeta(this.db, "analysis_cursor", String(result.lastId));
        const updated = this.getAnalysisStatus();
        emit({
          type: "progress",
          phase: "analysis",
          current: updated.processed,
          total: updated.total,
          message: `Read ${result.scanned} files (${result.extracted} readable, ${result.failed} unreadable); preparing suggestions.`,
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async handle(command: WorkerCommand, emit?: EmitFn): Promise<unknown> {
    const onProgress = (p: {
      phase: string;
      current: number;
      total: number;
      message?: string;
    }) => emit?.({ type: "progress", ...p });

    switch (command.type) {
      case "ping":
        return { version: "0.1.0" };
      case "getRoots":
        return getRoots(this.db);
      case "setRoots":
        setRoots(this.db, command.roots);
        return getRoots(this.db);
      case "startScan":
        return scanMessy(this.db, onProgress);
      case "getInventory":
        return getInventory(this.db);
      case "startHash": {
        let total = 0;
        for (;;) {
          const { hashed } = hashPending(this.db, 200, onProgress);
          total += hashed;
          if (hashed === 0) break;
        }
        return { hashed: total };
      }
      case "extractType":
        return extractTypeBatch(
          this.db,
          command.queueType as QueueType,
          100,
          onProgress,
        );
      case "proposeBatch":
        return proposeBatch(
          this.db,
          command.queueType,
          command.limit ?? 50,
          this.ollama,
        );
      case "analyzeLibrary": {
        const wasActive = getMeta(this.db, "analysis_active") === "1";
        if (!this.analysisJob) {
          if (!wasActive) {
            setMeta(this.db, "analysis_cursor", "0");
            this.db.prepare(`DELETE FROM topic_context`).run();
            this.db.prepare(`UPDATE files SET status = 'seen' WHERE status = 'extract_failed'`).run();
            setMeta(this.db, "analysis_active", "1");
          }
          this.analysisJob = this.runLibraryAnalysis(emit ?? (() => {}))
            .catch((err) => {
              setMeta(this.db, "analysis_active", "0");
              emit?.({
                type: "error",
                message: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              this.analysisJob = null;
            });
        }
        return { started: true, active: true, resumed: wasActive };
      }
      case "getAnalysisStatus":
        return this.getAnalysisStatus();
      case "listProposals":
        return listProposals(this.db);
      case "approveMove":
        return approveAndMove(this.db, command.proposalId, command.destRelpath);
      case "approveTopicGroup":
        return approveTopicGroup(
          this.db,
          command.topicFolder,
          command.proposalIds,
          command.skippedProposalIds,
          command.destinationFolder,
        );
      case "undoLast":
        return undoLastAction(this.db);
      case "listActions":
        return listActions(this.db, command.limit ?? 50);
      case "findVersions":
        return findVersionGroups(this.db);
      case "pickWinner":
        return pickWinner(this.db, command.groupId, command.winnerFileId);
      case "ollamaStatus":
        return this.ollama.status(getModel(this.db));
      case "setModel":
        setModel(this.db, command.model);
        return { model: getModel(this.db) };
      default: {
        const _exhaustive: never = command;
        void _exhaustive;
        throw new Error("unknown command");
      }
    }
  }
}
