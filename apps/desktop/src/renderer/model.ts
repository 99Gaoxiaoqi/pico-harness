import type { ConversationItemView } from "./conversation/types.js";
import type {
  RuntimeMemoryFact,
  RuntimeMemoryProposal,
  RuntimeMemorySettings,
} from "@pico/protocol";

export type JsonRecord = Readonly<Record<string, unknown>>;

export type ConnectionState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string; readonly retryable: boolean };

export interface SessionView {
  readonly id: string;
  readonly workspacePath: string;
  readonly title: string;
  readonly status: "active" | "archived";
  readonly pinned?: boolean | undefined;
  readonly updatedAt: number;
  readonly summary?: string | undefined;
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
}

export interface ConversationView {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly items: readonly ConversationItemView[];
  readonly revision?: string | undefined;
  readonly nextBefore?: string | undefined;
  readonly queuedCount: number;
  readonly runId?: string | undefined;
  readonly changes?: readonly ChangeView[] | undefined;
  readonly changeFingerprint?: string | undefined;
  readonly usage?: UsageView | undefined;
  readonly settings?: SessionSettingsView | undefined;
  readonly goalItem?: ConversationItemView | undefined;
  readonly loadError?: string | undefined;
}

export interface SessionSettingsView {
  readonly modelRouteId?: string | undefined;
  readonly model: string;
  readonly mode: "default" | "plan" | "auto" | "yolo";
  readonly thinkingEffort: string;
  readonly reasoningLevels: readonly string[];
}

export interface ModelRouteView {
  readonly id: string;
  readonly label: string;
}

export type ProviderOrigin = "user" | "project-legacy" | "environment";
export type ProviderProtocol = "openai" | "claude" | "gemini";
export type ProviderCredentialStatus = "ready" | "missing" | "environment" | "unsupported";
export type ProviderCredentialSource = "keychain" | "environment" | "none";

export interface ProviderView {
  readonly id: string;
  readonly protocol: ProviderProtocol;
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
  "id" | "protocol" | "baseURL" | "apiKeyEnv" | "models" | "discoverModels" | "modelCapabilities"
>;

export interface UserDefaultsView {
  readonly modelRouteId?: string | undefined;
  readonly mode?: "default" | "plan" | "auto" | "yolo" | undefined;
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

export interface ApprovalView {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly detail: string;
  readonly command?: string | undefined;
  readonly risk: "low" | "medium" | "high";
}

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
}

export interface UsageView {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedTokens?: number | undefined;
  readonly cost?: number | undefined;
  readonly period?: string | undefined;
}

export type WorkspaceMode = "folder" | "git";

export interface WorkspaceView {
  readonly path: string;
  readonly name: string;
  readonly mode: WorkspaceMode;
  readonly registered: boolean;
  readonly trusted: boolean;
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
  readonly providers: readonly CapabilityView[];
  readonly providerConfig: ProviderConfigView;
  readonly modelRoutes: readonly ModelRouteView[];
  readonly catalogAgents: readonly CatalogAgentView[];
  readonly catalogSkills: readonly CatalogSkillView[];
  readonly usage: UsageView;
  readonly configVersion: number;
  readonly launchAtLogin?: boolean | undefined;
  readonly memory: MemoryView;
  readonly notices: Readonly<Record<string, string>>;
}

export interface MemoryView {
  readonly workspacePath?: string | undefined;
  readonly facts: readonly RuntimeMemoryFact[];
  readonly proposals: readonly RuntimeMemoryProposal[];
  readonly settings?: RuntimeMemorySettings | undefined;
  readonly status: "idle" | "loading" | "ready" | "degraded" | "error";
  readonly error?: string | undefined;
}

export type MemoryFactPatch = Readonly<{
  kind?: RuntimeMemoryFact["kind"];
  title?: string;
  content?: string;
  confidence?: number;
  state?: Exclude<RuntimeMemoryFact["state"], "forgotten">;
  pinned?: boolean;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}>;

export type MemorySettingsPatch = Readonly<{
  enabled?: boolean;
  autoPropose?: boolean;
  autoCommit?: false;
  injectionEnabled?: boolean;
  reviewMode?: RuntimeMemorySettings["reviewMode"];
}>;

export type MemoryProposalPatch = Readonly<{
  kind?: RuntimeMemoryProposal["kind"];
  title?: string;
  content?: string;
  reason?: string;
  confidence?: number;
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
  providers: [],
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
  memory: { facts: [], proposals: [], status: "idle" },
  notices: {},
};
