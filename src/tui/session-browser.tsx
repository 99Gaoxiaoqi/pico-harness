import React from "react";
import { Box, Text } from "ink";
import type { CliSessionSummary } from "../cli/session-resolver.js";
import { presentSession } from "./session-presentation.js";

export const SESSION_BROWSER_TITLE_WIDTH = 56;
export const SESSION_BROWSER_CWD_WIDTH = 48;

export type SessionBrowserScope = "cwd" | "all";

export interface SessionBrowserSession extends CliSessionSummary {
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  forkFrom?: string;
  forkParentTitle?: string;
  isCurrent?: boolean;
}

export interface SessionBrowserState {
  scope: SessionBrowserScope;
  selectedIndex: number;
}

export interface SessionBrowserCallbacks {
  onConfirm?: (session: SessionBrowserSession) => void;
  onCancel?: () => void;
}

export interface SessionBrowserProps {
  sessions: readonly SessionBrowserSession[];
  currentProjectCwd?: string;
  state?: SessionBrowserState;
  maxItems?: number;
}

export function SessionBrowser({
  sessions,
  currentProjectCwd,
  state = createSessionBrowserState(),
  maxItems,
}: SessionBrowserProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      {formatSessionBrowser(sessions, { currentProjectCwd, state, maxItems })
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
    scope: overrides.scope ?? "cwd",
    selectedIndex: Math.max(0, overrides.selectedIndex ?? 0),
  };
}

export function moveSessionBrowserSelection(
  state: SessionBrowserState,
  sessions: readonly SessionBrowserSession[],
  delta: number,
  currentProjectCwd?: string,
): SessionBrowserState {
  const visibleCount = filterSessions(sessions, state.scope, currentProjectCwd).length;
  if (visibleCount === 0) return { ...state, selectedIndex: 0 };

  const nextIndex = modulo(state.selectedIndex + delta, visibleCount);
  return { ...state, selectedIndex: nextIndex };
}

export function toggleSessionBrowserScope(
  state: SessionBrowserState,
  sessions: readonly SessionBrowserSession[],
  currentProjectCwd?: string,
): SessionBrowserState {
  const scope: SessionBrowserScope = state.scope === "cwd" ? "all" : "cwd";
  const visibleCount = filterSessions(sessions, scope, currentProjectCwd).length;
  return {
    scope,
    selectedIndex: clampSelection(state.selectedIndex, visibleCount),
  };
}

export function confirmSessionBrowserSelection(
  state: SessionBrowserState,
  sessions: readonly SessionBrowserSession[],
  currentProjectCwd?: string,
  callbacks: SessionBrowserCallbacks = {},
): SessionBrowserState {
  const visible = filterSessions(sessions, state.scope, currentProjectCwd);
  const selected = visible[clampSelection(state.selectedIndex, visible.length)];
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
    currentProjectCwd?: string;
    state?: SessionBrowserState;
    maxItems?: number;
    maxTitleLength?: number;
    maxCwdLength?: number;
    now?: Date;
  } = {},
): string {
  const state = options.state ?? createSessionBrowserState();
  const visible = filterSessions(sessions, state.scope, options.currentProjectCwd);
  const selectedIndex = clampSelection(state.selectedIndex, visible.length);
  const maxItems = options.maxItems ?? 10;
  const titleWidth = options.maxTitleLength ?? SESSION_BROWSER_TITLE_WIDTH;
  const cwdWidth = options.maxCwdLength ?? SESSION_BROWSER_CWD_WIDTH;
  const firstShownIndex = visibleWindowStart(selectedIndex, visible.length, maxItems);
  const shown = visible.slice(firstShownIndex, firstShownIndex + maxItems);
  const lines = [`Sessions [${state.scope}] ${visible.length}/${sessions.length}`];

  if (visible.length === 0) {
    lines.push(state.scope === "cwd" ? "No sessions in current cwd." : "No sessions found.");
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

function filterSessions(
  sessions: readonly SessionBrowserSession[],
  scope: SessionBrowserScope,
  currentProjectCwd: string | undefined,
): SessionBrowserSession[] {
  if (scope === "all") return [...sessions];
  const normalized = normalizeCwd(currentProjectCwd);
  if (!normalized) return [...sessions];
  return sessions.filter((session) => normalizeCwd(session.cwd) === normalized);
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

function normalizeCwd(value: string | undefined): string | undefined {
  const inline = value?.replace(/\s+/g, " ").trim();
  if (!inline) return undefined;
  const normalized = inline.replace(/[\\/]+$/, "");
  return normalized.length > 0 ? normalized : inline;
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (inline.length <= maxLength) return inline;
  return `${inline.slice(0, Math.max(0, maxLength - 3))}...`;
}
