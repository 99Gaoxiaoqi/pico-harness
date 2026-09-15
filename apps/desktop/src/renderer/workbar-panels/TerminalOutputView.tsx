import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WorkbarTerminalGrid, WorkbarTerminalOutput } from "./TerminalWorkbarPanel.js";
import { createTerminalOutputWriter } from "./terminal-output-writer.js";

interface TerminalOutputViewProps {
  readonly title: string;
  readonly output?: WorkbarTerminalOutput;
  readonly active: boolean;
  readonly capability: "pty" | "pipe";
  readonly onResize?: (grid: WorkbarTerminalGrid) => void;
}

export function TerminalOutputView({
  title,
  output,
  active,
  capability,
  onResize,
}: TerminalOutputViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<{
    terminal: Terminal;
    fit: FitAddon;
    write: ReturnType<typeof createTerminalOutputWriter>;
  } | null>(null);
  const propsRef = useRef({ output, active, onResize });
  propsRef.current = { output, active, onResize };
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let lastGrid = "";
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        const container = containerRef.current;
        if (disposed || !container) return;
        const terminal = new Terminal({
          disableStdin: true,
          screenReaderMode: true,
          convertEol: capability === "pipe",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          scrollback: 10000,
          theme: { background: "#0b1020", foreground: "#dbeafe" },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(container);
        const write = createTerminalOutputWriter({
          reset: () => {
            if (!disposed) terminal.reset();
          },
          write: (data, callback) => {
            if (disposed) callback();
            else terminal.write(data, callback);
          },
        });
        runtimeRef.current = { terminal, fit, write };
        const sync = () => {
          if (!propsRef.current.active || !container.clientWidth || !container.clientHeight) return;
          fit.fit();
          const grid = `${terminal.cols}:${terminal.rows}`;
          if (grid === lastGrid) return;
          lastGrid = grid;
          propsRef.current.onResize?.({ columns: terminal.cols, rows: terminal.rows });
        };
        observer = new ResizeObserver(sync);
        observer.observe(container);
        sync();
        if (propsRef.current.output) void write(propsRef.current.output);
      })
      .catch(() => {
        if (!disposed) setError("终端显示加载失败，请重新打开面板。");
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      runtimeRef.current?.terminal.dispose();
      runtimeRef.current = null;
    };
  }, [capability]);

  useEffect(() => {
    if (output && runtimeRef.current) void runtimeRef.current.write(output);
  }, [output]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!active || !runtime || !containerRef.current?.clientWidth) return;
    runtime.fit.fit();
    propsRef.current.onResize?.({ columns: runtime.terminal.cols, rows: runtime.terminal.rows });
  }, [active]);

  return (
    <>
      <div
        ref={containerRef}
        className="tool-panel__terminal-screen"
        role="log"
        aria-label={`${title} 输出`}
        aria-live="off"
      />
      {error && <span role="alert">{error}</span>}
    </>
  );
}
