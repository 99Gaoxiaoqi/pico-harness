import type { RuntimeUserDefaults } from "@pico/protocol";
import type { RuntimeStore, RuntimeActions } from "../runtime.js";
import { workspaceSessionKey, type WorkspaceSessionRef } from "../workspace-session.js";

/** Shared by composer controls and slash actions, including Plan approval transitions. */
export async function applyConversationSettings(
  runtime: RuntimeStore,
  ref: WorkspaceSessionRef | undefined,
  initial: RuntimeUserDefaults,
  patch: Parameters<RuntimeActions["updateSessionSettings"]>[1],
  updateInitial?: (patch: RuntimeUserDefaults) => void,
): Promise<boolean> {
  const settings = ref ? runtime.data.conversations[workspaceSessionKey(ref)]?.settings : initial;
  if (
    (patch.orchestrationMode === "graph" || patch.orchestrationMode === "swarm") &&
    (patch.collaborationMode ?? settings?.collaborationMode) === "research"
  )
    throw new Error("研究模式不启动 Graph/Swarm。请完成研究后新建实施任务。");
  const next =
    patch.collaborationMode === "research"
      ? { ...patch, orchestrationMode: "default" as const }
      : patch;
  if (!ref) {
    if (!updateInitial) return false;
    updateInitial(next);
    return true;
  }
  const approval =
    runtime.data.workspacePath === ref.workspacePath
      ? runtime.data.approvals.find(
          (item) => item.kind === "plan" && item.sessionId === ref.sessionId,
        )
      : undefined;
  if (
    settings?.collaborationMode === "plan" &&
    next.collaborationMode &&
    next.collaborationMode !== "plan" &&
    approval?.kind === "plan"
  ) {
    if (!window.confirm("当前计划仍待审批。退出 Plan 将拒绝并放弃这份计划，是否继续？"))
      return false;
    const accepted = await runtime.actions.respondPlan({
      workspacePath: ref.workspacePath,
      sessionId: ref.sessionId,
      planId: approval.planId,
      action: "reject_exit",
      expectedRevision: approval.expectedRevision,
      expectedSessionSequence: approval.expectedSessionSequence,
      controlEpoch: approval.controlEpoch,
      feedback: "用户退出 Plan。",
    });
    if (!accepted) return false;
    if (next.collaborationMode === "agent" && Object.keys(next).length === 1) return true;
  }
  return runtime.actions.updateSessionSettings(ref, next);
}
