import type { CostStatus } from "../observability/pricing.js";
import type { ProviderKind } from "../provider/factory.js";
import type { Message } from "../schema/message.js";
import type { Goal, GoalManagerSnapshot, GoalStatus } from "./goal-manager.js";
import type { SessionIdentity } from "./session-identity.js";
import type { DurableTranscriptEvent } from "../presentation/transcript-event-store.js";
import { decodeExecutionBoundary, type ExecutionBoundary } from "../safety/permission-profile.js";
import type { ToolResultEnvelope } from "./tool-result-contract.js";

/** Session runtime-state event schema version. */
export const SESSION_RUNTIME_STATE_VERSION = 3 as const;
export type SessionRuntimeStateVersion = typeof SESSION_RUNTIME_STATE_VERSION;

export type PersistedCollaborationMode = "agent" | "plan";
export type PersistedPermissionMode = "ask" | "auto" | "full-access";

/** 会话恢复时需要覆盖启动默认值的设置。密钥、endpoint 和 tools 不落盘。 */
export interface PersistedSessionSettings {
  /** User-assigned, human-readable session name. Undefined falls back to conversation content. */
  title?: string;
  /** Source session ID when this conversation was forked. */
  forkFrom?: string;
  /** Ephemeral Workbar side conversation; hidden from the ordinary session catalog. */
  sideConversation?: boolean;
  provider: ProviderKind;
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
  lastCostStatus: CostStatus | null;
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
  goal?: GoalManagerSnapshot;
  promptCache?: PersistedPromptCacheState;
  boundary?: ExecutionBoundary;
}

export interface SessionRuntimeStateWritePatch {
  settings?: PersistedSessionSettingsWrite;
  goal?: GoalManagerSnapshot;
  promptCache?: PersistedPromptCacheState;
  boundary?: ExecutionBoundary;
}

export interface SessionRuntimeStateSnapshot {
  stateVersion: SessionRuntimeStateVersion;
  settings?: PersistedSessionSettings;
  goal?: GoalManagerSnapshot;
  promptCache?: PersistedPromptCacheState;
  boundary?: ExecutionBoundary;
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
  if (collaborationMode !== "agent" && collaborationMode !== "plan") {
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
  return value === "openai" || value === "claude" || value === "responses";
}

function isNonPlanMode(value: unknown): value is PersistedPermissionMode {
  return value === "ask" || value === "auto" || value === "full-access";
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
