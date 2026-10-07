import { Button } from "../components.js";
import { CircleAlert, Link, TerminalSquare } from "lucide-react";
import { TerminalOutputView } from "./TerminalOutputView.js";

export type WorkbarTerminalStatus = "starting" | "running" | "interrupted" | "exited";

export interface WorkbarTerminalInstance {
  readonly id: string;
  readonly title: string;
  readonly status: WorkbarTerminalStatus;
  readonly attached: boolean;
  readonly sequence: number;
  readonly capability: "pty" | "pipe";
  readonly resizeSupported: boolean;
  readonly cwd?: string;
  readonly exitCode?: number | null;
}

export interface WorkbarTerminalOutput {
  readonly terminalId: string;
  readonly text: string;
  readonly sequence: number;
  readonly truncated?: boolean;
  /** UTF-16 offset of the retained snapshot in the current output stream. */
  readonly startOffset?: number;
  readonly resetVersion?: number;
}

export interface WorkbarTerminalGrid {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalWorkbarPanelProps {
  readonly terminal?: WorkbarTerminalInstance;
  readonly output?: WorkbarTerminalOutput | null;
  readonly active: boolean;
  readonly loading: boolean;
  readonly readOnly?: boolean;
  readonly error?: string | null;
  readonly onReconnect: () => void;
  readonly onInput: (terminalId: string, input: string) => void;
  readonly onFocusChange?: (focused: boolean) => void;
  readonly onClipboard?: (action: "copy" | "paste") => void;
  readonly onResize: (terminalId: string, grid: WorkbarTerminalGrid) => void;
}

export function TerminalWorkbarPanel({
  terminal,
  output,
  active,
  loading,
  readOnly = false,
  error,
  onReconnect,
  onInput,
  onFocusChange,
  onClipboard,
  onResize,
}: TerminalWorkbarPanelProps) {
  const terminalOutput = output?.terminalId === terminal?.id ? output : undefined;
  const disconnected = terminal?.status === "running" && !terminal.attached;
  const reconnectNeeded = disconnected || terminal?.status === "interrupted" || error;
  const status = terminalStatusMessage(terminal, loading);
  const showNotice = terminal && (status || readOnly || reconnectNeeded);

  return (
    <section className="tool-panel tool-panel--terminal" aria-label="终端">
      {error && (
        <p className="tool-panel__error" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          {error}
        </p>
      )}

      {!terminal ? (
        <div className="tool-panel__state" aria-busy={loading}>
          <TerminalSquare aria-hidden="true" size={22} />
          <strong>{loading ? "正在启动终端…" : error ? "终端启动失败" : "终端尚未启动"}</strong>
          <span>
            {loading
              ? "稍等片刻即可输入命令。"
              : readOnly
                ? "当前连接为只读，无法启动终端。"
                : "重试即可启动 Shell。"}
          </span>
          {!loading && !readOnly && (
            <Button variant="quiet" type="button" onClick={onReconnect}>
              重试
            </Button>
          )}
        </div>
      ) : (
        <>
          {showNotice && (
            <div className="tool-panel__terminal-notice" role="status" aria-busy={loading}>
              <span>{[status, readOnly && "当前为只读终端"].filter(Boolean).join(" · ")}</span>
              {reconnectNeeded && !loading && !readOnly && terminal.status !== "exited" && (
                <Button variant="quiet" type="button" onClick={onReconnect}>
                  <Link aria-hidden="true" size={13} />
                  重新连接
                </Button>
              )}
            </div>
          )}
          {(!terminal.resizeSupported || terminal.capability === "pipe") && (
            <p className="tool-panel__terminal-capability" role="status">
              当前使用兼容管道，不支持随面板调整尺寸。
            </p>
          )}
          <div className="tool-panel__terminal-viewport">
            <TerminalOutputView
              key={terminal.id}
              title={terminal.title}
              output={terminalOutput ?? undefined}
              active={active}
              capability={terminal.capability}
              inputEnabled={
                active && !readOnly && terminal.status === "running" && terminal.attached
              }
              onInput={(data) => onInput(terminal.id, data)}
              onFocusChange={onFocusChange}
              onClipboard={onClipboard}
              onResize={
                terminal.resizeSupported ? (grid) => onResize(terminal.id, grid) : undefined
              }
            />
            {terminalOutput?.truncated && (
              <span className="tool-panel__terminal-truncated">较早输出已截断</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function terminalStatusMessage(
  terminal: WorkbarTerminalInstance | undefined,
  loading: boolean,
): string | undefined {
  if (!terminal) return;
  if (terminal.status === "exited") {
    const exitCode =
      terminal.exitCode === undefined
        ? ""
        : terminal.exitCode === null
          ? " · 退出码未知"
          : ` · 退出码 ${terminal.exitCode}`;
    return `已退出${exitCode}`;
  }
  if (terminal.status === "starting") return "正在启动终端…";
  if (loading) return terminal.attached ? "正在重新连接…" : "正在连接终端…";
  if (terminal.status === "interrupted" || !terminal.attached) return "终端连接已断开";
  return;
}
