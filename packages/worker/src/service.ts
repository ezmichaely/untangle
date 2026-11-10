import type {
  WorkerCommand,
  WorkerEvent,
  QueueType,
} from "@untangle/shared";
import type { Db } from "./db.js";
import { openDb } from "./db.js";
import { getRoots, setRoots, getModel, setModel } from "./roots.js";
import { scanMessy, hashPending, getInventory } from "./scan.js";
import { extractTypeBatch } from "./extract/run.js";
import { proposeBatch, listProposals } from "./propose.js";
import { approveAndMove, undoLastAction, listActions } from "./moves.js";
import { findVersionGroups, pickWinner } from "./versions.js";
import { createOllamaClient } from "./ollama.js";

export type EmitFn = (event: WorkerEvent) => void;

export class UntangleService {
  readonly db: Db;
  private ollama = createOllamaClient();

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
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
      case "listProposals":
        return listProposals(this.db);
      case "approveMove":
        return approveAndMove(this.db, command.proposalId, command.destRelpath);
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
