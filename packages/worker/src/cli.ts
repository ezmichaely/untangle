import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { WorkerCommand, WorkerRequest, WorkerResponse } from "@untangle/shared";
import { UntangleService } from "./service.js";

function defaultDbPath(): string {
  const home = process.env.HOME || process.cwd();
  return (
    process.env.UNTANGLE_DB ??
    path.join(home, "Library", "Application Support", "Untangle", "untangle.db")
  );
}

async function main(): Promise<void> {
  const dbPath = defaultDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const service = new UntangleService(dbPath);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  const write = (msg: unknown) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  write({ type: "ready", dbPath });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: WorkerRequest;
    try {
      req = JSON.parse(line) as WorkerRequest;
    } catch {
      write({ id: "?", ok: false, error: "invalid json" } satisfies WorkerResponse);
      continue;
    }
    try {
      const result = await service.handle(req.command as WorkerCommand, (event) => {
        write({ id: req.id, event });
      });
      write({ id: req.id, ok: true, result } satisfies WorkerResponse);
    } catch (err) {
      write({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResponse);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
