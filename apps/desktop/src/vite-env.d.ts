import type { WorkerCommand } from "@untangle/shared";

export {};

declare global {
  interface Window {
    untangle: {
      call: (command: WorkerCommand) => Promise<unknown>;
      pickDirectory: () => Promise<string | null>;
    };
  }
}
