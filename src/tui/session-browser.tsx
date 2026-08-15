import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { CliSessionSummary } from "../cli/session-resolver.js";
import { presentSession } from "./session-presentation.js";
import { searchSessionBrowserSessions } from "./session-browser-adapter.js";

export const SESSION_BROWSER_TITLE_WIDTH = 56;
export const SESSION_BROWSER_CWD_WIDTH = 48;

export interface SessionBrowserSession extends CliSessionSummary {
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  forkFrom?: string;
  forkParentTitle?: string;
  isCurrent?: boolean;
}

export interface SessionBrowserState {
  selectedIndex: number;
}

export interface SessionBrowserCallbacks {
  onConfirm?: (session: SessionBrowserSession) => void;
  onCancel?: () => void;
}

export interface SessionBrowserProps {
  sessions: readonly SessionBrowserSession[];
  state?: SessionBrowserState;
  maxItems?: number;
  /** 选择确认回调（3-D 客户端接线；缺省为纯浏览）。 */
  callbacks?: SessionBrowserCallbacks;
}

export function SessionBrowser({
  sessions,
  state = createSessionBrowserState(),
  maxItems,
  callbacks: _callbacks,
}: SessionBrowserProps): React.ReactNode {
  void _callbacks;
  return (
    <Box flexDirection="column">
      {formatSessionBrowser(sessions, { state, maxItems })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function createSessionBrowserState(
  overrides: Partial<SessionBrowserState> = {},
): SessionBrowserState {
  return {
    selectedIndex: Math.max(0, overrides.selectedIndex ?? 0),
  };
}

export function moveSessionBrowserSelection(
  state: SessionBrowserState,
  sessions: readonly SessionBrowserSession[],
  delta: number,
): SessionBrowserState {
  const visibleCount = sessions.length;
  if (visibleCount === 0) return { ...state, selectedIndex: 0 };

  const nextIndex = modulo(state.selectedIndex + delta, visibleCount);
  return { ...state, selectedIndex: nextIndex };
}

export function confirmSessionBrowserSelection(
  state: SessionBrowserState,
  sessions: readonly SessionBrowserSession[],
  callbacks: SessionBrowserCallbacks = {},
): SessionBrowserState {
  const selected = sessions[clampSelection(state.selectedIndex, sessions.length)];
  if (selected) callbacks.onConfirm?.(selected);
  return state;
}

export function cancelSessionBrowserSelection(
  callbacks: SessionBrowserCallbacks = {},
): SessionBrowserState {
  callbacks.onCancel?.();
  return createSessionBrowserState();
}

export function formatSessionBrowser(
  sessions: readonly SessionBrowserSession[],
  options: {
    state?: SessionBrowserState;
    maxItems?: number;
    maxTitleLength?: number;
    maxCwdLength?: number;
    now?: Date;
  } = {},
): string {
  const state = options.state ?? createSessionBrowserState();
  const visible = sessions;
  const selectedIndex = clampSelection(state.selectedIndex, visible.length);
  const maxItems = options.maxItems ?? 10;
  const titleWidth = options.maxTitleLength ?? SESSION_BROWSER_TITLE_WIDTH;
  const cwdWidth = options.maxCwdLength ?? SESSION_BROWSER_CWD_WIDTH;
  const firstShownIndex = visibleWindowStart(selectedIndex, visible.length, maxItems);
  const shown = visible.slice(firstShownIndex, firstShownIndex + maxItems);
  const lines = [`Sessions [workspace] ${visible.length}`];

  if (visible.length === 0) {
    lines.push("No sessions in current workspace.");
    return lines.join("\n");
  }

  for (let index = 0; index < shown.length; index++) {
    const session = shown[index]!;
    const visibleIndex = firstShownIndex + index;
    const marker = visibleIndex === selectedIndex ? ">" : " ";
    const presentation = presentSession(session, {
      maxTitleLength: titleWidth,
      ...(options.now ? { now: options.now } : {}),
    });
    lines.push(`${marker} ${presentation.title}`);
    lines.push(`  ${presentation.metadata}${presentation.isCurrent ? " · Current" : ""}`);
    if (presentation.forkLabel) lines.push(`  ↳ ${presentation.forkLabel}`);
    lines.push(`  id=${truncateInline(presentation.identifier, 28)}`);
    if (session.title && session.firstMessage && session.firstMessage !== session.title) {
      lines.push(`  ${truncateInline(session.firstMessage, titleWidth)}`);
    }
    if (session.lastMessage && session.lastMessage !== session.firstMessage) {
      lines.push(`  last: ${truncateInline(session.lastMessage, Math.max(1, titleWidth - 6))}`);
    }
    lines.push(`  cwd=${truncateInline(session.cwd, cwdWidth)}`);
  }

  const hidden = visible.length - shown.length;
  if (hidden > 0) lines.push(`... ${hidden} sessions hidden`);
  return lines.join("\n");
}

function clampSelection(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(0, index), itemCount - 1);
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function visibleWindowStart(selectedIndex: number, itemCount: number, maxItems: number): number {
  const visibleCount = Math.max(1, maxItems);
  if (itemCount <= visibleCount) return 0;
  return Math.min(Math.max(0, selectedIndex - visibleCount + 1), itemCount - visibleCount);
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (inline.length <= maxLength) return inline;
  return `${inline.slice(0, Math.max(0, maxLength - 3))}...`;
}

export interface InteractiveSessionBrowserProps {
  sessions: readonly SessionBrowserSession[];
  onSelect: (session: SessionBrowserSession, mode: "resume" | "fork") => Promise<void> | void;
  onCancel?: () => void;
}

/**
 * 键盘交互会话浏览器（3-D 对抗评审二轮 P0 提取自 repl.tsx 的
 * TuiSessionBrowserDialog，客户端对话框共用）：方向键移动、/ 搜索过滤、
 * Enter 恢复、f 分叉、Esc/q 取消。
 */
export function InteractiveSessionBrowser({
  sessions,
  onSelect,
  onCancel,
}: InteractiveSessionBrowserProps): React.ReactNode {
  const [state, setState] = useState<SessionBrowserState>(() => createSessionBrowserState());
  const [search, setSearch] = useState({ active: false, query: "" });
  const visibleSessions = searchSessionBrowserSessions(sessions, search.query);

  useInput((input, key) => {
    if (search.active) {
      if (key.escape || key.return) {
        setSearch((current) => ({ ...current, active: false }));
        return;
      }
      if (key.backspace || key.delete) {
        setSearch((current) => ({ ...current, query: current.query.slice(0, -1) }));
        setState((current) => ({ ...current, selectedIndex: 0 }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearch((current) => ({ ...current, query: current.query + input }));
        setState((current) => ({ ...current, selectedIndex: 0 }));
      }
      return;
    }

    if (key.upArrow) {
      setState((current) => moveSessionBrowserSelection(current, visibleSessions, -1));
      return;
    }

    if (key.downArrow) {
      setState((current) => moveSessionBrowserSelection(current, visibleSessions, 1));
      return;
    }

    if (input === "/") {
      setSearch((current) => ({ ...current, active: true }));
      return;
    }

    if (key.return || input === "f") {
      const mode = input === "f" ? "fork" : "resume";
      setState((current) =>
        confirmSessionBrowserSelection(current, visibleSessions, {
          onConfirm: (session) => void onSelect(session, mode),
        }),
      );
      return;
    }

    if (key.escape || input === "q") {
      onCancel?.();
    }
  });

  return (
    <>
      <Text dimColor>
        {search.active
          ? `Search: ${search.query}▋`
          : search.query
            ? `Search: ${search.query}`
            : "/ search"}
        {" · Enter resume · f fork · current workspace"}
      </Text>
      <SessionBrowser sessions={visibleSessions} state={state} />
    </>
  );
}
