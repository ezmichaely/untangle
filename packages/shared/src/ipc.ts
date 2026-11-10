import type { QueueType } from "./type-order.js";

export type FileStatus =
  | "seen"
  | "extracted"
  | "proposed"
  | "moved"
  | "archived"
  | "needs_model"
  | "missing";

export interface RootsConfig {
  messyPath: string;
  untanglePath: string;
}

export interface InventoryCounts {
  total: number;
  hashed: number;
  byType: Record<QueueType, number>;
}

export interface ProposalView {
  id: number;
  fileId: number;
  sourcePath: string;
  suggestedRelpath: string;
  confidence: number;
  evidence: unknown;
  model: string | null;
}

export interface ActionView {
  id: number;
  kind: string;
  beforePath: string;
  afterPath: string;
  sha256: string | null;
  createdAt: string;
  undone: boolean;
}

export interface VersionGroupView {
  id: number;
  kind: "exact" | "near";
  summary: unknown;
  members: Array<{
    fileId: number;
    path: string;
    sha256: string | null;
  }>;
  mismatches: string[];
}

export interface OllamaStatus {
  ok: boolean;
  model: string;
  error?: string;
}

export type WorkerCommand =
  | { type: "ping" }
  | { type: "getRoots" }
  | { type: "setRoots"; roots: RootsConfig }
  | { type: "startScan" }
  | { type: "getInventory" }
  | { type: "startHash" }
  | { type: "extractType"; queueType: QueueType }
  | { type: "proposeBatch"; queueType: QueueType; limit?: number }
  | { type: "listProposals" }
  | { type: "approveMove"; proposalId: number; destRelpath?: string }
  | { type: "undoLast" }
  | { type: "listActions"; limit?: number }
  | { type: "findVersions" }
  | { type: "pickWinner"; groupId: number; winnerFileId: number }
  | { type: "ollamaStatus" }
  | { type: "setModel"; model: string };

export type WorkerEvent =
  | { type: "pong"; version: string }
  | { type: "progress"; phase: string; current: number; total: number; message?: string }
  | { type: "error"; message: string }
  | { type: "done"; command: WorkerCommand["type"]; result?: unknown };

export interface WorkerRequest {
  id: string;
  command: WorkerCommand;
}

export interface WorkerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
