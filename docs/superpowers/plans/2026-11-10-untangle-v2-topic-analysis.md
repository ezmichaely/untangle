# V2 Topic Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Group extracted files by shared content topics across file types and bounded analysis batches, using local Ollama and the existing approval flow.

**Architecture:** The worker extracts all available queue types, applies deterministic duplicate rules, and sends capped mixed-type batches plus bounded SQLite topic context to a validated Ollama analyst. The worker stores topic memory and proposals; the desktop exposes one library-wide preparation action and reviews proposals by topic folder with per-file exclusion.

**Tech Stack:** TypeScript, Electron/React, Node worker, SQLite, Ollama HTTP API, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-10-untangle-v2-topic-analysis-design.md`

## Global Constraints

- Keep analysis local; never send whole files or add a cloud LLM dependency.
- Keep model requests and persisted topic context bounded.
- Require one approval per topic folder; allow individual files to be skipped, preserving collision handling and undo.
- Preserve existing databases with additive schema changes; never reset user data.
- Use pnpm only.

## Review Focus

- Model returns missing, duplicate, or unknown file IDs → reject batch results and create no unsafe proposal.
- Ollama is unavailable or returns malformed JSON → retain safe `needs_model` behavior.
- Many files or many topic roots → cap each prompt and select examples deterministically.
- Content-poor image/video/other summaries → label evidence low instead of claiming content understanding.
- Existing database has only V1 schema → opens and upgrades without losing rows.

## Files

- `packages/worker/src/db.ts`: additive topic-context table.
- `packages/worker/src/ollama.ts`: mixed-file batch request, response parser, and validation.
- `packages/worker/src/propose.ts`: cross-type batches, bounded prior context, duplicate rules, and topic persistence.
- `packages/worker/src/service.ts`: library-level extraction and analysis orchestration.
- `packages/shared/src/ipc.ts`: library analysis command type.
- `apps/desktop/src/App.tsx`: replace per-type preparation controls with library preparation action and summary.
- `packages/worker/src/{db,ollama,propose,service}.test.ts`: schema, validation, grouping, fallback, and resume coverage.
- `docs/architecture.md`: explain scanner/analyst/worker responsibilities and current evidence limits.
- `apps/desktop/electron/main.cjs`, `apps/desktop/electron/preload.cjs`, `apps/desktop/src/vite-env.d.ts`: forward typed worker progress events to the UI.

### Task 1: Add validated Ollama batch analysis

**Files:** Modify `packages/worker/src/ollama.ts`; test `packages/worker/src/ollama.test.ts`.

**Produces:** `analyzeBatch(input: BatchAnalyzeInput): Promise<BatchAnalyzeOutput>` accepting `{ id, queueType, filename, summary, evidenceQuality }[]` plus bounded topic context. Output groups contain category, optional subcategory, file IDs, confidence, rationale, and evidence quality.

- [ ] Write tests for valid mixed-type groups and reject incomplete, duplicate, unknown, or malformed IDs/fields.
- [ ] Run `pnpm --filter @untangle/worker test -- ollama.test.ts`; confirm the new behavior fails first.
- [ ] Implement the JSON prompt and strict response validation; retain existing `classify` API for fallback.
- [ ] Re-run the focused test; expect pass.
- [ ] Run `pnpm --filter @untangle/worker test`; expect pass.

### Task 2: Persist topic context and propose across mixed batches

**Files:** Modify `packages/worker/src/db.ts`, `packages/worker/src/propose.ts`; test `packages/worker/src/db.test.ts`, `packages/worker/src/propose.test.ts`.

**Consumes:** Task 1 `analyzeBatch` types and method.  
**Produces:** `proposeLibraryBatch(db: Db, limit: number, ollama: OllamaClient)`; durable root-topic description and bounded representative evidence in SQLite.

- [ ] Test opening a V1 database and preserving existing file/proposal rows after schema upgrade.
- [ ] Test a mixed-extension batch groups unrelated filenames under one category and records topic context.
- [ ] Test a later batch reuses saved context and both prompt examples and stored topic memories stay capped.
- [ ] Test metadata-only media evidence is labeled low and is not described as content-grounded.
- [ ] Test duplicate rules still bypass the model; model failure or invalid batch results produce no proposals and safe `needs_model` statuses.
- [ ] Run focused tests and confirm the new cases fail.
- [ ] Add the additive table and implement deterministic context selection, capped summaries, validated proposal writes, and topic-memory updates.
- [ ] Run focused tests, then `pnpm --filter @untangle/worker test`; expect pass.

### Task 3: Expose resumable library analysis through worker IPC

**Files:** Modify `packages/shared/src/ipc.ts`, `packages/worker/src/service.ts`; test `packages/worker/src/service.test.ts`.

**Consumes:** Task 2 `proposeLibraryBatch`.  
**Produces:** `analyzeLibrary` worker command; service extracts pending files through each `TYPE_ORDER` queue in bounded batches, then analyzes extracted files across types until no candidates remain, emitting progress and returning counts.

- [ ] Test the command extracts/proposes across multiple queue types and is resumable when an extraction batch limit is reached.
- [ ] Run the focused test and confirm it fails because the command is missing.
- [ ] Implement command wiring and bounded extraction/proposal loops using existing progress events.
- [ ] Run focused test, then `pnpm --filter @untangle/worker test`; expect pass.

### Task 4: Make desktop preparation library-wide and document the roles

**Files:** Modify `apps/desktop/src/App.tsx`, `docs/architecture.md`.

**Consumes:** Task 3 `analyzeLibrary` command and result counts.  
**Produces:** One library-level “Prepare suggestions” action with clear extraction/proposal counts; same proposal review and approval flow.

- [ ] Implement the UI action and remove the per-type selector/copy.
- [ ] Update architecture docs to say extractors provide evidence, Ollama groups topics locally, and unreadable formats have weaker evidence.
- [ ] Run `pnpm typecheck`, `pnpm test`, and `pnpm build`; expect all to pass.

### Task 5: Process analysis in progressive background chunks

**Files:** Modify `packages/worker/src/extract/run.ts`, `packages/worker/src/service.ts`, `packages/shared/src/ipc.ts`, Electron main/preload bridge, and `apps/desktop/src/App.tsx`; test `packages/worker/src/service.test.ts`.

**Produces:** Start/resume/status commands; extraction advances by 20 files; proposals are emitted in 8-file analyst batches; user can review while processing continues; a saved cursor resumes after app restart. Unreadable files use an explicit failure status and can be retried on a new run.

- [x] Write a service test with 21 files proving immediate start, a 20-file first chunk, and progressive completion events.
- [x] Run the focused worker test and confirm the immediate-start assertion fails against the current blocking implementation.
- [x] Implement the persistent cursor/background loop, chunked proposal drain, progress/done events, and resume behavior.
- [x] Forward worker events through Electron and update the UI status/review queue while leaving navigation available.
- [x] Run `pnpm test`, `pnpm typecheck`, and `pnpm build`; expect all to pass.
