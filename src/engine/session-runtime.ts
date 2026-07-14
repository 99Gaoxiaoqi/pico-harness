import type { CostStatus } from "../observability/pricing.js";
import type { ProviderKind } from "../provider/factory.js";
import type { Message } from "../schema/message.js";
import type { Goal, GoalManagerSnapshot, GoalStatus } from "./goal-manager.js";
import type { SessionIdentity } from "./session-identity.js";
import type { TranscriptEvent } from "../presentation/transcript-event-store.js";

/** runtime_state 记录自身的 schema 版本，与 JSONL meta 版本独立演进。 */
export const SESSION_RUNTIME_STATE_VERSION = 1 as const;

export type PersistedInteractionMode = "default" | "plan" | "auto" | "yolo";

/** 会话恢复时需要覆盖启动默认值的设置。密钥、endpoint 和 tools 不落盘。 */
export interface PersistedSessionSettings {
  /** User-assigned, human-readable session name. Undefined falls back to conversation content. */
  title?: string;
  /** Source session ID when this conversation was forked. */
  forkFrom?: string;
  provider: ProviderKind;
  model: string;
  modelRouteId?: string;
  mode: PersistedInteractionMode;
  prePlanMode?: Exclude<PersistedInteractionMode, "plan">;
  /** Current model reasoning level. Field name is retained for old session compatibility. */
  thinkingEffort: string;
  thinkingEffortExplicit: boolean;
  additionalDirectories: readonly string[];
}

/** Session 维度的累计用量；这些值在 undo/rewind 后也不回退。 */
export interface SessionUsageSnapshot {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  totalCostCNY: number;
  lastCostStatus: CostStatus | null;
  totalProviderCalls: number;
  totalUsageReports: number;
  totalInputReports: number;
  totalCacheReadReports: number;
  totalCacheWriteReports: number;
  totalReasoningReports: number;
  totalEstimatedCostReports: number;
  totalIncludedCostReports: number;
  totalUnknownCostReports: number;
}

/** 每条 runtime_state 只携带发生变化的完整 section。 */
export interface SessionRuntimeStatePatch {
  settings?: PersistedSessionSettings;
  goal?: GoalManagerSnapshot;
  usage?: SessionUsageSnapshot;
}

export interface SessionRuntimeStateSnapshot {
  stateVersion: typeof SESSION_RUNTIME_STATE_VERSION;
  settings?: PersistedSessionSettings;
  goal?: GoalManagerSnapshot;
  usage: SessionUsageSnapshot;
}

/** TUI resume 的单次一致读取结果。 */
export interface SessionHydrationSnapshot {
  schemaVersion: 1;
  /** 快照对应的最后一条 JSONL seq；持久化关闭/无记录时为 null。 */
  persistenceSequence: number | null;
  sessionId: string;
  conversationId: string;
  workDir: string;
  identity: SessionIdentity;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** Session JSONL 中的结构化 Transcript 事件，由共享 projector 重放。 */
  transcriptEvents: readonly TranscriptEvent[];
  runtime: SessionRuntimeStateSnapshot;
}

/** 避免 input 层反向依赖 Session 具体类。 */
export interface SessionRuntimePersistence {
  getRuntimeStateSnapshot(): SessionRuntimeStateSnapshot;
  updateRuntimeState(patch: SessionRuntimeStatePatch): void;
}

export function createEmptyUsageSnapshot(): SessionUsageSnapshot {
  return {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 0,
    totalCostCNY: 0,
    lastCostStatus: null,
    totalProviderCalls: 0,
    totalUsageReports: 0,
    totalInputReports: 0,
    totalCacheReadReports: 0,
    totalCacheWriteReports: 0,
    totalReasoningReports: 0,
    totalEstimatedCostReports: 0,
    totalIncludedCostReports: 0,
    totalUnknownCostReports: 0,
  };
}

export function normalizeSessionRuntimeStatePatch(
  value: unknown,
): SessionRuntimeStatePatch | undefined {
  if (!isRecord(value)) return undefined;

  const patch: SessionRuntimeStatePatch = {};
  let sections = 0;

  if ("settings" in value) {
    const settings = normalizePersistedSessionSettings(value["settings"]);
    if (!settings) return undefined;
    patch.settings = settings;
    sections++;
  }
  if ("goal" in value) {
    const goal = normalizeGoalManagerSnapshot(value["goal"]);
    if (!goal) return undefined;
    patch.goal = goal;
    sections++;
  }
  if ("usage" in value) {
    const usage = normalizeSessionUsageSnapshot(value["usage"]);
    if (!usage) return undefined;
    patch.usage = usage;
    sections++;
  }

  return sections > 0 ? patch : undefined;
}

/** runtime_state 中 Goal section 的唯一入口校验。 */
export function normalizeGoalManagerSnapshot(value: unknown): GoalManagerSnapshot | undefined {
  if (!isRecord(value) || value["stateVersion"] !== 1) return undefined;
  const sequence = value["sequence"];
  const activeGoalId = value["activeGoalId"];
  const candidates = value["goals"];
  if (!isNonNegativeInteger(sequence) || !Array.isArray(candidates)) return undefined;
  if (activeGoalId !== null && typeof activeGoalId !== "string") return undefined;

  const goals: Goal[] = [];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!isGoal(candidate) || ids.has(candidate.id)) return undefined;
    const generatedSequence = parseGeneratedGoalSequence(candidate.id);
    if (generatedSequence !== undefined && generatedSequence > sequence) return undefined;
    ids.add(candidate.id);
    goals.push(structuredClone(candidate));
  }
  const activeGoals = goals.filter((goal) => goal.status === "active");
  if (activeGoals.length > 1) return undefined;
  if (activeGoalId === null ? activeGoals.length !== 0 : activeGoals[0]?.id !== activeGoalId) {
    return undefined;
  }
  return { stateVersion: 1, sequence, activeGoalId, goals };
}

function normalizePersistedSessionSettings(value: unknown): PersistedSessionSettings | undefined {
  if (!isRecord(value)) return undefined;
  const provider = value["provider"];
  const model = value["model"];
  const mode = value["mode"];
  const prePlanMode = value["prePlanMode"];
  const thinkingEffort = value["thinkingEffort"];
  const thinkingEffortExplicit = value["thinkingEffortExplicit"];
  const additionalDirectories = value["additionalDirectories"];
  const modelRouteId = value["modelRouteId"];
  const title = value["title"];
  const forkFrom = value["forkFrom"];

  if (!isProviderKind(provider) || typeof model !== "string" || model.trim().length === 0) {
    return undefined;
  }
  if (!isInteractionMode(mode) || !isReasoningLevel(thinkingEffort)) return undefined;
  if (typeof thinkingEffortExplicit !== "boolean") return undefined;
  if (
    !Array.isArray(additionalDirectories) ||
    !additionalDirectories.every((directory) => typeof directory === "string")
  ) {
    return undefined;
  }
  if (modelRouteId !== undefined && typeof modelRouteId !== "string") return undefined;
  if (title !== undefined && !isSessionTitle(title)) return undefined;
  if (forkFrom !== undefined && !isNonBlankString(forkFrom)) return undefined;
  if (prePlanMode !== undefined && !isNonPlanMode(prePlanMode)) return undefined;
  if (mode !== "plan" && prePlanMode !== undefined) return undefined;

  return {
    ...(title !== undefined ? { title } : {}),
    ...(forkFrom !== undefined ? { forkFrom } : {}),
    provider,
    model,
    ...(modelRouteId !== undefined ? { modelRouteId } : {}),
    mode,
    ...(prePlanMode !== undefined ? { prePlanMode } : {}),
    thinkingEffort,
    thinkingEffortExplicit,
    additionalDirectories: [...new Set(additionalDirectories)],
  };
}

function isSessionTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSessionUsageSnapshot(value: unknown): SessionUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const tokenKeys = [
    "totalPromptTokens",
    "totalCompletionTokens",
    "totalInputTokens",
    "totalCacheReadTokens",
    "totalCacheWriteTokens",
    "totalReasoningTokens",
  ] as const;
  for (const key of tokenKeys) {
    if (!isNonNegativeInteger(value[key])) return undefined;
  }
  if (!isNonNegativeFiniteNumber(value["totalCostCNY"])) return undefined;
  const lastCostStatus = value["lastCostStatus"];
  if (lastCostStatus !== null && !isCostStatus(lastCostStatus)) return undefined;

  const legacyHadUsage =
    (value["totalPromptTokens"] as number) > 0 || (value["totalCompletionTokens"] as number) > 0;
  const reportKeys = [
    "totalProviderCalls",
    "totalUsageReports",
    "totalInputReports",
    "totalCacheReadReports",
    "totalCacheWriteReports",
    "totalReasoningReports",
    "totalEstimatedCostReports",
    "totalIncludedCostReports",
    "totalUnknownCostReports",
  ] as const;
  for (const key of reportKeys) {
    if (value[key] !== undefined && !isNonNegativeInteger(value[key])) return undefined;
  }

  return {
    totalPromptTokens: value["totalPromptTokens"] as number,
    totalCompletionTokens: value["totalCompletionTokens"] as number,
    totalInputTokens: value["totalInputTokens"] as number,
    totalCacheReadTokens: value["totalCacheReadTokens"] as number,
    totalCacheWriteTokens: value["totalCacheWriteTokens"] as number,
    totalReasoningTokens: value["totalReasoningTokens"] as number,
    totalCostCNY: value["totalCostCNY"] as number,
    lastCostStatus,
    totalProviderCalls:
      (value["totalProviderCalls"] as number | undefined) ?? (legacyHadUsage ? 1 : 0),
    totalUsageReports:
      (value["totalUsageReports"] as number | undefined) ?? (legacyHadUsage ? 1 : 0),
    totalInputReports: (value["totalInputReports"] as number | undefined) ?? 0,
    totalCacheReadReports: (value["totalCacheReadReports"] as number | undefined) ?? 0,
    totalCacheWriteReports: (value["totalCacheWriteReports"] as number | undefined) ?? 0,
    totalReasoningReports: (value["totalReasoningReports"] as number | undefined) ?? 0,
    totalEstimatedCostReports:
      (value["totalEstimatedCostReports"] as number | undefined) ??
      (lastCostStatus === "estimated" && legacyHadUsage ? 1 : 0),
    totalIncludedCostReports:
      (value["totalIncludedCostReports"] as number | undefined) ??
      (lastCostStatus === "included" && legacyHadUsage ? 1 : 0),
    totalUnknownCostReports:
      (value["totalUnknownCostReports"] as number | undefined) ??
      (lastCostStatus === "unknown" && legacyHadUsage ? 1 : 0),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoal(value: unknown): value is Goal {
  if (!isRecord(value) || !isRecord(value["budgetUsage"])) return false;
  const usage = value["budgetUsage"];
  return (
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["description"] === "string" &&
    isGoalStatus(value["status"]) &&
    isNonNegativeFiniteNumber(value["createdAt"]) &&
    isNonNegativeInteger(usage["turns"]) &&
    isNonNegativeInteger(usage["tokens"]) &&
    isNonNegativeFiniteNumber(usage["costCNY"]) &&
    isNonNegativeFiniteNumber(usage["startedAt"]) &&
    isOptionalString(value["progress"]) &&
    isOptionalString(value["blockedReason"]) &&
    isOptionalBudgetConfig(value["budgetConfig"])
  );
}

function isOptionalBudgetConfig(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    isOptionalNonNegativeInteger(value["maxTurns"]) &&
    isOptionalNonNegativeInteger(value["maxTokens"]) &&
    isOptionalNonNegativeFiniteNumber(value["maxCostCNY"]) &&
    isOptionalNonNegativeInteger(value["maxWallClockMs"])
  );
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "blocked" || value === "complete";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalNonNegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeFiniteNumber(value);
}

function parseGeneratedGoalSequence(id: string): number | undefined {
  const match = /^goal-(\d+)$/u.exec(id);
  if (!match?.[1]) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function isProviderKind(value: unknown): value is ProviderKind {
  return value === "openai" || value === "claude" || value === "gemini";
}

function isInteractionMode(value: unknown): value is PersistedInteractionMode {
  return value === "default" || value === "plan" || value === "auto" || value === "yolo";
}

function isNonPlanMode(value: unknown): value is Exclude<PersistedInteractionMode, "plan"> {
  return value === "default" || value === "auto" || value === "yolo";
}

function isReasoningLevel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCostStatus(value: unknown): value is CostStatus {
  return value === "estimated" || value === "included" || value === "unknown";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
