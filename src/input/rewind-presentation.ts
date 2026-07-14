import type { FileHistorySnapshotSummary } from "../cli/file-history.js";

/** Plain-text rewind summaries for command hosts; React rendering stays in src/tui. */
export function formatRewindSelector(
  _sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
  options: { maxItems?: number } = {},
): string {
  if (snapshots.length === 0) return "Rewind\nNothing to rewind to yet.";
  const visible = snapshots.slice(-(options.maxItems ?? 7));
  const lines = [
    "Rewind",
    "Choose a message to preview before deciding whether to rewind.",
    "Preview first; confirm happens on the next screen.",
  ];
  for (const snapshot of visible) {
    const prompt = oneLine(snapshot.userPrompt ?? snapshot.messageId);
    const changed = snapshot.changedFileCount ?? snapshot.trackedFileCount;
    lines.push(`  ${truncate(prompt, 72)} · ${snapshot.messageId}`);
    lines.push(
      `    ${changed === 1 ? "1 file changed" : `${changed} files changed`} · ${relativeTime(Date.parse(snapshot.timestamp))}`,
    );
  }
  if (snapshots.length > visible.length)
    lines.push(`… ${snapshots.length - visible.length} earlier messages`);
  lines.push("Up/Down to choose · Enter to preview · Esc to cancel");
  return lines.join("\n");
}

export function formatRewindUsage(
  sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
): string {
  return formatRewindSelector(sessionId, snapshots, { maxItems: 7 });
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}
