import type { WorkerCommand, WorkerEvent } from "@untangle/shared";

export {};

declare global {
  interface Window {
    untangle: {
      call: (command: WorkerCommand) => Promise<unknown>;
      pickDirectory: () => Promise<string | null>;
      onEvent: (callback: (event: WorkerEvent) => void) => () => void;
    };
  }
}
