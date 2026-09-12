import {
  folderWorkspaceCapabilities,
  type ChangeView,
  type JsonRecord,
  type RunView,
  type SessionContextView,
  type SessionSettingsView,
  type SessionView,
  type WorkspaceCapabilities,
  type WorkspaceMode,
} from "../model.js";
import { booleanValue, isRecord, numberValue, recordArray, stringValue } from "./values.js";

export function parseSessionSettings(value: unknown): SessionSettingsView | undefined {
  if (!isRecord(value) || !isRecord(value.settings)) return undefined;
  const settings = value.settings;
  const modelRouteId = stringValue(settings.modelRouteId);
  const model = stringValue(settings.model);
  const collaborationMode =
    settings.collaborationMode === "plan" || settings.collaborationMode === "agent"
      ? settings.collaborationMode
      : undefined;
  const permissionMode =
    settings.permissionMode === "ask" ||
    settings.permissionMode === "auto" ||
    settings.permissionMode === "full-access"
      ? settings.permissionMode
      : undefined;
  const orchestrationMode =
    settings.orchestrationMode === "default" ||
    settings.orchestrationMode === "graph" ||
    settings.orchestrationMode === "swarm"
      ? settings.orchestrationMode
      : undefined;
  const thinkingEffort = stringValue(settings.thinkingEffort);
  const rawReasoningLevels = settings.reasoningLevels;
  const reasoningLevels = Array.isArray(rawReasoningLevels)
    ? rawReasoningLevels.filter((level): level is string => typeof level === "string")
    : undefined;
  if (
    !modelRouteId ||
    !model ||
    !collaborationMode ||
    !orchestrationMode ||
    !permissionMode ||
    !thinkingEffort ||
    !reasoningLevels ||
    reasoningLevels.length !== (Array.isArray(rawReasoningLevels) ? rawReasoningLevels.length : 0)
  ) {
    return undefined;
  }
  return {
    modelRouteId,
    model,
    collaborationMode,
    orchestrationMode,
    permissionMode,
    thinkingEffort,
    reasoningLevels,
  };
}

export function parseChanges(value: unknown): {
  readonly changes: readonly ChangeView[];
  readonly fingerprint?: string | undefined;
} {
  const result = isRecord(value) ? value : {};
  return {
    changes: recordArray(result.changes).map((item) => ({
      path: stringValue(item.path),
      status:
        item.status === "added" || item.status === "deleted" || item.status === "renamed"
          ? item.status
          : "modified",
      additions: numberValue(item.additions),
      deletions: numberValue(item.deletions),
      patch: stringValue(item.patch) || undefined,
    })),
    fingerprint: stringValue(result.fingerprint) || undefined,
  };
}

export function parseSessionContext(value: unknown): SessionContextView {
  const result = isRecord(value) ? value : {};
  const context = isRecord(result.context) ? result.context : result;
  return {
    routeId: stringValue(context.routeId, "未知路由"),
    estimatedInputTokens: numberValue(context.estimatedInputTokens),
    contextWindowTokens: numberValue(context.contextWindowTokens),
    reservedOutputTokens: numberValue(context.reservedOutputTokens),
    safetyMarginTokens: numberValue(context.safetyMarginTokens),
    inputBudgetTokens: numberValue(context.inputBudgetTokens),
    remainingTokens: numberValue(context.remainingTokens),
    usedPercent: numberValue(context.usedPercent),
    estimation: stringValue(context.estimation, "estimated"),
  };
}

export function parseWorkspaceList(value: unknown): readonly JsonRecord[] {
  if (!isRecord(value)) return [];
  return recordArray(value.workspaces);
}

export function parseSessions(value: unknown, workspacePath: string): readonly SessionView[] {
  const result = isRecord(value) ? value : {};
  return recordArray(result.sessions)
    .map((item, index) => ({
      id: stringValue(item.sessionId ?? item.id, `session-${index}`),
      workspacePath,
      title: stringValue(item.title, "未命名任务"),
      status: item.status === "archived" ? ("archived" as const) : ("active" as const),
      pinned: booleanValue(item.pinned),
      updatedAt: numberValue(item.updatedAt, Date.now()),
      summary: stringValue(item.summary),
    }))
    .sort(compareSessions);
}

/** Direct lookup stays on the conversation; it must never populate the task list. */
export function parseSessionDetail(value: unknown, workspacePath: string): SessionView | undefined {
  const result = isRecord(value) ? value : {};
  if (!isRecord(result.session) || !stringValue(result.session.sessionId ?? result.session.id)) {
    return undefined;
  }
  const session = parseSessions({ sessions: [result.session] }, workspacePath)[0]!;
  const parent = isRecord(result.session.parentSession) ? result.session.parentSession : {};
  const sessionId = stringValue(parent.sessionId);
  const parentWorkspace = stringValue(parent.workspacePath);
  return {
    ...session,
    ...(sessionId && parentWorkspace
      ? {
          parentSession: {
            sessionId,
            workspacePath: parentWorkspace,
            agentName: stringValue(parent.agentName) || undefined,
          },
        }
      : {}),
  };
}

export function compareSessions(left: SessionView, right: SessionView): number {
  return (
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.updatedAt - left.updatedAt
  );
}

export function parseRuns(value: unknown, workspacePath: string): readonly RunView[] {
  const result = isRecord(value) ? value : {};
  return recordArray(result.runs)
    .map((item, index) => ({
      id: stringValue(item.runId ?? item.id, `run-${index}`),
      workspacePath,
      sessionId: stringValue(item.sessionId) || undefined,
      description: stringValue(item.description, "任务运行"),
      status: stringValue(item.status, "unknown"),
      startedAt: numberValue(item.startedAt, Date.now()),
      updatedAt: numberValue(item.updatedAt, Date.now()),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function parseWorkspaceMode(
  value: unknown,
  fallback?: WorkspaceMode,
): WorkspaceMode | undefined {
  return value === "git" || value === "folder" ? value : fallback;
}

export function parseWorkspaceCapabilities(
  value: unknown,
  mode: WorkspaceMode | undefined,
  fallback: WorkspaceCapabilities,
): WorkspaceCapabilities {
  const capabilities = isRecord(value) ? value : {};
  const defaults =
    mode === "git"
      ? {
          foregroundRuns: true,
          fileHistory: true,
          isolatedWorktrees: true,
          branchMerge: true,
        }
      : mode === "folder"
        ? folderWorkspaceCapabilities
        : fallback;
  return {
    foregroundRuns: booleanValue(capabilities.foregroundRuns, defaults.foregroundRuns),
    fileHistory: booleanValue(capabilities.fileHistory, defaults.fileHistory),
    isolatedWorktrees: booleanValue(capabilities.isolatedWorktrees, defaults.isolatedWorktrees),
    branchMerge: booleanValue(capabilities.branchMerge, defaults.branchMerge),
  };
}
