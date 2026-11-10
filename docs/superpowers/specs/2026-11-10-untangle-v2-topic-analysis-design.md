# Untangle V2 topic analysis design

**Date:** 2026-11-10  
**Status:** Approved; implementation in progress  
**Parent direction:** `docs/superpowers/specs/2026-11-10-untangle-v2-direction.md`

## Intent

Move Untangle from isolated per-file folder guesses toward content-based grouping across file types and successive analysis batches. Ollama is the local analyst; the worker owns evidence extraction, durable topic context, proposals, and safe moves.

## Goals

- Compare readable extracted content across file types, not only within one queue.
- Keep topic context available when the next bounded batch is analyzed.
- Reuse categories consistently and expose the evidence behind each suggestion.
- Require approval per suggested topic folder; let users exclude individual files from a group before approving it.
- Bound prompt size and persist enough state to resume after a restart.

## Non-goals for this milestone

- OCR, transcription, or new media extractors.
- Embeddings or a vector database.
- A user-managed topic map.
- Replacing the existing duplicate rules or move journal.
- Sending full files to Ollama.

## Approaches considered

1. **One prompt for the entire library.** Rejected: context and memory use grow with the corpus, and large scans become fragile.
2. **Keep per-file classification.** Rejected: it cannot reliably relate acronym-heavy or cross-type files, especially across batches.
3. **Bounded mixed-type batches with durable topic context.** Recommended: each request stays small, while prior approved/proposed assignments provide context for later batches.

## Proposed flow

1. Existing type-specific extractors continue to produce capped structured summaries. Files with no meaningful extracted content carry an explicit low-evidence marker; filename and metadata alone must not be presented as content understanding.
2. Run library analysis as resumable background work. Extract at most 20 files per chunk, then analyze extracted files in model batches of at most 8. Process already-extracted files before reading the next chunk so the first suggestions arrive early.
3. Exact SHA and fingerprint rules remain first. For each model batch, send file IDs, queue type, filename, capped summary, and a bounded set of existing topic context. Topic context includes category names and representative prior summaries/rationales so the model can distinguish similarly named roots and reuse the right one.
4. Ollama returns a strict JSON grouping of each submitted file ID exactly once, with category, optional subcategory, confidence, rationale, and evidence quality. The worker validates IDs, completeness, and values before writing proposals. Invalid or failed analysis creates no move and falls back to the current safe `needs_model` behavior.
5. Store topic context durably in SQLite and update it from validated assignments. Context sent to any one call is capped; representative examples are selected deterministically. User edits and approved destinations take precedence over model suggestions when building future context.
6. Review proposals grouped by their complete suggested topic folder. One approval moves all included files to that folder; checked “Skip this file” items stay in Messy and can be restored to review with Undo.

The worker returns immediately when analysis starts and reports progress/results through worker events. The desktop remains usable while work continues, refreshes the review queue as suggestions arrive, and resumes persisted work on the next launch if the app closed mid-analysis. Extraction failures are marked separately and retried on a later fresh run.

## Data and compatibility

Use an additive SQLite schema change for durable topic descriptions/context; cap saved topic memories and prompt examples so both stay bounded as the corpus grows. Existing file, extraction, proposal, and action rows remain readable. Existing databases must open without reset. Existing single-file classify behavior can remain as fallback while the new analyst is unavailable or returns invalid output.

The exact topic-context row shape and summary caps are implementation calls, constrained by the flow above. Do not store full extracted text in the topic context table.

## Acceptance criteria

- Two extracted files with unrelated filenames and different queue types can be assigned to the same root in one analysis run.
- A later batch can reuse a topic established in an earlier batch, using its saved context.
- Prompt inputs and persisted topic context remain bounded as the corpus grows.
- Suggestions from the first 20-file extraction chunk are available before the full library finishes.
- Closing and reopening mid-run resumes from persisted file states/cursor without rereading completed files.
- Every candidate file is represented at most once; incomplete, duplicate, or unknown model IDs are rejected safely.
- Content-poor files carry low evidence quality rather than a false claim of semantic understanding.
- Topic-group approval retains collision-safe per-file moves and an auditable action for each moved or skipped file. Undo remains one action at a time.
- Existing databases open without data loss or reset.

## Implementation scope

Worker: Ollama batch API and validation, durable topic context, cross-type candidate selection, proposal integration, migration, and tests. Desktop: a single library-level analyze action, status/progress copy, and topic-group review UI with per-file exclusion. Architecture docs should describe Ollama as analyst and the extractors as evidence providers.

## Remaining implementation choices

- Pick context caps and deterministic representative selection based on current summary shapes and model context limits.
- Decide whether the legacy per-type proposal command remains available internally for fallback or is routed through the library operation.
- Keep the UI addition minimal and reuse current progress and proposal review mechanisms.
