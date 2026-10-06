import { conversationItemKey } from "./items.js";
import type { ConversationItemView, RunBoundaryItemView } from "./types.js";

export interface TranscriptActiveRun {
  readonly id: string;
  readonly status: string;
}

export interface ConversationProcessView {
  readonly kind: "process";
  readonly key: string;
  readonly items: readonly ConversationItemView[];
  readonly runId?: string | undefined;
  readonly activeStatus?: string | undefined;
  readonly boundary?: RunBoundaryItemView | undefined;
}

/** Presentation only: keep final replies and actionable records outside the work log. */
export function foldConversationProcess(
  items: readonly ConversationItemView[],
  activeRun?: TranscriptActiveRun,
): readonly (ConversationItemView | ConversationProcessView)[] {
  const folded: (ConversationItemView | ConversationProcessView)[] = [];
  const terminalRuns = new Set(
    items.flatMap((item) =>
      item.kind === "runBoundary" && item.status !== "started" && item.runId ? [item.runId] : [],
    ),
  );
  let buffer: ConversationItemView[] = [];
  // Host Run IDs and canonical execution IDs are different namespaces. Explicit
  // Host boundaries own their interval, including live overlays during hydration.
  let hostRunId: string | undefined;
  let executionRunId: string | undefined;
  let anchor = "start";
  const flush = (boundary?: RunBoundaryItemView): boolean => {
    const candidateIndex = buffer.findLastIndex((item) => item.kind !== "thinking");
    const candidate = buffer[candidateIndex];
    const answer = candidate?.kind === "assistantMessage" ? candidate : undefined;
    if (answer) buffer.splice(candidateIndex, 1);
    const hasProcess = buffer.length > 0;
    if (hasProcess) {
      const runId = hostRunId ?? executionRunId ?? boundary?.runId;
      const active =
        !boundary &&
        activeRun !== undefined &&
        !terminalRuns.has(activeRun.id) &&
        (runId === activeRun.id ||
          (!hostRunId && buffer.some((item) => "runId" in item && item.runId === activeRun.id)));
      folded.push({
        kind: "process",
        key: `process:${runId ?? "context"}:${anchor}`,
        items: buffer,
        runId,
        activeStatus: active ? activeRun.status : undefined,
        boundary,
      });
    }
    if (answer) folded.push(answer);
    buffer = [];
    return hasProcess;
  };

  for (const item of items) {
    if (item.kind === "assistantMessage" && item.runId?.startsWith("external-import:")) {
      flush();
      folded.push(item);
      anchor = conversationItemKey(item);
      continue;
    }
    if (item.kind === "runBoundary") {
      if (item.status === "started") {
        if (item.runId !== hostRunId) {
          flush();
          hostRunId = item.runId;
          executionRunId = undefined;
          anchor = "start";
        }
      } else {
        const hasProcess = flush(item);
        // Keep failures, interruption details and any custom recovery actions visible.
        if (!hasProcess || item.status !== "completed" || item.detail) folded.push(item);
        hostRunId = undefined;
        executionRunId = undefined;
        anchor = conversationItemKey(item);
      }
      continue;
    }
    if (
      item.kind === "thinking" ||
      item.kind === "tool" ||
      item.kind === "assistantMessage" ||
      item.kind === "skill" ||
      item.kind === "subagent"
    ) {
      const runId = "runId" in item ? item.runId : undefined;
      if (!hostRunId && runId && executionRunId && runId !== executionRunId) {
        flush();
        anchor = "start";
      }
      if (runId) executionRunId = runId;
      buffer.push(item);
      continue;
    }
    // User steering, approvals, prompts, plans and other control records are boundaries.
    flush();
    folded.push(item);
    anchor = conversationItemKey(item);
    // A steering message can arrive inside the same Host Run. Its own anchor
    // splits the disclosure without dropping the still-live execution scope.
  }
  flush();
  return folded;
}
