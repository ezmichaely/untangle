# Agent instructions — Untangle

## Always on

1. **Ponytail (full)** — smallest complete change; automate, don’t add manual labor.
2. **Superpowers** — invoke relevant skills before acting (brainstorm → design → plan → implement → verify).
3. **Agent skills** — use the phase skill from `using-agent-skills` (spec, TDD, debug, review, etc.).

Project rule mirror: `.cursor/rules/always-workflow.mdc` (`alwaysApply: true`).

## Stack (don’t reinvent)

- `apps/desktop` — Electron + React + Vite + Tailwind + shadcn
- `packages/worker` — Node + better-sqlite3 + extractors + Ollama
- `packages/shared` — IPC types / path helpers
- Package manager: **pnpm only**

See `docs/architecture.md`.

## Active product direction

Ollama should act as a **batch topic analyst** (group related files), not only per-file folder stamps. Spec: `docs/superpowers/specs/2026-11-10-ollama-batch-analyst.md`.
