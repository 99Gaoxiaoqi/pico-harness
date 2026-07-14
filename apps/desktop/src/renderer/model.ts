import type { ConversationItemView } from "./conversation/types.js";

export type JsonRecord = Readonly<Record<string, unknown>>;

export type ConnectionState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string; readonly retryable: boolean };

export interface SessionView {
  readonly id: string;
  readonly title: string;
  readonly status: "active" | "archived";
  readonly updatedAt: number;
  readonly summary?: string | undefined;
}

export interface RunView {
  readonly id: string;
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
  readonly items: readonly ConversationItemView[];
  readonly revision?: string | undefined;
  readonly nextBefore?: string | undefined;
  readonly queuedCount: number;
  readonly runId?: string | undefined;
  readonly changes?: readonly ChangeView[] | undefined;
  readonly changeFingerprint?: string | undefined;
  readonly usage?: UsageView | undefined;
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
  readonly workspacePath?: string | undefined;
  readonly workspaceMode?: WorkspaceMode | undefined;
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
  readonly usage: UsageView;
  readonly configVersion: number;
  readonly launchAtLogin?: boolean | undefined;
  readonly notices: Readonly<Record<string, string>>;
}

export const emptyData: AppData = {
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
  usage: {},
  configVersion: 0,
  notices: {},
};
