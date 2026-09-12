import type { ConversationItemView } from "./conversation/types.js";
import type {
  UsageDashboardDetails,
  ApprovalSessionScopeView,
  RuntimeCapabilityScope,
  RuntimeCollaborationMode,
  RuntimeMcpServerInput,
  RuntimeMemoryItem,
  RuntimeMemorySettings,
  RuntimeOrchestrationMode,
  RuntimePermissionMode,
  RuntimeSubagentSettingsSnapshot,
} from "@pico/protocol";

export type JsonRecord = Readonly<Record<string, unknown>>;

/**
 * 应用运行相位（3-C 事件驱动）：渲染层不自维护连接状态机——探活/降级/恢复
 * 判定在主进程 runtime-supervisor 与共享 client（src/daemon/client.ts 的重连
 * 环）里；本类型只是它们的推送事件（unavailable/recovered）与本地引导结果在
 * 视图上的展示词汇。
 */
export type AppRuntimePhase =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly detail: string; readonly retryable: boolean };

export interface SessionView {
  readonly id: string;
  readonly workspacePath: string;
  readonly title: string;
  readonly status: "active" | "archived";
  readonly pinned?: boolean | undefined;
  readonly updatedAt: number;
  readonly summary?: string | undefined;
  readonly parentSession?:
    | {
        readonly sessionId: string;
        readonly workspacePath: string;
        readonly agentName?: string | undefined;
      }
    | undefined;
}

export interface RunView {
  readonly id: string;
  readonly workspacePath: string;
  readonly sessionId?: string | undefined;
  readonly description: string;
  readonly status: string;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface TimelineItem {
  readonly id: string;
  readonly kind: "message" | "plan" | "tool" | "agent" | "status";
  readonly title: string;
  readonly detail?: string | undefined;
  readonly state?: "done" | "active" | "waiting" | "failed" | undefined;
  readonly at: number;
  readonly sessionId?: string | undefined;
  readonly runId?: string | undefined;
  readonly eventType?: string | undefined;
  readonly data?: JsonRecord | undefined;
}

export interface ConversationView {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly session?: SessionView | undefined;
  readonly items: readonly ConversationItemView[];
  readonly hasEarlier?: boolean | undefined;
  readonly queuedCount: number;
  readonly runId?: string | undefined;
  readonly changes?: readonly ChangeView[] | undefined;
  readonly changeFingerprint?: string | undefined;
  readonly usage?: UsageView | undefined;
  readonly context?: SessionContextView | undefined;
  readonly settings?: SessionSettingsView | undefined;
  readonly goalItem?: ConversationItemView | undefined;
  readonly discoveryItem?: ConversationItemView | undefined;
  readonly loadError?: string | undefined;
}

export interface SessionContextView {
  readonly routeId: string;
  readonly estimatedInputTokens: number;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly inputBudgetTokens: number;
  readonly remainingTokens: number;
  readonly usedPercent: number;
  readonly estimation: string;
}

export interface SessionSettingsView {
  readonly modelRouteId: string;
  readonly model: string;
  readonly collaborationMode: "agent" | "plan";
  readonly orchestrationMode: "default" | "graph" | "swarm";
  readonly permissionMode: "ask" | "auto" | "full-access";
  readonly thinkingEffort: string;
  readonly reasoningLevels: readonly string[];
}

export interface ModelRouteView {
  readonly id: string;
  readonly label: string;
}

export type ProviderOrigin = "user" | "environment";
export type ProviderProtocol = "openai" | "claude" | "responses";
export type ProviderCredentialStatus = "ready" | "missing" | "environment" | "unsupported";
export type ProviderCredentialSource = "config" | "keychain" | "environment" | "none";

export interface ProviderView {
  readonly id: string;
  readonly protocol: ProviderProtocol;
  readonly modelProtocols?: Readonly<Record<string, ProviderProtocol>>;
  readonly auth?: "api-key" | "none";
  readonly baseURL: string;
  readonly apiKeyEnv: string;
  readonly models: readonly string[];
  readonly discoverModels: boolean;
  readonly modelCapabilities?: JsonRecord | undefined;
  readonly origin: ProviderOrigin;
  readonly fingerprint: string;
  readonly credentialStatus: ProviderCredentialStatus;
  readonly credentialSource: ProviderCredentialSource;
  readonly storedCredentialPresent: boolean;
}

export type ProviderDraft = Pick<
  ProviderView,
  | "id"
  | "protocol"
  | "modelProtocols"
  | "auth"
  | "baseURL"
  | "apiKeyEnv"
  | "models"
  | "discoverModels"
  | "modelCapabilities"
>;

export interface UserDefaultsView {
  readonly modelRouteId?: string | undefined;
  readonly collaborationMode?: RuntimeCollaborationMode | undefined;
  readonly orchestrationMode?: RuntimeOrchestrationMode | undefined;
  readonly permissionMode?: RuntimePermissionMode | undefined;
  readonly thinkingEffort?: string | undefined;
}

export interface ProviderConfigView {
  readonly supported: boolean;
  readonly writable: boolean;
  readonly revision: string;
  readonly defaultModelRouteId?: string | undefined;
  readonly userDefaults: UserDefaultsView;
  readonly providers: readonly ProviderView[];
}

export interface CatalogAgentView {
  readonly subagentId?: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly tools: readonly string[];
  readonly modelRouteId?: string | undefined;
}

export interface CatalogSkillView {
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly string[];
  readonly model?: string | undefined;
}

interface ApprovalViewBase {
  readonly id: string;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly title: string;
  readonly detail: string;
  readonly risk: "low" | "medium" | "high";
}

export interface ToolApprovalView extends ApprovalViewBase {
  readonly kind: "tool";
  readonly diff?: string | undefined;
  readonly sessionScope?: ApprovalSessionScopeView | undefined;
  readonly toolName: string;
  readonly providerCallId: string;
  readonly command?: string | undefined;
  readonly planControlMode?: never;
  readonly planId?: never;
  readonly expectedRevision?: never;
  readonly expectedSessionSequence?: never;
  readonly controlEpoch?: never;
  readonly planOperationId?: never;
  readonly planFeedback?: never;
  readonly planTitle?: never;
  readonly planOverview?: never;
  readonly planSteps?: never;
}

export interface PlanApprovalView extends ApprovalViewBase {
  readonly kind: "plan";
  readonly planControlMode: "review" | "revision" | "interrupted" | "graph_active";
  readonly planId: string;
  readonly expectedRevision: number;
  readonly expectedSessionSequence: number;
  readonly controlEpoch: string;
  readonly planOperationId: string;
  readonly planTitle?: string | undefined;
  readonly planOverview?: string | undefined;
  readonly planSteps?: readonly string[] | undefined;
  readonly planFeedback?: string | undefined;
  readonly diff?: never;
  readonly sessionScope?: never;
  readonly toolName?: never;
  readonly providerCallId?: never;
  readonly command?: never;
}

export type ApprovalView = ToolApprovalView | PlanApprovalView;

export interface PromptView {
  readonly id: string;
  readonly runId: string;
  readonly question: string;
  readonly options: readonly string[];
}

export interface ChangeView {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string | undefined;
}

export interface JobView {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly updatedAt: number;
}

export interface CapabilityView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly state: "ready" | "attention" | "disabled";
  readonly meta?: string | undefined;
  readonly source?: CapabilitySourceView | undefined;
}

export interface CapabilitySourceView {
  readonly scope: RuntimeCapabilityScope;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly readOnly: boolean;
  readonly effective: boolean;
  readonly shadowedBy?: string | undefined;
}

export interface CapabilityScopeView {
  readonly userItems: readonly CapabilityView[];
  readonly userRevision: string;
  readonly workspacePath?: string | undefined;
}

export type McpServerDraft = RuntimeMcpServerInput;

export interface UsageView {
  readonly details?: UsageDashboardDetails | undefined;
  readonly totalTokens?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly uncachedInputTokens?: number | undefined;
  readonly cacheRequestHitRate?: number | undefined;
  readonly cachePromptTokenReuseRate?: number | undefined;
  readonly cacheReadToWriteRatio?: number | undefined;
  readonly cacheAlerts?: readonly string[] | undefined;
  readonly costCNY?: number | undefined;
  readonly costStatus?: "none" | "estimated" | "included" | "unknown" | "partial" | undefined;
  readonly providerCallCount?: number | undefined;
  readonly usageReportCount?: number | undefined;
  readonly baselineCount?: number | undefined;
  readonly scope?: "all" | "workspace" | "session" | undefined;
  readonly workspacePath?: string | undefined;
  readonly unavailableWorkspaceCount?: number | undefined;
  readonly period?: string | undefined;
  readonly refreshedAt?: number | undefined;
}

export type WorkspaceMode = "folder" | "git";

export interface WorkspaceView {
  readonly path: string;
  readonly name: string;
  readonly mode: WorkspaceMode;
  readonly registered: boolean;
  readonly trusted: boolean;
  readonly temporary?: true | undefined;
}

export interface WorkspaceCapabilities {
  readonly foregroundRuns: boolean;
  readonly fileHistory: boolean;
  readonly isolatedWorktrees: boolean;
  readonly branchMerge: boolean;
}

export const folderWorkspaceCapabilities: WorkspaceCapabilities = {
  foregroundRuns: true,
  fileHistory: true,
  isolatedWorktrees: false,
  branchMerge: false,
};

export interface AppData {
  readonly subagentSettings?: RuntimeSubagentSettingsSnapshot;
  readonly workspaces: readonly WorkspaceView[];
  readonly workspacePath?: string | undefined;
  readonly workspaceMode?: WorkspaceMode | undefined;
  readonly workspaceBranch?: string | undefined;
  readonly workspaceCapabilities: WorkspaceCapabilities;
  readonly trusted: boolean;
  readonly sessions: readonly SessionView[];
  readonly runs: readonly RunView[];
  readonly timeline: readonly TimelineItem[];
  readonly conversations: Readonly<Record<string, ConversationView>>;
  readonly approvals: readonly ApprovalView[];
  readonly prompts: readonly PromptView[];
  readonly changes: readonly ChangeView[];
  readonly changeFingerprint?: string | undefined;
  readonly jobs: readonly JobView[];
  readonly skills: readonly CapabilityView[];
  readonly mcpServers: readonly CapabilityView[];
  readonly skillScope: CapabilityScopeView;
  readonly mcpScope: CapabilityScopeView;
  readonly providerConfig: ProviderConfigView;
  readonly modelRoutes: readonly ModelRouteView[];
  readonly catalogAgents: readonly CatalogAgentView[];
  readonly catalogSkills: readonly CatalogSkillView[];
  readonly usage: UsageView;
  readonly configVersion: number;
  readonly launchAtLogin?: boolean | undefined;
  readonly backgroundMode?: boolean | undefined;
  readonly memory: MemoryView;
  readonly notices: Readonly<Record<string, string>>;
}

export interface MemoryView {
  readonly workspacePath?: string | undefined;
  readonly items: readonly RuntimeMemoryItem[];
  readonly settings?: RuntimeMemorySettings | undefined;
  readonly status: "idle" | "loading" | "ready" | "degraded" | "error";
  readonly error?: string | undefined;
}

export type MemoryItemPatch = Readonly<{
  kind?: RuntimeMemoryItem["kind"];
  content?: string;
  lifecycleState?: RuntimeMemoryItem["lifecycleState"];
}>;

export type MemorySettingsPatch = Readonly<{
  enabled?: boolean;
  autoExtract?: boolean;
  recallEnabled?: boolean;
}>;

export const emptyData: AppData = {
  workspaces: [],
  workspaceCapabilities: folderWorkspaceCapabilities,
  trusted: false,
  sessions: [],
  runs: [],
  timeline: [],
  conversations: {},
  approvals: [],
  prompts: [],
  changes: [],
  jobs: [],
  skills: [],
  mcpServers: [],
  skillScope: { userItems: [], userRevision: "" },
  mcpScope: { userItems: [], userRevision: "" },
  providerConfig: {
    supported: false,
    writable: false,
    revision: "",
    userDefaults: {},
    providers: [],
  },
  modelRoutes: [],
  catalogAgents: [],
  catalogSkills: [],
  usage: {},
  configVersion: 0,
  memory: { items: [], status: "idle" },
  notices: {},
};
