import type { CostStatus } from "../observability/pricing.js";
import type { ProviderKind } from "../provider/factory.js";
import type { Message } from "../schema/message.js";
import type { Goal, GoalManagerSnapshot, GoalStatus } from "./goal-manager.js";
import type { SessionIdentity } from "./session-identity.js";
import type { DurableTranscriptEvent } from "../presentation/transcript-event-store.js";
import type { ToolResultEnvelope } from "./tool-result-contract.js";

/** Session runtime-state event schema version. */
export const SESSION_RUNTIME_STATE_VERSION = 3 as const;
export const LEGACY_SESSION_RUNTIME_STATE_VERSION = 2 as const;
export type SessionRuntimeStateVersion =
  | typeof LEGACY_SESSION_RUNTIME_STATE_VERSION
  | typeof SESSION_RUNTIME_STATE_VERSION;

export type PersistedInteractionMode = "default" | "plan" | "auto" | "yolo";

/** 会话恢复时需要覆盖启动默认值的设置。密钥、endpoint 和 tools 不落盘。 */
export interface PersistedSessionSettings {
  /** User-assigned, human-readable session name. Undefined falls back to conversation content. */
  title?: string;
  /** Source session ID when this conversation was forked. */
  forkFrom?: string;
  provider: ProviderKind;
  model: string;
  modelRouteId: string;
  mode: PersistedInteractionMode;
  prePlanMode?: Exclude<PersistedInteractionMode, "plan">;
  /** Canonical v3 interaction axis. Legacy readers may continue using mode. */
  collaborationMode?: "agent" | "plan";
  /** Canonical v3 permission axis. */
  permissionMode?: Exclude<PersistedInteractionMode, "plan">;
  /** Current model reasoning level. */
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
  /** Calls whose provider-reported cache read token count was greater than zero. */
  totalCacheHitCalls: number | null;
  totalCacheWriteReports: number;
  totalReasoningReports: number;
  totalEstimatedCostReports: number;
  totalIncludedCostReports: number;
  totalUnknownCostReports: number;
}

export interface PersistedPromptCacheState {
  stateVersion: 1;
  /** Opaque digest of the first stable conversation anchor; prompt text is never persisted. */
  shardSeed: string;
  /** First per-route sharding decision, including false, so an existing Session never changes key. */
  routeShardDecisions?: Readonly<Record<string, boolean>>;
}

/** 每条 runtime_state 只携带发生变化的完整 section。 */
export interface SessionRuntimeStatePatch {
  settings?: PersistedSessionSettings;
  goal?: GoalManagerSnapshot;
  promptCache?: PersistedPromptCacheState;
}

export type SessionRuntimeStateWritePatch = SessionRuntimeStatePatch;

export interface SessionRuntimeStateSnapshot {
  stateVersion: SessionRuntimeStateVersion;
  settings?: PersistedSessionSettings;
  goal?: GoalManagerSnapshot;
  promptCache?: PersistedPromptCacheState;
  usage: SessionUsageSnapshot;
}

/** TUI resume 的单次一致读取结果。 */
export interface SessionHydrationSnapshot {
  schemaVersion: 1;
  /** 快照对应的最后一条 RuntimeEvent sequence；持久化关闭/无记录时为 null。 */
  persistenceSequence: number | null;
  sessionId: string;
  conversationId: string;
  workDir: string;
  identity: SessionIdentity;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** Effective message positions in the canonical RuntimeEvent sequence. */
  messageSequences: readonly number[];
  /** RuntimeEvent 账本中的结构化 Transcript 事件，由共享 projector 重放。 */
  transcriptEvents: readonly DurableTranscriptEvent[];
  /** RuntimeEvent sequence for each transcriptEvents entry, aligned by index. */
  transcriptEventSequences: readonly number[];
  /** Active-branch ToolResult facts, already reduced to the bounded host envelope. */
  toolResults: readonly SessionHydrationToolResult[];
  runtime: SessionRuntimeStateSnapshot;
}

export interface SessionHydrationToolResult {
  readonly sequence: number;
  readonly eventId: string;
  readonly envelope: ToolResultEnvelope;
}

/** 避免 input 层反向依赖 Session 具体类。 */
export interface SessionRuntimePersistence {
  getRuntimeStateSnapshot(): SessionRuntimeStateSnapshot;
  updateRuntimeState(patch: SessionRuntimeStateWritePatch): void;
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
    totalCacheHitCalls: 0,
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
  if (!isRecord(value) || !hasOnlyKeys(value, ["settings", "goal", "promptCache"])) {
    return undefined;
  }

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
  if ("promptCache" in value) {
    const promptCache = normalizePersistedPromptCacheState(value["promptCache"]);
    if (!promptCache) return undefined;
    patch.promptCache = promptCache;
    sections++;
  }
  return sections > 0 ? patch : undefined;
}

export function normalizeSessionRuntimeStateWritePatch(
  value: unknown,
): SessionRuntimeStateWritePatch | undefined {
  const normalized = normalizeSessionRuntimeStatePatch(value);
  if (!normalized) return undefined;
  if (!normalized.settings) return normalized;
  const { mode: _mode, prePlanMode: _prePlanMode, ...settings } = normalized.settings;
  return { ...normalized, settings } as SessionRuntimeStateWritePatch;
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
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "title",
      "forkFrom",
      "provider",
      "model",
      "modelRouteId",
      "mode",
      "prePlanMode",
      "collaborationMode",
      "permissionMode",
      "thinkingEffort",
      "thinkingEffortExplicit",
      "additionalDirectories",
    ])
  ) {
    return undefined;
  }
  const provider = value["provider"];
  const model = value["model"];
  const mode = value["mode"];
  const prePlanMode = value["prePlanMode"];
  const collaborationMode = value["collaborationMode"];
  const permissionMode = value["permissionMode"];
  const thinkingEffort = value["thinkingEffort"];
  const thinkingEffortExplicit = value["thinkingEffortExplicit"];
  const additionalDirectories = value["additionalDirectories"];
  const modelRouteId = value["modelRouteId"];
  const title = value["title"];
  const forkFrom = value["forkFrom"];

  if (!isProviderKind(provider) || typeof model !== "string" || model.trim().length === 0) {
    return undefined;
  }
  const hasLegacyMode = isInteractionMode(mode);
  const hasSplitMode =
    (collaborationMode === "agent" || collaborationMode === "plan") &&
    isNonPlanMode(permissionMode);
  if ((!hasLegacyMode && !hasSplitMode) || !isReasoningLevel(thinkingEffort)) return undefined;
  if (typeof thinkingEffortExplicit !== "boolean") return undefined;
  if (
    !Array.isArray(additionalDirectories) ||
    !additionalDirectories.every((directory) => typeof directory === "string")
  ) {
    return undefined;
  }
  if (!isModelRouteId(modelRouteId)) return undefined;
  if (title !== undefined && !isSessionTitle(title)) return undefined;
  if (forkFrom !== undefined && !isNonBlankString(forkFrom)) return undefined;
  if (prePlanMode !== undefined && !isNonPlanMode(prePlanMode)) return undefined;
  if (hasLegacyMode && mode !== "plan" && prePlanMode !== undefined) return undefined;
  const canonicalCollaborationMode: "agent" | "plan" = hasSplitMode
    ? (collaborationMode as "agent" | "plan")
    : mode === "plan" ? "plan" : "agent";
  const canonicalPermissionMode = hasSplitMode
    ? (permissionMode as Exclude<PersistedInteractionMode, "plan">)
    : mode === "plan"
      ? (prePlanMode ?? "default")
      : (mode as Exclude<PersistedInteractionMode, "plan">);
  const compatibilityMode: PersistedInteractionMode =
    canonicalCollaborationMode === "plan" ? "plan" : canonicalPermissionMode;

  return {
    ...(title !== undefined ? { title } : {}),
    ...(forkFrom !== undefined ? { forkFrom } : {}),
    provider,
    model,
    modelRouteId,
    mode: compatibilityMode,
    ...(canonicalCollaborationMode === "plan" ? { prePlanMode: canonicalPermissionMode } : {}),
    collaborationMode: canonicalCollaborationMode,
    permissionMode: canonicalPermissionMode,
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

function isModelRouteId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && /^[^/\s]+\/\S.*$/u.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function normalizeSessionUsageSnapshot(value: unknown): SessionUsageSnapshot | undefined {
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
    if (!isNonNegativeInteger(value[key])) return undefined;
  }
  const totalCacheHitCalls = value["totalCacheHitCalls"] ?? null;
  if (totalCacheHitCalls !== null && !isNonNegativeInteger(totalCacheHitCalls)) return undefined;

  return {
    totalPromptTokens: value["totalPromptTokens"] as number,
    totalCompletionTokens: value["totalCompletionTokens"] as number,
    totalInputTokens: value["totalInputTokens"] as number,
    totalCacheReadTokens: value["totalCacheReadTokens"] as number,
    totalCacheWriteTokens: value["totalCacheWriteTokens"] as number,
    totalReasoningTokens: value["totalReasoningTokens"] as number,
    totalCostCNY: value["totalCostCNY"] as number,
    lastCostStatus,
    totalProviderCalls: value["totalProviderCalls"] as number,
    totalUsageReports: value["totalUsageReports"] as number,
    totalInputReports: value["totalInputReports"] as number,
    totalCacheReadReports: value["totalCacheReadReports"] as number,
    totalCacheHitCalls,
    totalCacheWriteReports: value["totalCacheWriteReports"] as number,
    totalReasoningReports: value["totalReasoningReports"] as number,
    totalEstimatedCostReports: value["totalEstimatedCostReports"] as number,
    totalIncludedCostReports: value["totalIncludedCostReports"] as number,
    totalUnknownCostReports: value["totalUnknownCostReports"] as number,
  };
}

function normalizePersistedPromptCacheState(value: unknown): PersistedPromptCacheState | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "stateVersion",
      "shardSeed",
      "routeShardDecisions",
      "activeRouteDigests",
      "routeCallCounts",
    ]) ||
    value["stateVersion"] !== 1 ||
    typeof value["shardSeed"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value["shardSeed"])
  ) {
    return undefined;
  }
  // Early P3 builds persisted per-session route counters. Route RPM now lives in a bounded
  // process-level window, but accepting and discarding this legacy field keeps recovery safe.
  const legacyCounts = value["routeCallCounts"];
  if (legacyCounts !== undefined) {
    if (!isRecord(legacyCounts) || Object.keys(legacyCounts).length > 64) return undefined;
    for (const [key, count] of Object.entries(legacyCounts)) {
      if (!/^[a-f0-9]{64}$/u.test(key) || !isNonNegativeInteger(count)) return undefined;
    }
  }
  const activeRouteDigests = value["activeRouteDigests"];
  if (
    activeRouteDigests !== undefined &&
    (!Array.isArray(activeRouteDigests) ||
      activeRouteDigests.length > 64 ||
      new Set(activeRouteDigests).size !== activeRouteDigests.length ||
      activeRouteDigests.some(
        (digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest),
      ))
  ) {
    return undefined;
  }
  const rawRouteShardDecisions = value["routeShardDecisions"];
  if (
    rawRouteShardDecisions !== undefined &&
    (!isRecord(rawRouteShardDecisions) ||
      Object.keys(rawRouteShardDecisions).length > 64 ||
      Object.entries(rawRouteShardDecisions).some(
        ([digest, active]) => !/^[a-f0-9]{64}$/u.test(digest) || typeof active !== "boolean",
      ))
  ) {
    return undefined;
  }
  const routeShardDecisions: Record<string, boolean> = {
    ...(isRecord(rawRouteShardDecisions)
      ? (rawRouteShardDecisions as Record<string, boolean>)
      : {}),
  };
  if (Array.isArray(activeRouteDigests)) {
    for (const digest of activeRouteDigests as string[]) routeShardDecisions[digest] = true;
  }
  return {
    stateVersion: 1,
    shardSeed: value["shardSeed"],
    ...(Object.keys(routeShardDecisions).length > 0 ? { routeShardDecisions } : {}),
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
    isOptionalBudgetConfig(value["budgetConfig"]) &&
    isOptionalNonNegativeInteger(value["consecutiveNoProgress"]) &&
    isOptionalString(value["lastToolCallHash"])
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
  return value === "openai" || value === "claude";
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
