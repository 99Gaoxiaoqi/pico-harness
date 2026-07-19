import React from "react";
import { Box, Text } from "ink";
import type { CliSessionSummary } from "../cli/session-resolver.js";
import { presentSession } from "./session-presentation.js";

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
}

export function SessionBrowser({
  sessions,
  state = createSessionBrowserState(),
  maxItems,
}: SessionBrowserProps): React.ReactNode {
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
