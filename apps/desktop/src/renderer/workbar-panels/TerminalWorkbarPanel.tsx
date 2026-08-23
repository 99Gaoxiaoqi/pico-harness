import { CircleAlert, Link, Plus, Square, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export type WorkbarTerminalStatus = "starting" | "running" | "interrupted" | "exited";

export interface WorkbarTerminalInstance {
  readonly id: string;
  readonly title: string;
  readonly status: WorkbarTerminalStatus;
  readonly attached: boolean;
  readonly sequence: number;
  readonly cwd?: string;
  readonly exitCode?: number | null;
}

export interface WorkbarTerminalOutput {
  readonly terminalId: string;
  readonly text: string;
  readonly sequence: number;
  readonly truncated?: boolean;
}

export interface WorkbarTerminalGrid {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalWorkbarPanelProps {
  readonly terminals: readonly WorkbarTerminalInstance[];
  readonly activeTerminalId?: string;
  readonly output?: WorkbarTerminalOutput | null;
  readonly active: boolean;
  readonly loading: boolean;
  readonly error?: string | null;
  readonly onCreate: () => void;
  readonly onSelect: (terminalId: string) => void;
  readonly onAttach: (terminalId: string) => void;
  readonly onInput: (terminalId: string, input: string) => void;
  readonly onResize: (terminalId: string, grid: WorkbarTerminalGrid) => void;
  readonly onStop: (terminalId: string) => void;
  /** Starts/stops status/output polling only. It must never stop the hosted process. */
  readonly onSetPollingActive: (active: boolean) => void;
}

export function terminalGridFromBounds(width: number, height: number): WorkbarTerminalGrid {
  const columns = Math.min(300, Math.max(20, Math.floor(Math.max(0, width - 20) / 8)));
  const rows = Math.min(100, Math.max(4, Math.floor(Math.max(0, height - 16) / 18)));
  return { columns, rows };
}

export function shouldPollTerminalPanel(active: boolean, terminalId?: string): boolean {
  return active && Boolean(terminalId);
}

export function TerminalWorkbarPanel({
  terminals,
  activeTerminalId,
  output,
  active,
  loading,
  error,
  onCreate,
  onSelect,
  onAttach,
  onInput,
  onResize,
  onStop,
  onSetPollingActive,
}: TerminalWorkbarPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastGridRef = useRef<string>("");
  const [input, setInput] = useState("");
  const selected = terminals.find((terminal) => terminal.id === activeTerminalId);
  const selectedOutput = output?.terminalId === selected?.id ? output : undefined;

  useEffect(() => {
    const polling = shouldPollTerminalPanel(active, selected?.id);
    onSetPollingActive(polling);
    return () => onSetPollingActive(false);
  }, [active, onSetPollingActive, selected?.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!active || !selected || !viewport) return;
    const sync = () => {
      const bounds = viewport.getBoundingClientRect();
      const grid = terminalGridFromBounds(bounds.width, bounds.height);
      const gridKey = `${selected.id}:${grid.columns}:${grid.rows}`;
      if (lastGridRef.current === gridKey) return;
      lastGridRef.current = gridKey;
      onResize(selected.id, grid);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    sync();
    return () => observer.disconnect();
  }, [active, onResize, selected]);

  const submitInput = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || selected.status !== "running" || !selected.attached || !input) return;
    onInput(selected.id, input);
    setInput("");
  };

  const handleTerminalKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextIndex =
      event.key === "ArrowLeft"
        ? (index - 1 + terminals.length) % terminals.length
        : (index + 1) % terminals.length;
    const next = terminals[nextIndex];
    if (!next) return;
    onSelect(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <section className="tool-panel tool-panel--terminal" aria-label="终端">
      <header className="tool-panel__terminal-tabs">
        <div role="tablist" aria-label="终端实例">
          {terminals.map((terminal, index) => (
            <button
              key={terminal.id}
              ref={(node) => {
                if (node) tabRefs.current.set(terminal.id, node);
                else tabRefs.current.delete(terminal.id);
              }}
              type="button"
              id={terminalTabId(terminal.id)}
              role="tab"
              aria-selected={terminal.id === selected?.id}
              aria-controls={terminalPanelId(terminal.id)}
              tabIndex={terminal.id === selected?.id ? 0 : -1}
              data-status={terminal.status}
              onClick={() => onSelect(terminal.id)}
              onKeyDown={(event) => handleTerminalKeyDown(event, index)}
            >
              <TerminalSquare aria-hidden="true" size={13} />
              <span>{terminal.title}</span>
              <small aria-label={terminalStatusLabel(terminal.status)} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tool-panel__icon-button"
          aria-label="新建终端"
          onClick={onCreate}
        >
          <Plus aria-hidden="true" size={15} />
        </button>
      </header>

      {error && (
        <p className="tool-panel__error" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          {error}
        </p>
      )}

      {!selected ? (
        <div className="tool-panel__state" aria-busy={loading}>
          <TerminalSquare aria-hidden="true" size={22} />
          <strong>{loading ? "正在加载终端…" : "没有终端"}</strong>
          <span>新建终端后，进程由 Runtime Host 持续托管。</span>
          {!loading && (
            <button type="button" onClick={onCreate}>
              新建终端
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="tool-panel__terminal-meta">
            <span title={selected.cwd}>{selected.cwd ?? "工作区目录"}</span>
            <span>
              {terminalStatusLabel(selected.status)} · seq {selected.sequence}
              {selected.status === "exited" && selected.exitCode !== undefined
                ? ` · exit ${selected.exitCode ?? "unknown"}`
                : ""}
            </span>
            <div>
              {!selected.attached && selected.status !== "exited" && (
                <button type="button" onClick={() => onAttach(selected.id)}>
                  <Link aria-hidden="true" size={13} />
                  连接
                </button>
              )}
              {selected.status !== "exited" && (
                <button type="button" onClick={() => onStop(selected.id)}>
                  <Square aria-hidden="true" size={12} />
                  停止
                </button>
              )}
            </div>
          </div>
          <div
            ref={viewportRef}
            id={terminalPanelId(selected.id)}
            className="tool-panel__terminal-viewport"
            role="tabpanel"
            aria-labelledby={terminalTabId(selected.id)}
          >
            <pre role="log" aria-label={`${selected.title} 输出`} aria-live="off" tabIndex={0}>
              {selectedOutput?.text ?? ""}
            </pre>
            {!selectedOutput && <span className="tool-panel__terminal-placeholder">尚无输出</span>}
            {selectedOutput?.truncated && (
              <span className="tool-panel__terminal-truncated">较早输出已截断</span>
            )}
          </div>
          <form className="tool-panel__terminal-input" onSubmit={submitInput}>
            <label>
              <span className="sr-only">终端输入</span>
              <input
                value={input}
                placeholder={selected.attached ? "输入命令并按 Enter" : "连接终端后输入"}
                disabled={selected.status !== "running" || !selected.attached}
                spellCheck={false}
                onChange={(event) => setInput(event.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={selected.status !== "running" || !selected.attached || input.length === 0}
            >
              发送
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function terminalStatusLabel(status: WorkbarTerminalStatus): string {
  const labels: Record<WorkbarTerminalStatus, string> = {
    starting: "启动中",
    running: "运行中",
    interrupted: "连接中断",
    exited: "已退出",
  };
  return labels[status];
}

function terminalTabId(terminalId: string): string {
  return `workbar-terminal-tab-${encodeURIComponent(terminalId)}`;
}

function terminalPanelId(terminalId: string): string {
  return `workbar-terminal-panel-${encodeURIComponent(terminalId)}`;
}
