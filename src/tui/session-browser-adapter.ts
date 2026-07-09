import type { CliSessionSummary } from "../cli/session-resolver.js";
import type { SessionBrowserSession } from "./session-browser.js";

export interface CliSessionBrowserSummary extends CliSessionSummary {
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
}

export function mapCliSessionsToBrowserSessions(
  summaries: readonly CliSessionBrowserSummary[],
): SessionBrowserSession[] {
  return summaries.map((summary) => {
    const firstMessage = firstText(summary.firstMessage, summary.lastMessage);
    const title = firstText(summary.title, firstMessage);
    return {
      ...summary,
      ...(title ? { title } : {}),
      ...(firstMessage ? { firstMessage } : {}),
    };
  });
}

export function sessionSelectionToCommand(sessionId: string): string {
  return `/resume ${sessionId}`;
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.replace(/\s+/g, " ").trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
