import type { RuntimeGoalSnapshot, RuntimeParams, RuntimeResult } from "@pico/protocol";
import type { WorkspaceSessionRef } from "../workspace-session.js";

type GoalMethod = "goal.get" | "goal.control";
export type GoalControlInput = Omit<RuntimeParams<"goal.control">, "workspacePath" | "sessionId">;
export type GoalRequest = <Method extends GoalMethod>(
  method: Method,
  params: RuntimeParams<Method>,
) => Promise<RuntimeResult<Method>>;

/** A stale click refreshes once and never replays a mutation against a new Goal. */
export async function controlGoalRequest(
  request: GoalRequest,
  ref: WorkspaceSessionRef,
  input: GoalControlInput,
  onSnapshot: (snapshot: RuntimeGoalSnapshot | null) => void,
): Promise<boolean> {
  try {
    const result = await request("goal.control", { ...ref, ...input });
    onSnapshot(result.goal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "CONFLICT") {
      const latest = await request("goal.get", ref);
      onSnapshot(latest.goal);
      return false;
    }
    throw error;
  }
}

const goalStatusLabels: Readonly<Record<string, string>> = {
  active: "执行中",
  waiting: "等待条件",
  paused: "已暂停",
  achieved: "已达成",
  impossible: "无法完成",
  stalled: "进展停滞",
  budget_limited: "已达 token 限额",
  max_iterations: "已达迭代上限",
  cleared: "已清除",
};

export function goalStatusLabel(status: unknown): string | undefined {
  return typeof status === "string" ? goalStatusLabels[status] : undefined;
}
