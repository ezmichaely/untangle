# Untangle — architecture & frameworks

How this project is put together, what runs when, and how that differs from **graphify** (a separate local tooling pass on this *repo*, not on Messy).

## What Untangle is

A **local-first desktop app**: you pick a **Messy** folder and an empty **Clean / Untangle** folder. Untangle inventories Messy, suggests where each file should live, and only moves files after you approve. Everything stays on your machine.

```text
You (desktop UI)
    │  IPC commands / progress
    ▼
Electron main  ──spawns──►  Node worker (packages/worker)
                                │
                                ├─ SQLite index (userData/untangle.db)
                                ├─ filesystem (Messy + Clean)
                                ├─ Ollama text analyst: qwen3:8b (127.0.0.1:11434)
                                └─ Ollama image reader: qwen2.5vl:7b (127.0.0.1:11434)
```

**Graphify is not in this runtime.** It was used once (and can be re-run) to map *this codebase* into `graphify-out/`. It does not open Messy and does not power duplicate detection.

---

## How you use the app (5 steps)

| Step | When | What happens | Framework / layer |
|------|------|--------------|-------------------|
| 1. Folders | First launch | Choose Messy + Clean roots; save to SQLite | Electron dialogs → worker `setRoots` |
| 2. Refresh | After returns / first inventory | Walk Messy, upsert files, SHA-256, reclaim hand-returns | Node `fs` + `better-sqlite3` |
| 3. Suggest | Library-wide | Resumable 20-file extraction chunks → bounded mixed-type Ollama analysis | ExcelJS, mammoth, pdf-parse, JSZip; Ollama HTTP |
| 4. Review | One suggested topic folder at a time | Exclude individual files or approve the included group (collision-safe) | React UI + worker `approveTopicGroup` |
| 5. Duplicates | After moves | Exact hash + near versions → pick winner, archive rest | worker `findVersionGroups` / `pickWinner` |

Related Messy files are linked by **SHA-256 / fingerprints / version groups in SQLite**, not by graphify.

---

## Monorepo layout

| Path | Role | Runtime? |
|------|------|----------|
| `apps/desktop` | Electron shell + React UI | Yes — what you launch with `pnpm dev` |
| `packages/worker` | Scan, hash, extract, propose, move, versions | Yes — child process owned by Electron |
| `packages/shared` | IPC types, queue order, `uniqueDestPath` | Yes — imported by both |
| `docs/` | Design, plan, this architecture note | No |
| `graphify-out/` | Code knowledge graph (gitignored) | No — developer tooling only |

Package manager: **pnpm** workspaces only (`packageManager` pin + `preinstall` guard).

---

## Frameworks — when each is used

### Desktop UI (`apps/desktop`)

| Piece | Framework / lib | Used for |
|-------|-----------------|----------|
| Window + OS | **Electron** | App window, folder picker, spawn worker, IPC |
| UI | **React 19** | Step screens, review, toasts |
| Build | **Vite** + `@vitejs/plugin-react` | Dev server (`127.0.0.1:5173`) + production bundle |
| Styling | **Tailwind CSS v4** | Layout / theme tokens |
| Components | **shadcn/ui** (Radix Nova) + **radix-ui** | Card, Button, Progress, Select, etc. |
| Icons | **lucide-react** | Step / action icons |
| Toasts | **sonner** | Bottom-right success/error detail |
| Language | **TypeScript** | All UI source |

Electron loads Vite in dev; in prod it serves the built `dist/`. The **main** process (`electron/main.cjs`) never walks Messy itself — it forwards `worker:call` to the Node worker over stdio JSON.

### Worker (`packages/worker`)

| Piece | Framework / lib | Used for |
|-------|-----------------|----------|
| Runtime | **Node 20+** | Long jobs off the UI thread |
| DB | **better-sqlite3** | Inventory, proposals, actions, version groups |
| XLSX | **exceljs** | Sheet/summary extract |
| DOCX | **mammoth** | Text extract |
| PDF | **pdf-parse** | Text extract |
| PPTX | **jszip** + XML | Slide text |
| Topic analysis | **Local Ollama** HTTP API | qwen2.5vl:7b describes images; qwen3:8b groups file evidence using bounded topic context |
| Tests | **Vitest** | Unit tests |
| Language | **TypeScript** → `tsc` → `dist/` | Built before Electron uses `cli.js` |

Deterministic path: scan → hash → extract → rule proposals (exact twin / fingerprint) → bounded cross-type topic analysis → move/undo. Extractors and qwen2.5vl read local file content; qwen3 sees only capped summaries. Both Ollama calls use `127.0.0.1`; no file data is sent to a cloud service.

### Shared (`packages/shared`)

| Piece | Used for |
|-------|----------|
| TypeScript types | `WorkerCommand`, `ProposalView`, `VersionGroupView`, … |
| `TYPE_ORDER` / `extToQueueType` | Which extensions enter which queue |
| `uniqueDestPath` | `name (2).ext` collision policy (UI + worker) |

No React, no Electron, no SQLite here.

---

## Data that touches Messy

Stored under Electron **userData** (`untangle.db`), not in the git repo:

- Roots (Messy path, Clean path)
- File rows (path, size, mtime, ext, sha256, status)
- Extractions (capped JSON + fingerprint)
- Proposals, categories, bounded topic context, action journal, version groups

File **bytes** stay on disk; the DB never stores full documents.

---

## How topics are classified (image vs docx vs pptx)

Untangle does **not** build a “topic graph” of Messy. It maintains a **folder taxonomy** in SQLite (`categories`) plus a capped set of topic descriptions/examples in `topic_context`. The worker sends Ollama mixed-type batches of compact summaries so it can group related files across queue boundaries and later batches.

| Signal | Cross-type? | What it means |
|--------|-------------|----------------|
| Same **SHA-256** as a moved file | Only identical bytes | Exact copy → same folder (any type if bytes match — rare across docx/pptx/image) |
| Same **fingerprint** as a moved file | Same extractor family | Near-identical *extracted* content → same folder |
| **Ollama** + saved topic context | Yes (best-effort) | Model sees filename, type, capped summary, evidence quality, and a bounded set of category descriptions/examples; worker validates IDs and persists topic context |
| You edit path in step 4 | Yes | Human override — source of truth |

Readable files across types can be grouped together in the same analysis batch, and later batches receive bounded saved topic context. For image files, qwen2.5vl:7b creates a short visual description that qwen3:8b uses alongside document summaries. Video and unsupported image files remain metadata-only. A fresh analysis clears stale topic examples, then builds context from the new proposals. Both models run locally; there is no cloud analysis path.

The library analysis operation reads up to **20 files per extraction chunk**, then proposes from the extracted backlog in Ollama batches of up to **8 files**. It returns control immediately, emits progress and new suggestions as chunks finish, and resumes from SQLite state after restart. Extraction remains format-aware; grouping crosses file types. A failed extraction is recorded and retried on a later fresh run.

```text
Messy files (any type)
    → extract capped summary (office text + local image description)
    → bounded mixed-type Ollama grouping + saved topic context
    → you approve → category becomes an anchor for later files
```

## Graphify — can we use it?

Yes, **as local developer (or corpus) tooling** — not as Untangle’s classifier.

| Question | Answer |
|----------|--------|
| Part of the Untangle app runtime? | **No.** |
| Free locally? | **Code AST = free.** Docs/papers/images semantic extract may use Gemini/host LLM and cost tokens. |
| Ran on what so far? | This **git repo** → `graphify-out/` (gitignored). |
| Graph Messy with graphify? | You *can* point graphify at Messy, but that builds a knowledge-graph of entities/links for exploration — it does **not** replace approve/move, collision policy, or the Clean folder tree. A large Messy corpus will be slow and (for docs/images) not free. |
| Better for “same topic across types”? | Untangle’s path: richer summaries + shared categories + (later, if needed) embeddings. Graphify path: optional offline map of a folder; separate from the organizer. |

Messy **duplicate/version** mapping in-product (not topics):

```text
exact twin     → proposeBatch (same sha256 as a moved file)
near versions  → findVersionGroups + summaryMismatches
resolve        → pickWinner → _Archive/
hand return    → scanMessy reclaim
```

---

## Commands cheat sheet

```bash
pnpm install          # pnpm only
pnpm build            # shared → worker → desktop
pnpm test             # shared + worker Vitest
pnpm dev              # Vite + Electron + worker
ollama pull qwen3:8b  # optional, for classify
```

---

## Related docs

- Product design: `docs/superpowers/specs/2026-11-10-untangle-design.md`
- Implementation plan: `docs/superpowers/plans/2026-11-10-untangle-v1.md`
- Code graph (optional): open `graphify-out/graph.html` after a local graphify run
