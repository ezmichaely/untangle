# Ollama batch topic analyst

**Status:** Proposed  
**Goal:** Use the local model for *analysis* (group related files), not one-off folder stamps — without adding UI labor.

## Problem

Per-file classify splits related references, e.g.:

- `Negros_Oriental_Registered_Voters_2025`
- `2025_NLE_RVVAV_BY_SEX_AGE_112525`

Both support the same people-base / election work, but opaque acronyms vs plain names → two folders. Manual regrouping is not acceptable.

## Non-goals

- No new “draw the topic map yourself” screen
- No graphify in the runtime
- No embeddings / vector DB (still V1)
- Moves still require one Yes per file (safety) — labor we keep; *grouping* is automatic

## Design

When `proposeBatch` runs for a queue type:

1. **Cheap rules first** (unchanged): exact SHA twin → same dir; fingerprint twin → same dir.
2. **Batch analyst (new)** for remaining extracted files in this batch:
   - One Ollama call with: existing top-level categories + list of `{ id, filename, summary_cap }` (summary truncated).
   - Model returns JSON groups:  
     `{ "groups": [ { "category": "Election", "subcategory": "Registered Voters", "fileIds": [1,2], "rationale": "…" } ] }`
   - Every fileId in the batch needing model must appear in exactly one group.
   - Prefer **reuse** of existing category roots; invent a short new root only when nothing fits.
3. **Write proposals** from groups:  
   `Category/Subcategory/filename` via existing `polishPlacement` / `ensureCategory`.
4. If batch analyst fails → fall back to today’s per-file classify (no worse than now).

Acceptance example: the two voter files above land under the **same** category root (e.g. `Election/…`), different filenames OK; subcategory may differ slightly but must share the polished top-level.

## Why this uses the model better

One pass reasons over *siblings* (plain name + acronym) instead of N isolated guesses. User flow unchanged: Refresh → Prepare suggestions → Review one file (paths already aligned).

## Touch points

- `packages/worker/src/ollama.ts` — `analyzeBatchTopics`
- `packages/worker/src/propose.ts` — call analyst before per-file loop
- Tests with fake Ollama returning a shared group for the two names
- `docs/architecture.md` — Ollama role = analyst + namer
