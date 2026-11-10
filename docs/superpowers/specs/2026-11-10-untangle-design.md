# Untangle V1 Design

**Date:** 2026-11-10  
**Status:** Approved via plan confirmation

## Intent

Untangle is a local-first desktop app for organizing a large messy filesystem (~600GB) without trusting folder names. It inventories content, proposes a corpus-derived category tree, and only moves files after the user approves. AI recommends; deterministic code executes.

## Why

Token-cost-effective, offline-capable organization of a personal drive. Cloud classification is out of scope. Local Ollama classifies short structured summaries only.

## Goals

- Dual-root workflow: scan **Messy**, grow **Untangle** from empty.
- Incremental, resumable cheap index (stat + SHA-256) that never stores full file bytes.
- Deep-process by type: XLSX → DOCX → PDF → PPTX → images → videos → other.
- Propose topic/category with rules + local Ollama JSON; user approves moves.
- Journaled moves with undo; never overwrite on collision.
- Automatic version/duplicate candidates with deterministic mismatch locations; user picks winner and archives losers.

## Non-goals (V1)

- Piece-picking consolidate across versions (Phase 2).
- OCR / video captions.
- Embeddings / vector DB.
- Cloud LLM classification.
- Multi-user / sync.
- Tauri/Rust rewrite.

## Anti-goals

- Shipping a “rearrange everything at once” rewriter that loads the corpus into memory or model context.
- Silent moves without approval or audit.
- Overwriting files on name collision.

## Constraints

- Platform: macOS (primary), Apple Silicon OK; Node 20+.
- Stack: Electron + React + TypeScript UI; separate Node worker; SQLite; Ollama optional for categorize.
- Local-only network: Ollama at `http://127.0.0.1:11434`.
- Summaries size-capped; never put full documents in SQLite or prompts.
- Same-volume moves prefer `rename`; cross-volume uses copy → verify → delete.
- Default classify model setting: `qwen3:8b` (user may override to whatever they pulled).

## Approaches considered

| Approach | Trade-off | Choice |
|----------|-----------|--------|
| A. Electron + all work in main | Simple; risky for 600GB jobs in main process | Rejected |
| B. Tauri + Rust | Strong FS; awkward Office extract early | Rejected for V1 |
| C. Electron UI + Node worker | Parsers + durable long jobs | **Selected** |

## Architecture

```text
apps/desktop  → Electron/React UI (setup, inventory, review, versions, audit)
packages/worker → scan, hash, extract, classify, move, versions
packages/shared → IPC types, enums, path helpers
SQLite (worker) → inventory, proposals, categories, actions, version_groups
Ollama (optional) → JSON category proposals from capped summaries
```

IPC: UI sends commands; worker emits progress events. Worker owns the DB file under the app user-data directory.

## Pipeline

1. **Cheap scan** — walk Messy, record path/size/mtime/ext, hash; resume via DB.
2. **Type queue extract** — one type at a time; store capped structured JSON.
3. **Propose** — exact hash to already-moved → dupe/same place; else anchors; else Ollama JSON; else `needs_model`.
4. **Approve** — user edits destination; worker moves with collision policy `name (2).ext`.
5. **Versions** — cluster exact hash + structural near-dupes; deterministic diff; pick winner → archive to `Untangle/_Archive/…`.

## Data model

- `roots` — messy_path, untangle_path
- `files` — path, size, mtime_ms, ext, sha256, status (`seen`|`extracted`|`proposed`|`moved`|`archived`|`needs_model`)
- `extractions` — file_id, summary_json, fingerprint
- `categories` — relpath, label
- `proposals` — file_id, suggested_relpath, confidence, evidence_json, model
- `actions` — kind, before_path, after_path, sha256, created_at, undone
- `version_groups` — id, kind (`exact`|`near`), summary_json
- `version_members` — group_id, file_id

## UI surfaces

Setup, Inventory, Type queue / Proposals, Review/Approve, Versions, Audit/Undo.

## Builder calls (defaults)

- Monorepo pnpm workspaces; Vitest for worker/shared unit tests.
- `better-sqlite3` in worker.
- Extractors: ExcelJS (xlsx), mammoth (docx text), pdf-parse (pdf), JSZip+XML for pptx slide text; images/videos metadata via `fs` + optional `exifreader` later — V1 uses size/mtime/ext only for media.
- Collision: append ` (n)` before extension.
- Archive root: `_Archive` under Untangle.
