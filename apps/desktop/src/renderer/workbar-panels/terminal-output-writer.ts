import type { WorkbarTerminalOutput } from "./TerminalWorkbarPanel.js";

interface TerminalSink {
  reset(): void;
  write(data: string, callback: () => void): void;
}

/** Feed snapshots into the VT parser without replaying previously parsed output. */
export function createTerminalOutputWriter(terminal: TerminalSink) {
  let previous: WorkbarTerminalOutput | undefined;
  let pending = Promise.resolve();
  return (output: WorkbarTerminalOutput): Promise<void> => {
    pending = pending.then(async () => {
      const start = output.startOffset ?? 0;
      const previousEnd = previous ? (previous.startOffset ?? 0) + previous.text.length : 0;
      const sameStream =
        previous?.terminalId === output.terminalId &&
        previous?.resetVersion === output.resetVersion;
      const continuous =
        sameStream &&
        start <= previousEnd &&
        previousEnd <= start + output.text.length &&
        (output.startOffset !== undefined || output.text.startsWith(previous!.text));
      const chunk = continuous ? output.text.slice(previousEnd - start) : output.text;
      if (previous && !continuous) terminal.reset();
      previous = output;
      if (chunk) await new Promise<void>((resolve) => terminal.write(chunk, resolve));
    });
    return pending;
  };
}
