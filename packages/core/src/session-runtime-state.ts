import { decodeExecutionBoundary, type ExecutionBoundary } from "./permission-profile.js";

/** Session runtime-state event schema version. */
export const SESSION_RUNTIME_STATE_VERSION = 3 as const;
export type SessionRuntimeStateVersion = typeof SESSION_RUNTIME_STATE_VERSION;

export type PersistedCollaborationMode = "agent" | "plan" | "research";
export type PersistedPermissionMode = "ask" | "auto" | "full-access";
export type PersistedProviderKind = "openai" | "claude" | "responses";
export type PersistedCostStatus = "estimated" | "included" | "unknown";

export type PersistedGoalStatus =
  | "active"
  | "waiting"
  | "paused"
  | "achieved"
  | "impossible"
  | "stalled"
  | "budget_limited"
  | "max_iterations"
  | "cleared";

export interface PersistedGoalEvaluation {
  met?: boolean;
  impossible?: boolean;
  progress?: boolean;
  waiting?: boolean;
  evaluatorFailed?: boolean;
  reason: string;
  at: number;
}

export interface PersistedGoalState {
  id: string;
  revision: number;
  condition: string;
  status: PersistedGoalStatus;
  createdAt: number;
  maxIterations: number;
  blockCap: number;
  tokenBudget?: number;
  iterations: number;
  tokensAtStart: number;
  tokensNow: number;
  tokensBaselinePending: boolean;
  consecutiveNoProgress: number;
  lastReason?: string;
  lastEvaluation?: PersistedGoalEvaluation;
  armedAt?: number;
  pausedAt?: number;
  achievedAt?: number;
}

export interface PersistedGoalContinuationIntent {
  goalId: string;
  revision: number;
  generation: number;
  triggeringRunId?: string;
  prompt: string;
  createdAt: number;
  runId: string;
  daemonRunId: string;
  turnId: string;
  invocationId: string;
  runStartedEventId: string;
  runStartedAt: number;
}

export interface PersistedGoalExecutionRef extends PersistedGoalContinuationIntent {
  origin: "user" | "goal";
  started?: boolean;
}

export interface PersistedGoalCoordinator {
  pendingContinuation: PersistedGoalContinuationIntent | null;
  currentExecution: PersistedGoalExecutionRef | null;
  lastSettledRunId?: string;
  workTokens: number;
  accountedRunIds: string[];
}

export interface PersistedGoalControlLease {
  goalId: string;
  generation: number;
}

export interface PersistedGoalManagerSnapshot {
  stateVersion: 3;
  currentGoal: PersistedGoalState | null;
  controlLease: PersistedGoalControlLease | null;
  coordinator: PersistedGoalCoordinator;
}

/** 会话恢复时需要覆盖启动默认值的设置。密钥、endpoint 和 tools 不落盘。 */
export interface PersistedSessionSettings {
  /** User-assigned, human-readable session name. Undefined falls back to conversation content. */
  title?: string;
  /** Source session ID when this conversation was forked. */
  forkFrom?: string;
  /** Ephemeral Workbar side conversation; hidden from the ordinary session catalog. */
  sideConversation?: boolean;
  provider: PersistedProviderKind;
  model: string;
  modelRouteId: string;
  /** Canonical collaboration axis. */
  collaborationMode: PersistedCollaborationMode;
  /** Canonical permission axis. */
  permissionMode: PersistedPermissionMode;
  /** Canonical orchestration axis: "default" = direct execution, "graph" / "swarm" = coordinated execution. */
  orchestrationMode: "default" | "graph" | "swarm";
  /** Current model reasoning level. */
  thinkingEffort: string;
  thinkingEffortExplicit: boolean;
  additionalDirectories: readonly string[];
}

/** Canonical v3 wire settings. */
export type PersistedSessionSettingsWrite = PersistedSessionSettings;

/** Session 维度的累计用量；这些值在 undo/rewind 后也不回退。 */
export interface SessionUsageSnapshot {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  totalCostCNY: number;
  lastCostStatus: PersistedCostStatus | null;
  totalProviderCalls: number;
  totalUsageReports: number;
  totalInputReports: number;
  totalCacheReadReports: number;
  /** Calls whose provider-reported cache read token count was greater than zero. */
  totalCacheHitCalls: number;
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
  goal?: PersistedGoalManagerSnapshot;
  promptCache?: PersistedPromptCacheState;
  boundary?: ExecutionBoundary;
}

export interface SessionRuntimeStateWritePatch {
  settings?: PersistedSessionSettingsWrite;
  goal?: PersistedGoalManagerSnapshot;
  promptCache?: PersistedPromptCacheState;
  boundary?: ExecutionBoundary;
}

export interface SessionRuntimeStateSnapshot {
  stateVersion: SessionRuntimeStateVersion;
  settings?: PersistedSessionSettings;
  goal?: PersistedGoalManagerSnapshot;
  promptCache?: PersistedPromptCacheState;
  boundary?: ExecutionBoundary;
  usage: SessionUsageSnapshot;
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

/** Strict v3 RuntimeEvent decoder. */
export function normalizeSessionRuntimeStatePatch(
  value: unknown,
): SessionRuntimeStatePatch | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["settings", "goal", "promptCache", "boundary"])) {
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
  if ("boundary" in value) {
    const boundary = normalizeExecutionBoundary(value["boundary"]);
    if (!boundary) return undefined;
    patch.boundary = boundary;
    sections++;
  }
  return sections > 0 ? patch : undefined;
}

export function normalizeSessionRuntimeStateWritePatch(
  value: unknown,
): SessionRuntimeStateWritePatch | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["settings", "goal", "promptCache", "boundary"])) {
    return undefined;
  }

  const patch: SessionRuntimeStateWritePatch = {};
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
  if ("boundary" in value) {
    const boundary = normalizeExecutionBoundary(value["boundary"]);
    if (!boundary) return undefined;
    patch.boundary = boundary;
    sections++;
  }
  return sections > 0 ? patch : undefined;
}

function normalizeExecutionBoundary(value: unknown): ExecutionBoundary | undefined {
  try {
    return decodeExecutionBoundary(value);
  } catch {
    return undefined;
  }
}

/** runtime_state 中 Goal section 的唯一入口校验。 */
export function normalizeGoalManagerSnapshot(
  value: unknown,
): PersistedGoalManagerSnapshot | undefined {
  if (
    !isRecord(value) ||
    value["stateVersion"] !== 3 ||
    !(value["currentGoal"] === null || isGoal(value["currentGoal"])) ||
    !(value["controlLease"] === null || isGoalControlLease(value["controlLease"])) ||
    !isGoalCoordinator(value["coordinator"])
  ) {
    return undefined;
  }
  const currentGoal = value["currentGoal"] === null ? null : structuredClone(value["currentGoal"]);
  const controlLease = value["controlLease"] === null ? null : structuredClone(value["controlLease"]);
  const coordinator = structuredClone(value["coordinator"]);
  if (
    (controlLease !== null && controlLease.goalId !== currentGoal?.id) ||
    (coordinator.currentExecution !== null &&
      coordinator.currentExecution.goalId !== currentGoal?.id) ||
    (coordinator.pendingContinuation !== null &&
      coordinator.pendingContinuation.goalId !== currentGoal?.id)
  ) {
    return undefined;
  }
  return { stateVersion: 3, currentGoal, controlLease, coordinator };
}

function normalizePersistedSessionSettings(value: unknown): PersistedSessionSettings | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "title",
      "forkFrom",
      "sideConversation",
      "provider",
      "model",
      "modelRouteId",
      "collaborationMode",
      "permissionMode",
      "orchestrationMode",
      "thinkingEffort",
      "thinkingEffortExplicit",
      "additionalDirectories",
    ])
  ) {
    return undefined;
  }
  const provider = value["provider"];
  const model = value["model"];
  const collaborationMode = value["collaborationMode"];
  const permissionMode = value["permissionMode"];
  const orchestrationMode = value["orchestrationMode"];
  const thinkingEffort = value["thinkingEffort"];
  const thinkingEffortExplicit = value["thinkingEffortExplicit"];
  const additionalDirectories = value["additionalDirectories"];
  const modelRouteId = value["modelRouteId"];
  const title = value["title"];
  const forkFrom = value["forkFrom"];
  const sideConversation = value["sideConversation"];

  if (!isProviderKind(provider) || typeof model !== "string" || model.trim().length === 0) {
    return undefined;
  }
  if (
    collaborationMode !== "agent" &&
    collaborationMode !== "plan" &&
    collaborationMode !== "research"
  ) {
    return undefined;
  }
  if (!isNonPlanMode(permissionMode)) return undefined;
  if (!isReasoningLevel(thinkingEffort)) return undefined;
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
  if (sideConversation !== undefined && typeof sideConversation !== "boolean") return undefined;
  if (
    orchestrationMode !== "default" &&
    orchestrationMode !== "graph" &&
    orchestrationMode !== "swarm"
  ) {
    return undefined;
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(forkFrom !== undefined ? { forkFrom } : {}),
    ...(sideConversation === true ? { sideConversation: true } : {}),
    provider,
    model,
    modelRouteId,
    collaborationMode,
    permissionMode,
    orchestrationMode,
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
  const totalCacheHitCalls = value["totalCacheHitCalls"];
  if (!isNonNegativeInteger(totalCacheHitCalls)) return undefined;

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
    !hasOnlyKeys(value, ["stateVersion", "shardSeed", "routeShardDecisions"]) ||
    value["stateVersion"] !== 1 ||
    typeof value["shardSeed"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value["shardSeed"])
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
  const routeShardDecisions: Record<string, boolean> = isRecord(rawRouteShardDecisions)
    ? { ...(rawRouteShardDecisions as Record<string, boolean>) }
    : {};
  return {
    stateVersion: 1,
    shardSeed: value["shardSeed"],
    ...(Object.keys(routeShardDecisions).length > 0 ? { routeShardDecisions } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoal(value: unknown): value is PersistedGoalState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "revision",
      "condition",
      "status",
      "createdAt",
      "maxIterations",
      "blockCap",
      "tokenBudget",
      "iterations",
      "tokensAtStart",
      "tokensNow",
      "tokensBaselinePending",
      "consecutiveNoProgress",
      "lastReason",
      "lastEvaluation",
      "armedAt",
      "pausedAt",
      "achievedAt",
    ])
  )
    return false;
  return (
    typeof value["id"] === "string" &&
    isPositiveInteger(value["revision"]) &&
    typeof value["condition"] === "string" &&
    value["condition"].trim().length > 0 &&
    isGoalStatus(value["status"]) &&
    isNonNegativeFiniteNumber(value["createdAt"]) &&
    isPositiveInteger(value["maxIterations"]) &&
    isPositiveInteger(value["blockCap"]) &&
    isOptionalPositiveInteger(value["tokenBudget"]) &&
    isNonNegativeInteger(value["iterations"]) &&
    isNonNegativeInteger(value["tokensAtStart"]) &&
    isNonNegativeInteger(value["tokensNow"]) &&
    typeof value["tokensBaselinePending"] === "boolean" &&
    isNonNegativeInteger(value["consecutiveNoProgress"]) &&
    (value["lastEvaluation"] === undefined || isGoalEvaluation(value["lastEvaluation"])) &&
    isOptionalString(value["lastReason"]) &&
    isOptionalNonNegativeFiniteNumber(value["armedAt"]) &&
    isOptionalNonNegativeFiniteNumber(value["pausedAt"]) &&
    isOptionalNonNegativeFiniteNumber(value["achievedAt"])
  );
}

function isGoalEvaluation(value: unknown): value is PersistedGoalEvaluation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["met", "impossible", "progress", "waiting", "evaluatorFailed", "reason", "at"]) &&
    isOptionalBoolean(value["met"]) &&
    isOptionalBoolean(value["impossible"]) &&
    isOptionalBoolean(value["progress"]) &&
    isOptionalBoolean(value["waiting"]) &&
    isOptionalBoolean(value["evaluatorFailed"]) &&
    ["met", "impossible", "progress", "waiting", "evaluatorFailed"].some(
      (key) => value[key] === true,
    ) &&
    typeof value["reason"] === "string" &&
    isNonNegativeFiniteNumber(value["at"])
  );
}

function isGoalCoordinator(value: unknown): value is PersistedGoalCoordinator {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "pendingContinuation",
      "currentExecution",
      "lastSettledRunId",
      "workTokens",
      "accountedRunIds",
    ]) &&
    (value["pendingContinuation"] === null || isGoalContinuationIntent(value["pendingContinuation"])) &&
    (value["currentExecution"] === null || isGoalExecutionRef(value["currentExecution"])) &&
    isOptionalString(value["lastSettledRunId"]) &&
    isNonNegativeInteger(value["workTokens"]) &&
    isStringArray(value["accountedRunIds"])
  );
}

function isGoalContinuationIntent(value: unknown): value is PersistedGoalContinuationIntent {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "goalId",
      "revision",
      "generation",
      "triggeringRunId",
      "prompt",
      "createdAt",
      "runId",
      "daemonRunId",
      "turnId",
      "invocationId",
      "runStartedEventId",
      "runStartedAt",
    ]) &&
    typeof value["goalId"] === "string" &&
    isPositiveInteger(value["revision"]) &&
    isPositiveInteger(value["generation"]) &&
    isOptionalString(value["triggeringRunId"]) &&
    typeof value["prompt"] === "string" &&
    isNonNegativeFiniteNumber(value["createdAt"]) &&
    typeof value["runId"] === "string" &&
    typeof value["daemonRunId"] === "string" &&
    typeof value["turnId"] === "string" &&
    typeof value["invocationId"] === "string" &&
    typeof value["runStartedEventId"] === "string" &&
    isNonNegativeFiniteNumber(value["runStartedAt"])
  );
}

function isGoalExecutionRef(value: unknown): value is PersistedGoalExecutionRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "goalId",
      "revision",
      "generation",
      "triggeringRunId",
      "prompt",
      "createdAt",
      "runId",
      "daemonRunId",
      "turnId",
      "invocationId",
      "runStartedEventId",
      "runStartedAt",
      "origin",
      "started",
    ]) &&
    typeof value["goalId"] === "string" &&
    isPositiveInteger(value["revision"]) &&
    isPositiveInteger(value["generation"]) &&
    isOptionalString(value["triggeringRunId"]) &&
    typeof value["prompt"] === "string" &&
    isNonNegativeFiniteNumber(value["createdAt"]) &&
    typeof value["runId"] === "string" &&
    typeof value["daemonRunId"] === "string" &&
    typeof value["turnId"] === "string" &&
    typeof value["invocationId"] === "string" &&
    typeof value["runStartedEventId"] === "string" &&
    isNonNegativeFiniteNumber(value["runStartedAt"]) &&
    (value["origin"] === "user" || value["origin"] === "goal") &&
    isOptionalBoolean(value["started"])
  );
}

function isGoalControlLease(value: unknown): value is PersistedGoalControlLease {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["goalId", "generation"]) &&
    typeof value["goalId"] === "string" &&
    isPositiveInteger(value["generation"])
  );
}

function isGoalStatus(value: unknown): value is PersistedGoalStatus {
  return (
    value === "active" ||
    value === "waiting" ||
    value === "paused" ||
    value === "achieved" ||
    value === "impossible" ||
    value === "stalled" ||
    value === "budget_limited" ||
    value === "max_iterations" ||
    value === "cleared"
  );
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0 && value.every((entry) => entry.trim().length > 0);
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

function isProviderKind(value: unknown): value is PersistedProviderKind {
  return value === "openai" || value === "claude" || value === "responses";
}

function isNonPlanMode(value: unknown): value is PersistedPermissionMode {
  return value === "ask" || value === "auto" || value === "full-access";
}

function isReasoningLevel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCostStatus(value: unknown): value is PersistedCostStatus {
  return value === "estimated" || value === "included" || value === "unknown";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
