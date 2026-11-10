import type { RootsConfig } from "@untangle/shared";
import type { Db } from "./db.js";
import { getMeta, setMeta } from "./db.js";

export function setRoots(db: Db, roots: RootsConfig): void {
  setMeta(db, "messy_path", roots.messyPath);
  setMeta(db, "untangle_path", roots.untanglePath);
}

export function getRoots(db: Db): RootsConfig | null {
  const messyPath = getMeta(db, "messy_path");
  const untanglePath = getMeta(db, "untangle_path");
  if (!messyPath || !untanglePath) return null;
  return { messyPath, untanglePath };
}

export function getModel(db: Db): string {
  return getMeta(db, "ollama_model") ?? "qwen3:8b";
}

export function setModel(db: Db, model: string): void {
  setMeta(db, "ollama_model", model);
}
