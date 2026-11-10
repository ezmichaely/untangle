# Untangle

Local-first desktop app that organizes a **Messy** folder into a growing **Untangle** (clean) tree.

AI (Ollama) recommends categories from capped document summaries. Deterministic code scans, hashes, extracts, moves, and audits. Nothing moves until you approve.

## How it’s used

1. Choose **Messy** and **Clean** folders  
2. Refresh Messy (inventory + hash; picks up files you put back by hand)  
3. Prepare suggestions for one file type  
4. Review one file at a time → approve or skip  
5. Find duplicates / versions → keep one, archive the rest  

## Package manager

**pnpm only** (pinned via `packageManager`). Enable with Corepack:

```bash
corepack enable
pnpm install
```

`npm` / `yarn` installs are blocked by the `preinstall` script.

## Stack (what runs when)

| Layer | Frameworks | Role |
|-------|------------|------|
| Desktop | Electron + React 19 + Vite + Tailwind v4 + shadcn/ui + sonner | Window, 5-step UI, toasts |
| Worker | Node + better-sqlite3 + ExcelJS / mammoth / pdf-parse / JSZip | Scan, hash, extract, propose, move, versions |
| Classify (optional) | Ollama (`qwen3:8b`) on `127.0.0.1:11434` | Category JSON from capped summaries |
| Shared | TypeScript IPC types + path helpers | Contracts between UI and worker |

Full map: **[docs/architecture.md](docs/architecture.md)**.

## Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm dev
```

Optional helper AI:

```bash
ollama pull qwen3:8b
```

## Docs

- **Architecture & frameworks:** `docs/architecture.md`
- Design: `docs/superpowers/specs/2026-11-10-untangle-design.md`
- Plan: `docs/superpowers/plans/2026-11-10-untangle-v1.md`
- Agent workflow (always on): `AGENTS.md`, `.cursor/rules/always-workflow.mdc`

### Graphify (repo tooling, not Messy)

Graphify can run **locally** on this git repo to produce `graphify-out/` (code knowledge graph). Code AST extraction needs no API key. It does **not** graph your Messy folder and is **not** part of the Untangle runtime — Messy related files use SHA-256 / version groups in the worker instead.
