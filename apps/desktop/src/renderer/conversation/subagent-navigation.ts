import type { ConversationView, JsonRecord } from "../model.js";
import { sessionHref, type WorkspaceSessionRef } from "../workspace-session.js";
import type { SubagentItemView } from "./types.js";

/** Configured executors used the child session ID as activityId before explicit metadata existed. */
export function subagentMetadata(data: JsonRecord, itemId: string) {
  const activityId =
    typeof data.activityId === "string" ? data.activityId : itemId.replace(/^subagent:/u, "");
  const legacyChild = /^subagent-[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(activityId)
    ? activityId
    : undefined;
  return {
    childSessionId: typeof data.childSessionId === "string" ? data.childSessionId : legacyChild,
    childWorkspacePath:
      typeof data.childWorkspacePath === "string" ? data.childWorkspacePath : undefined,
    toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : undefined,
    readOnly: data.mode === "explore" ? true : data.mode === "worker" ? false : undefined,
    durationMs:
      typeof data.durationMs === "number" &&
      Number.isFinite(data.durationMs) &&
      data.durationMs >= 0
        ? data.durationMs
        : undefined,
  };
}

export function subagentSessionHref(
  item: SubagentItemView,
  parent: WorkspaceSessionRef,
): string | undefined {
  if (!item.childSessionId) return undefined;
  const href = sessionHref({
    workspacePath: item.childWorkspacePath ?? parent.workspacePath,
    sessionId: item.childSessionId,
  });
  const params = new URLSearchParams({
    parentSession: parent.sessionId,
    parentWorkspace: parent.workspacePath,
    agentName: item.name,
  });
  return `${href}&${params.toString()}`;
}

export function subagentParent(
  search: string,
  child: WorkspaceSessionRef,
  conversations: Readonly<Record<string, ConversationView>>,
) {
  const params = new URLSearchParams(search);
  const parentId = params.get("parentSession");
  const parentWorkspace = params.get("parentWorkspace");
  if (
    parentId &&
    parentWorkspace &&
    (parentId !== child.sessionId || parentWorkspace !== child.workspacePath)
  ) {
    return {
      sessionId: parentId,
      workspacePath: parentWorkspace,
      name: params.get("agentName") ?? undefined,
    };
  }
  for (const conversation of Object.values(conversations)) {
    const item = conversation.items.find(
      (candidate): candidate is SubagentItemView =>
        candidate.kind === "subagent" &&
        candidate.childSessionId === child.sessionId &&
        (candidate.childWorkspacePath ?? conversation.workspacePath) === child.workspacePath,
    );
    if (item)
      return {
        sessionId: conversation.sessionId,
        workspacePath: conversation.workspacePath,
        name: item.name,
      };
  }
  return undefined;
}
