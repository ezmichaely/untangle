import type { QueueType } from "./type-order.js";

export type FileStatus =
  | "seen"
  | "extracted"
  | "proposed"
  | "moved"
  | "skipped"
  | "archived"
  | "needs_model"
  | "extract_failed"
  | "missing";

export interface AnalysisStatus {
  active: boolean;
  total: number;
  processed: number;
  remaining: number;
  extracted: number;
  proposed: number;
  needsModel: number;
  extractionFailed: number;
}

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
  | { type: "analyzeLibrary" }
  | { type: "getAnalysisStatus" }
  | { type: "listProposals" }
  | { type: "approveMove"; proposalId: number; destRelpath?: string }
  | { type: "approveTopicGroup"; topicFolder: string; proposalIds: number[]; skippedProposalIds: number[]; destinationFolder: string }
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
