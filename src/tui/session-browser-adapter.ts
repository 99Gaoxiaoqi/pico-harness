import type { CliSessionSummary } from "../cli/session-resolver.js";
import type { SessionBrowserSession } from "./session-browser.js";

export interface CliSessionBrowserSummary extends CliSessionSummary {
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  forkFrom?: string;
}

export function mapCliSessionsToBrowserSessions(
  summaries: readonly CliSessionBrowserSummary[],
  currentSessionId?: string,
): SessionBrowserSession[] {
  const titlesById = new Map(
    summaries.map((summary) => [
      summary.id,
      firstText(summary.title, summary.firstMessage, summary.lastMessage),
    ]),
  );
  return summaries.map((summary) => {
    const firstMessage = firstText(summary.firstMessage, summary.lastMessage);
    const title = firstText(summary.title, firstMessage);
    return {
      ...summary,
      ...(title ? { title } : {}),
      ...(firstMessage ? { firstMessage } : {}),
      ...(summary.forkFrom ? { forkParentTitle: titlesById.get(summary.forkFrom) } : {}),
      ...(summary.id === currentSessionId ? { isCurrent: true } : {}),
    };
  });
}

export function sessionSelectionToCommand(
  sessionId: string,
  mode: "resume" | "fork" = "resume",
): string {
  return `/${mode} ${sessionId}`;
}

export function searchSessionBrowserSessions(
  sessions: readonly SessionBrowserSession[],
  query: string,
): SessionBrowserSession[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...sessions];
  return sessions.filter((session) =>
    [
      session.id,
      session.cwd,
      session.title,
      session.firstMessage,
      session.lastMessage,
      session.forkParentTitle,
    ].some((value) => value?.toLowerCase().includes(normalized)),
  );
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.replace(/\s+/g, " ").trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
