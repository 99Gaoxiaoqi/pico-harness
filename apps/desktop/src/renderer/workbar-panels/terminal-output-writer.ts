import type { WorkbarTerminalOutput } from "./TerminalWorkbarPanel.js";

interface TerminalSink {
  reset(): void;
  write(data: string, callback: () => void): void;
}

/** Feed snapshots into the VT parser without replaying previously parsed output. */
export function createTerminalOutputWriter(terminal: TerminalSink) {
  let previous: WorkbarTerminalOutput | undefined;
  let next: WorkbarTerminalOutput | undefined;
  let running = false;
  let pending = Promise.resolve();
  return (output: WorkbarTerminalOutput): Promise<void> => {
    next = output;
    if (running) return pending;
    running = true;
    pending = Promise.resolve().then(async () => {
      try {
        // A slow VT parser retains only its current write and the latest snapshot.
        while (next) {
          const current = next;
          next = undefined;
          const start = current.startOffset ?? 0;
          const previousEnd = previous ? (previous.startOffset ?? 0) + previous.text.length : 0;
          const sameStream =
            previous?.terminalId === current.terminalId &&
            previous?.resetVersion === current.resetVersion;
          const continuous =
            sameStream &&
            start <= previousEnd &&
            previousEnd <= start + current.text.length &&
            (current.startOffset !== undefined || current.text.startsWith(previous!.text));
          const chunk = continuous ? current.text.slice(previousEnd - start) : current.text;
          if (previous && !continuous) terminal.reset();
          previous = current;
          if (chunk) await new Promise<void>((resolve) => terminal.write(chunk, resolve));
        }
      } finally {
        running = false;
      }
    });
    return pending;
  };
}
