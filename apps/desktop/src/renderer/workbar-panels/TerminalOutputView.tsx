import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WorkbarTerminalGrid, WorkbarTerminalOutput } from "./TerminalWorkbarPanel.js";
import { createTerminalOutputWriter } from "./terminal-output-writer.js";
import { readTerminalTheme } from "./terminal-theme.js";

interface TerminalOutputViewProps {
  readonly title: string;
  readonly output?: WorkbarTerminalOutput;
  readonly active: boolean;
  readonly capability: "pty" | "pipe";
  readonly inputEnabled: boolean;
  readonly onInput: (data: string) => void;
  readonly onFocusChange?: (focused: boolean) => void;
  readonly onClipboard?: (action: "copy" | "paste") => void;
  readonly onResize?: (grid: WorkbarTerminalGrid) => void;
}

export function TerminalOutputView({
  title,
  output,
  active,
  capability,
  inputEnabled,
  onInput,
  onFocusChange,
  onClipboard,
  onResize,
}: TerminalOutputViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<{
    terminal: Terminal;
    fit: FitAddon;
    write: ReturnType<typeof createTerminalOutputWriter>;
    sync: (focus?: boolean) => void;
  } | null>(null);
  const propsRef = useRef({
    output,
    active,
    inputEnabled,
    onInput,
    onResize,
    onFocusChange,
    onClipboard,
  });
  propsRef.current = {
    output,
    active,
    inputEnabled,
    onInput,
    onResize,
    onFocusChange,
    onClipboard,
  };
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let themeFrame = 0;
    let themeMedia: MediaQueryList | undefined;
    let updateTheme: (() => void) | undefined;
    let inputSubscription: { dispose(): void } | undefined;
    let lastGrid = "";
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        const container = containerRef.current;
        if (disposed || !container) return;
        const terminal = new Terminal({
          disableStdin: !propsRef.current.inputEnabled,
          cursorBlink: true,
          screenReaderMode: true,
          convertEol: capability === "pipe",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          scrollback: 10000,
          theme: readTerminalTheme(container),
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
        inputSubscription = terminal.onData((data) => {
          if (propsRef.current.active && propsRef.current.inputEnabled) {
            propsRef.current.onInput(data);
          }
        });
        terminal.attachCustomKeyEventHandler((event) => {
          if (
            !event.altKey &&
            !event.shiftKey &&
            ((event.ctrlKey && !event.metaKey && event.key === "`") ||
              ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "t"))
          )
            return false;
          const windowsClipboard =
            !navigator.platform.startsWith("Mac") &&
            event.ctrlKey &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey;
          if (!windowsClipboard || !["c", "v"].includes(event.key.toLowerCase())) return true;
          event.preventDefault();
          if (event.type !== "keydown") return false;
          if (event.key.toLowerCase() === "c") {
            if (terminal.hasSelection()) propsRef.current.onClipboard?.("copy");
          } else if (propsRef.current.inputEnabled && propsRef.current.active) {
            propsRef.current.onClipboard?.("paste");
          }
          return false;
        });
        let needsFocus = true;
        const sync = (focus = false) => {
          if (!propsRef.current.active || !container.clientWidth || !container.clientHeight) return;
          fit.fit();
          if ((focus || needsFocus) && document.visibilityState === "visible") {
            terminal.focus();
            needsFocus = false;
          }
          const grid = `${terminal.cols}:${terminal.rows}`;
          if (grid === lastGrid) return;
          lastGrid = grid;
          propsRef.current.onResize?.({ columns: terminal.cols, rows: terminal.rows });
        };
        runtimeRef.current = { terminal, fit, write, sync };
        let previousTheme = JSON.stringify(terminal.options.theme);
        updateTheme = () => {
          if (themeFrame || disposed) return;
          themeFrame = requestAnimationFrame(() => {
            themeFrame = 0;
            if (disposed) return;
            const theme = readTerminalTheme(container);
            const serialized = JSON.stringify(theme);
            if (serialized === previousTheme) return;
            previousTheme = serialized;
            terminal.options.theme = theme;
          });
        };
        themeObserver = new MutationObserver(updateTheme);
        for (
          let ancestor: HTMLElement | null = container;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          themeObserver.observe(ancestor, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme", "data-mode"],
          });
        }
        themeMedia = matchMedia("(prefers-color-scheme: dark)");
        themeMedia.addEventListener("change", updateTheme);
        observer = new ResizeObserver(() => sync());
        observer.observe(container);
        sync(true);
        if (propsRef.current.output) void write(propsRef.current.output);
      })
      .catch(() => {
        if (!disposed) setError("终端显示加载失败，请重新打开面板。");
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      themeObserver?.disconnect();
      cancelAnimationFrame(themeFrame);
      if (updateTheme) themeMedia?.removeEventListener("change", updateTheme);
      inputSubscription?.dispose();
      runtimeRef.current?.terminal.dispose();
      runtimeRef.current = null;
      propsRef.current.onFocusChange?.(
        Boolean(document.activeElement?.closest(".tool-panel__terminal-screen")),
      );
    };
  }, [capability]);

  useEffect(() => {
    if (output && runtimeRef.current) void runtimeRef.current.write(output);
  }, [output]);

  useEffect(() => {
    runtimeRef.current?.sync(active);
  }, [active]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.terminal.options.disableStdin = !inputEnabled;
    if (active && inputEnabled) runtime.sync(true);
  }, [active, inputEnabled]);

  return (
    <>
      <div
        ref={containerRef}
        className="tool-panel__terminal-screen"
        role="log"
        aria-label={`${title} 输出`}
        aria-live="off"
        onFocusCapture={() => onFocusChange?.(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onFocusChange?.(false);
        }}
      />
      {error && <span role="alert">{error}</span>}
    </>
  );
}
