import { randomUUID } from "node:crypto";

export const LOCAL_RUNTIME_PROTOCOL_VERSION = 1;
export const LOCAL_RUNTIME_AUTH_VERSION = 1;
export const MAX_RUNTIME_FRAME_BYTES = 1024 * 1024;

export type JsonScalar = boolean | null | number | string;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonScalar | readonly JsonValue[] | JsonObject;

declare const identifierBrand: unique symbol;
export type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]?: Kind;
};
export type SessionId = Identifier<"SessionId">;
export type RunId = Identifier<"RunId">;
export type JobId = Identifier<"JobId">;
export type ApprovalId = Identifier<"ApprovalId">;
export type PromptId = Identifier<"PromptId">;
export type CheckpointId = Identifier<"CheckpointId">;

export type EmptyParams = Record<string, never>;
export type WorkspaceParams = { readonly workspacePath: string };
export type WorkspaceRegistrationParams = WorkspaceParams;

export type RuntimeRunStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "succeeded";
export type RuntimeSessionStatus = "active" | "archived";
export type RuntimeJobStatus = "idle" | "running" | "failed" | "succeeded";
export type SessionSendBehavior = "auto" | "steer" | "queue" | "replace";
export type SessionSendDisposition = "started" | "steered" | "queued" | "replaced";
export type RuntimeInteractionMode = "default" | "plan" | "auto" | "yolo";
export type RuntimeProviderKind = "openai" | "claude" | "gemini";
export type RuntimeConfigSource =
  | "user"
  | "project"
  | "project-legacy"
  | "environment"
  | "session"
  | "cli";
export type RuntimeCredentialStatus = "ready" | "missing" | "environment" | "unsupported";
export type RuntimeCredentialSource = "keychain" | "environment" | "none";

export type RuntimeProviderInput = JsonObject & {
  readonly id: string;
  readonly protocol: RuntimeProviderKind;
  readonly baseURL: string;
  readonly apiKeyEnv: string;
  readonly models: readonly string[];
  readonly discoverModels: boolean;
  readonly modelCapabilities?: JsonObject;
};

export type RuntimeProviderProfile = RuntimeProviderInput & {
  readonly origin: Extract<RuntimeConfigSource, "user" | "project-legacy" | "environment">;
  readonly fingerprint: string;
  readonly credentialStatus: RuntimeCredentialStatus;
  readonly credentialSource: RuntimeCredentialSource;
};

export type RuntimeUserDefaults = JsonObject & {
  readonly modelRouteId?: string;
  readonly mode?: RuntimeInteractionMode;
  readonly thinkingEffort?: string;
};

export type RuntimeUserConfig = JsonObject & {
  readonly version: 1;
  readonly defaults: RuntimeUserDefaults;
  readonly providers: readonly RuntimeProviderInput[];
};

export type RuntimeEffectiveConfig = JsonObject & {
  readonly defaultModelRouteId?: string;
  readonly providers: readonly RuntimeProviderProfile[];
  readonly sources: JsonObject;
  readonly revisions: {
    readonly user: string;
    readonly project: string;
  };
};

export type RuntimeSessionSettings = {
  readonly sessionId: SessionId;
  readonly provider: RuntimeProviderKind;
  readonly model: string;
  readonly modelRouteId?: string;
  readonly mode: RuntimeInteractionMode;
  /** `/permissions` is a UI alias of mode, never an independently persisted value. */
  readonly permissions: RuntimeInteractionMode;
  readonly thinkingEffort: string;
  readonly thinkingEffortExplicit: boolean;
  readonly reasoningLevels: readonly string[];
};

export type RuntimeGoalStatus = "active" | "paused" | "blocked" | "complete";

export type RuntimeGoal = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: RuntimeGoalStatus;
  readonly createdAt: number;
  readonly budgetConfig?: {
    readonly maxTurns?: number;
    readonly maxTokens?: number;
    readonly maxCostCNY?: number;
    readonly maxWallClockMs?: number;
  };
  readonly budgetUsage: {
    readonly turns: number;
    readonly tokens: number;
    readonly costCNY: number;
    readonly startedAt: number;
  };
  readonly progress?: string;
  readonly blockedReason?: string;
};

export type RuntimeGoalSnapshot = {
  readonly stateVersion: 1;
  readonly sequence: number;
  readonly activeGoalId: string | null;
  readonly goals: readonly RuntimeGoal[];
};

export type RuntimeTextUserInput = JsonObject & {
  /** Omitted by legacy desktop clients; new clients should send the explicit discriminator. */
  readonly kind?: "text";
  readonly text: string;
};

export type RuntimeSkillUserInput = JsonObject & {
  readonly kind: "skill";
  readonly name: string;
  readonly args?: string;
};

export type RuntimeAgentUserInput = JsonObject & {
  readonly kind: "agent";
  readonly name: string;
  readonly task: string;
};

export type RuntimeUserInput = RuntimeTextUserInput | RuntimeSkillUserInput | RuntimeAgentUserInput;

export type RuntimeCatalogAgent = JsonObject & {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly sourcePath: string;
  readonly tools: readonly string[];
  readonly modelRouteId?: string;
};

export type RuntimeCatalogSkill = JsonObject & {
  readonly name: string;
  readonly description: string;
  readonly sourcePath?: string;
  readonly allowedTools?: readonly string[];
  readonly model?: string;
};

export type RuntimeQueuedInput = JsonObject & {
  readonly queueId: string;
  readonly sessionId: SessionId;
  readonly input: RuntimeUserInput;
  readonly createdAt: number;
};

export type RuntimeConversationItem = (
  | (JsonObject & {
      readonly id: string;
      readonly kind: "userMessage" | "assistantMessage" | "systemNotice" | "error";
      readonly content: string;
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "skill";
      readonly name: string;
      readonly args: string;
      readonly trigger: "user-slash" | "model-tool";
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "plan";
      readonly title: string;
      readonly detail?: string;
      readonly state?: "waiting" | "active" | "done" | "failed";
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "tool";
      readonly name: string;
      readonly args: string;
      readonly status: "running" | "success" | "error";
      readonly summary?: string;
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "runBoundary";
      readonly runId?: RunId;
      readonly status: RuntimeRunStatus;
      readonly startedAt: number;
      readonly finishedAt?: number;
      /** Terminal Run failure reason. Running boundaries never carry this field. */
      readonly error?: string;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "approval" | "prompt" | "changes" | "subagent" | "goal";
      readonly title: string;
      readonly detail?: string;
      readonly state?: string;
      readonly at?: number;
      readonly data?: JsonObject;
    })
) & {
  /** 单条目超出 IPC 字节预算时的诚实降级标记。 */
  readonly truncated?: true;
  readonly originalBytes?: number;
};

export type RuntimeRun = JsonObject & {
  readonly runId: RunId;
  readonly workspacePath: string;
  readonly sessionId?: SessionId;
  readonly description: string;
  readonly status: RuntimeRunStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
  readonly version: number;
};

export type RuntimeSession = JsonObject & {
  readonly sessionId: SessionId;
  readonly workspacePath: string;
  readonly title: string;
  readonly status: RuntimeSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type RuntimeJob = JsonObject & {
  readonly jobId: JobId;
  readonly workspacePath: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly status: RuntimeJobStatus;
  readonly updatedAt: number;
};

export type RuntimeChange = JsonObject & {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
};

export type RuntimeWorkspaceInitResult = {
  readonly workspacePath: string;
  readonly files: readonly {
    readonly path: "AGENTS.md" | ".pico/config.json";
    readonly status: "created" | "existing";
  }[];
  readonly message: string;
};

export type RuntimeDiagnosticCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: "ok" | "warning" | "error" | "unavailable";
  readonly summary: string;
  readonly recommendation?: string;
};

export type RuntimeDiagnosticsReport = {
  readonly workspacePath: string;
  readonly healthy: boolean;
  readonly checks: readonly RuntimeDiagnosticCheck[];
  readonly output: string;
};

export type RuntimeResourceDiagnosticEntry = {
  readonly kind: string;
  readonly origin: "claude-compat" | "legacy" | "pico-native" | "runtime-state";
  readonly path: string;
  readonly status: "missing" | "present" | "unsafe";
  readonly authority: boolean;
  readonly reason?: string;
};

export type RuntimeResourceDiagnosticsReport = {
  readonly workDir: string;
  readonly picoHome: string;
  readonly workspaceStateRoot: string;
  readonly entries: readonly RuntimeResourceDiagnosticEntry[];
  readonly findings: readonly string[];
  readonly output: string;
};

export type RuntimeMethodMap = {
  readonly "runtime.ping": {
    readonly params: JsonObject;
    readonly result: {
      readonly pong: true;
      readonly protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
      readonly capabilities: readonly string[];
      /** Canonical state root used by this daemon. Omitted by legacy runtimes. */
      readonly picoHome?: string;
    };
  };
  readonly "workspace.init": {
    readonly params: WorkspaceParams;
    readonly result: RuntimeWorkspaceInitResult;
  };
  readonly "diagnostics.run": {
    readonly params: WorkspaceParams;
    readonly result: RuntimeDiagnosticsReport;
  };
  readonly "diagnostics.resources": {
    readonly params: WorkspaceParams;
    readonly result: RuntimeResourceDiagnosticsReport;
  };
  readonly "session.list": {
    readonly params: WorkspaceParams & { readonly includeArchived?: boolean };
    readonly result: { readonly sessions: readonly RuntimeSession[] };
  };
  readonly "session.get": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.create": {
    readonly params: WorkspaceParams & { readonly title?: string };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.archive": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.restore": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.rename": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId; readonly title: string };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.fork": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession; readonly sourceSessionId: SessionId };
  };
  readonly "session.compact": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: {
      readonly session: RuntimeSession;
      readonly compacted: true;
      readonly beforeMessageCount: number;
      readonly afterMessageCount: number;
    };
  };
  readonly "session.settings.get": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly settings: RuntimeSessionSettings };
  };
  readonly "session.settings.update": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly modelRouteId?: string;
      readonly mode?: RuntimeInteractionMode;
      /** Compatibility UI alias. If mode is also present both values must match. */
      readonly permissions?: RuntimeInteractionMode;
      readonly thinkingEffort?: string;
    };
    readonly result: { readonly settings: RuntimeSessionSettings };
  };
  readonly "goal.get": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly goal: RuntimeGoalSnapshot | null };
  };
  readonly "session.send": {
    readonly params: WorkspaceParams & {
      readonly sessionId?: SessionId;
      readonly input: RuntimeUserInput;
      readonly behavior?: SessionSendBehavior;
      readonly expectedRunId?: RunId;
      readonly idempotencyKey: string;
    };
    readonly result: {
      readonly session: RuntimeSession;
      readonly run?: RuntimeRun;
      readonly disposition: SessionSendDisposition;
    };
  };
  readonly "session.transcript": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly before?: string;
      readonly limit?: number;
      readonly expectedRevision?: string;
    };
    readonly result: {
      readonly session: RuntimeSession;
      readonly items: readonly RuntimeConversationItem[];
      readonly activeRun?: RuntimeRun;
      readonly queuedInputs: readonly RuntimeQueuedInput[];
      readonly nextBefore?: string;
      readonly revision: string;
    };
  };
  readonly "run.start": {
    readonly params: WorkspaceParams & {
      readonly prompt: string;
      readonly sessionId?: SessionId;
      readonly idempotencyKey?: string;
    };
    readonly result: RuntimeRun;
  };
  readonly "run.cancel": {
    readonly params: WorkspaceParams & { readonly runId: RunId; readonly reason?: string };
    readonly result: RuntimeRun;
  };
  readonly "run.pause": {
    readonly params: WorkspaceParams & { readonly runId: RunId };
    readonly result: RuntimeRun;
  };
  readonly "run.resume": {
    readonly params: WorkspaceParams & { readonly runId: RunId };
    readonly result: RuntimeRun;
  };
  readonly "run.steer": {
    readonly params: WorkspaceParams & { readonly runId: RunId; readonly message: string };
    readonly result: RuntimeRun;
  };
  readonly "runs.list": {
    readonly params: WorkspaceParams & { readonly sessionId?: SessionId };
    readonly result: { readonly runs: readonly RuntimeRun[] };
  };
  readonly "approval.respond": {
    readonly params: WorkspaceParams & {
      readonly approvalId: ApprovalId;
      readonly decision: "allow_once" | "allow_session" | "deny";
      readonly reason?: string;
      readonly idempotencyKey?: string;
    };
    readonly result: { readonly accepted: boolean; readonly alreadyResolved: boolean };
  };
  readonly "prompt.respond": {
    readonly params: WorkspaceParams & {
      readonly promptId: PromptId;
      readonly answer: JsonValue;
      readonly idempotencyKey?: string;
    };
    readonly result: { readonly accepted: boolean; readonly alreadyResolved: boolean };
  };
  readonly "changes.list": {
    readonly params: WorkspaceParams & { readonly runId: RunId };
    readonly result: { readonly changes: readonly RuntimeChange[]; readonly fingerprint: string };
  };
  readonly "changes.diff": {
    readonly params: WorkspaceParams & { readonly runId: RunId; readonly path: string };
    readonly result: {
      readonly path: string;
      readonly patch: string;
      readonly truncated: boolean;
      readonly fingerprint: string;
    };
  };
  readonly "changes.review": {
    readonly params: WorkspaceParams & {
      readonly runId: RunId;
      readonly decision: "approve" | "request_changes";
      readonly message?: string;
      readonly expectedFingerprint: string;
    };
    readonly result: { readonly accepted: boolean; readonly fingerprint: string };
  };
  readonly "changes.apply": {
    readonly params: WorkspaceParams & {
      readonly runId: RunId;
      readonly expectedFingerprint: string;
    };
    readonly result: { readonly applied: boolean; readonly fingerprint: string };
  };
  readonly "rewind.list": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: {
      readonly checkpoints: readonly (JsonObject & {
        readonly checkpointId: CheckpointId;
        readonly label: string;
        readonly createdAt: number;
      })[];
    };
  };
  readonly "rewind.preview": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly checkpointId: CheckpointId;
    };
    readonly result: {
      readonly checkpointId: CheckpointId;
      readonly changes: readonly RuntimeChange[];
      readonly fingerprint: string;
    };
  };
  readonly "rewind.apply": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly checkpointId: CheckpointId;
      readonly expectedFingerprint: string;
    };
    readonly result: { readonly applied: boolean; readonly sessionId: SessionId };
  };
  readonly "jobs.list": {
    readonly params: WorkspaceParams;
    readonly result: { readonly jobs: readonly RuntimeJob[] };
  };
  readonly "jobs.create": {
    readonly params: WorkspaceParams & {
      readonly name: string;
      readonly prompt: string;
      readonly schedule: string;
      readonly enabled?: boolean;
    };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.update": {
    readonly params: WorkspaceParams & {
      readonly jobId: JobId;
      readonly name?: string;
      readonly prompt?: string;
      readonly schedule?: string;
    };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.delete": {
    readonly params: WorkspaceParams & { readonly jobId: JobId };
    readonly result: { readonly deleted: boolean };
  };
  readonly "jobs.setEnabled": {
    readonly params: WorkspaceParams & { readonly jobId: JobId; readonly enabled: boolean };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.runNow": {
    readonly params: WorkspaceParams & { readonly jobId: JobId };
    readonly result: { readonly job: RuntimeJob; readonly runId: RunId };
  };
  readonly "jobs.history": {
    readonly params: WorkspaceParams & { readonly jobId: JobId; readonly limit?: number };
    readonly result: { readonly runs: readonly RuntimeRun[] };
  };
  readonly "config.get": {
    readonly params: WorkspaceParams;
    readonly result: { readonly config: JsonObject; readonly version: number };
  };
  readonly "config.update": {
    readonly params: WorkspaceParams & {
      readonly patch: JsonObject;
      readonly expectedVersion: number;
    };
    readonly result: { readonly config: JsonObject; readonly version: number };
  };
  readonly "config.providers": {
    readonly params: WorkspaceParams;
    readonly result: { readonly providers: readonly JsonObject[] };
  };
  readonly "config.user.get": {
    readonly params: EmptyParams;
    readonly result: { readonly config: RuntimeUserConfig; readonly revision: string };
  };
  readonly "config.user.update": {
    readonly params: {
      readonly defaults: RuntimeUserDefaults;
      readonly expectedRevision: string;
    };
    readonly result: { readonly config: RuntimeUserConfig; readonly revision: string };
  };
  readonly "config.effective.get": {
    readonly params: WorkspaceParams;
    readonly result: { readonly config: RuntimeEffectiveConfig };
  };
  readonly "provider.list": {
    readonly params: EmptyParams;
    readonly result: {
      readonly providers: readonly RuntimeProviderProfile[];
      readonly revision: string;
    };
  };
  readonly "provider.upsert": {
    readonly params: {
      readonly provider: RuntimeProviderInput;
      readonly expectedRevision: string;
    };
    readonly result: {
      readonly provider: RuntimeProviderProfile;
      readonly revision: string;
    };
  };
  readonly "provider.delete": {
    readonly params: { readonly providerId: string; readonly expectedRevision: string };
    readonly result: { readonly deleted: true; readonly revision: string };
  };
  readonly "provider.credential.status": {
    readonly params: { readonly providerId: string };
    readonly result: {
      readonly providerId: string;
      readonly status: RuntimeCredentialStatus;
      readonly source: RuntimeCredentialSource;
      readonly providerFingerprint: string;
    };
  };
  readonly "provider.credential.set": {
    readonly params: {
      readonly providerId: string;
      readonly secret: string;
      readonly expectedProviderFingerprint: string;
    };
    readonly result: {
      readonly providerId: string;
      readonly status: "ready";
      readonly source: "keychain";
      readonly providerFingerprint: string;
    };
  };
  readonly "provider.credential.delete": {
    readonly params: {
      readonly providerId: string;
      readonly expectedProviderFingerprint: string;
    };
    readonly result: {
      readonly providerId: string;
      readonly status: "missing";
      readonly source: "none";
      readonly providerFingerprint: string;
    };
  };
  readonly "catalog.agents": {
    readonly params: WorkspaceParams;
    readonly result: { readonly agents: readonly RuntimeCatalogAgent[] };
  };
  readonly "catalog.skills": {
    readonly params: WorkspaceParams;
    readonly result: { readonly skills: readonly RuntimeCatalogSkill[] };
  };
  readonly "config.skills": {
    readonly params: WorkspaceParams;
    readonly result: { readonly skills: readonly JsonObject[] };
  };
  readonly "config.mcpServers": {
    readonly params: WorkspaceParams;
    readonly result: { readonly servers: readonly JsonObject[] };
  };
  readonly "usage.get": {
    readonly params: WorkspaceParams & {
      readonly sessionId?: SessionId;
      readonly from?: number;
      readonly to?: number;
    };
    readonly result: { readonly usage: JsonObject };
  };
  readonly "workspace.register": {
    readonly params: WorkspaceRegistrationParams;
    readonly result: { readonly workspacePath: string; readonly registered: true };
  };
  readonly "workspace.unregister": {
    readonly params: WorkspaceRegistrationParams;
    readonly result: { readonly workspacePath: string; readonly registered: false };
  };
  readonly "workspace.status": {
    readonly params: WorkspaceParams;
    readonly result: WorkspaceStatusResult;
  };
  readonly "workspace.list": {
    readonly params: EmptyParams;
    readonly result: { readonly workspaces: readonly WorkspaceStatusResult[] };
  };
  readonly "workspace.trust": {
    readonly params: WorkspaceParams & { readonly trusted: boolean };
    readonly result: { readonly workspacePath: string; readonly trusted: boolean };
  };
  readonly "workspace.trustStatus": {
    readonly params: WorkspaceParams;
    readonly result: { readonly workspacePath: string; readonly trusted: boolean };
  };
  readonly "events.replay": {
    readonly params: {
      readonly workspacePath?: string;
      readonly afterEventId?: string;
      readonly limit?: number;
    };
    readonly result: { readonly events: readonly RuntimeEvent[] };
  };
  readonly "events.subscribe": {
    readonly params: { readonly workspacePath?: string; readonly afterEventId?: string };
    readonly result: {
      readonly subscribed: true;
      readonly events: readonly RuntimeEvent[];
    };
  };
};

export const RUNTIME_METHODS = [
  "runtime.ping",
  "workspace.init",
  "diagnostics.run",
  "diagnostics.resources",
  "session.list",
  "session.get",
  "session.create",
  "session.archive",
  "session.restore",
  "session.rename",
  "session.fork",
  "session.compact",
  "session.settings.get",
  "session.settings.update",
  "goal.get",
  "session.send",
  "session.transcript",
  "run.start",
  "run.cancel",
  "run.pause",
  "run.resume",
  "run.steer",
  "runs.list",
  "approval.respond",
  "prompt.respond",
  "changes.list",
  "changes.diff",
  "changes.review",
  "changes.apply",
  "rewind.list",
  "rewind.preview",
  "rewind.apply",
  "jobs.list",
  "jobs.create",
  "jobs.update",
  "jobs.delete",
  "jobs.setEnabled",
  "jobs.runNow",
  "jobs.history",
  "config.get",
  "config.update",
  "config.providers",
  "config.user.get",
  "config.user.update",
  "config.effective.get",
  "provider.list",
  "provider.upsert",
  "provider.delete",
  "provider.credential.status",
  "provider.credential.set",
  "provider.credential.delete",
  "catalog.agents",
  "catalog.skills",
  "config.skills",
  "config.mcpServers",
  "usage.get",
  "workspace.register",
  "workspace.unregister",
  "workspace.status",
  "workspace.list",
  "workspace.trust",
  "workspace.trustStatus",
  "events.replay",
  "events.subscribe",
] as const satisfies readonly (keyof RuntimeMethodMap)[];

export type RuntimeMethod = keyof RuntimeMethodMap;
export type RuntimeMethodName = RuntimeMethod;
export type RuntimeParams<Method extends RuntimeMethod> = RuntimeMethodMap[Method]["params"];
export type RuntimeResult<Method extends RuntimeMethod> = RuntimeMethodMap[Method]["result"];

export type RuntimeEventMap = {
  readonly "workspace.registered": { readonly registered: true };
  readonly "workspace.unregistered": { readonly registered: false };
  readonly "workspace.trustChanged": { readonly trusted: boolean };
  readonly "workspace.initialized": RuntimeWorkspaceInitResult;
  readonly "session.updated": { readonly session: RuntimeSession };
  readonly "session.settingsUpdated": {
    readonly sessionId: SessionId;
    readonly settings: RuntimeSessionSettings;
  };
  readonly "session.transcriptUpdated": {
    readonly sessionId: SessionId;
    readonly operation: "reload" | "truncate";
    readonly revision?: string;
  };
  readonly "run.started": { readonly run: RuntimeRun };
  readonly "run.updated": { readonly run: RuntimeRun };
  readonly "run.finished": { readonly run: RuntimeRun };
  readonly "run.timeline": { readonly runId: RunId; readonly item: JsonObject };
  readonly "approval.requested": {
    readonly approvalId: ApprovalId;
    readonly runId: RunId;
    readonly request: JsonObject;
  };
  readonly "approval.resolved": {
    readonly approvalId: ApprovalId;
    readonly decision: "allow_once" | "allow_session" | "deny";
  };
  readonly "prompt.requested": {
    readonly promptId: PromptId;
    readonly runId: RunId;
    readonly prompt: JsonObject;
  };
  readonly "prompt.resolved": { readonly promptId: PromptId };
  readonly "changes.updated": { readonly runId: RunId; readonly fingerprint: string };
  readonly "changes.applied": { readonly runId: RunId; readonly fingerprint: string };
  readonly "rewind.completed": {
    readonly sessionId: SessionId;
    readonly checkpointId: CheckpointId;
  };
  readonly "job.updated": { readonly job: RuntimeJob };
  readonly "job.runFinished": { readonly jobId: JobId; readonly run: RuntimeRun };
  readonly "config.updated": {
    /** Legacy project-config version retained for older clients. */
    readonly version?: number;
    readonly scope?: "user" | "project";
    readonly revision?: string;
    readonly providerIds?: readonly string[];
  };
  readonly "usage.updated": { readonly usage: JsonObject };
  readonly "runtime.error": {
    readonly code: RuntimeErrorCode;
    readonly message: string;
    readonly recoverable: boolean;
  };
};

export type RuntimeEventTopic = keyof RuntimeEventMap;
type EventPayload<Topic extends string> = Topic extends RuntimeEventTopic
  ? RuntimeEventMap[Topic]
  : JsonValue;

export interface RuntimeEvent<Topic extends string = string> {
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  eventId: string;
  topic: Topic;
  scope: {
    workspacePath: string;
    sessionId?: SessionId;
    runId?: RunId;
    jobId?: JobId;
  };
  resourceVersion: number;
  at: number;
  payload: EventPayload<Topic>;
}

export type TypedRuntimeEvent = {
  [Topic in RuntimeEventTopic]: RuntimeEvent<Topic>;
}[RuntimeEventTopic];

export interface WorkspaceStatusResult extends JsonObject {
  workspacePath: string;
  registered: boolean;
  schedulerStatus: "unknown";
  mode: "folder" | "git";
  capabilities: {
    readonly foregroundRuns: boolean;
    readonly fileHistory: boolean;
    readonly isolatedWorktrees: boolean;
    readonly branchMerge: boolean;
  };
}

export type RuntimeRequest<Method extends RuntimeMethod = RuntimeMethod> =
  Method extends RuntimeMethod
    ? {
        kind: "request";
        protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
        requestId: string;
        method: Method;
        params: RuntimeParams<Method>;
      }
    : never;

export interface RuntimeSuccessResponse<Result extends JsonValue = JsonValue> {
  kind: "response";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: Result;
}

export const RUNTIME_ERROR_CODES = {
  INVALID_JSON: "INVALID_JSON",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  INVALID_KIND: "INVALID_KIND",
  INVALID_AUTH: "INVALID_AUTH",
  INVALID_REQUEST: "INVALID_REQUEST",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INVALID_PARAMS: "INVALID_PARAMS",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  CONFLICT: "CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  LEGACY_INVALID_MESSAGE: "invalid_message",
  LEGACY_INVALID_REQUEST: "invalid_request",
  LEGACY_RUNTIME_ERROR: "runtime_error",
} as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];

export interface RuntimeErrorResponse {
  kind: "response";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: { code: RuntimeErrorCode; message: string };
}

export interface RuntimeEventMessage {
  kind: "event";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  event: RuntimeEvent;
}

export interface RuntimeAuthRequest {
  kind: "auth";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  authVersion: typeof LOCAL_RUNTIME_AUTH_VERSION;
  token: string;
}

export interface RuntimeAuthResult {
  kind: "auth_result";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  authVersion: typeof LOCAL_RUNTIME_AUTH_VERSION;
  ok: boolean;
}

export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;
export type RuntimeMessage =
  | RuntimeAuthRequest
  | RuntimeAuthResult
  | RuntimeRequest
  | RuntimeResponse
  | RuntimeEventMessage;

export class RuntimeProtocolError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(message: string);
  constructor(code: RuntimeErrorCode, message: string);
  constructor(codeOrMessage: RuntimeErrorCode | string, message?: string) {
    super(message ?? codeOrMessage);
    this.name = "RuntimeProtocolError";
    this.code =
      message === undefined
        ? RUNTIME_ERROR_CODES.INVALID_REQUEST
        : (codeOrMessage as RuntimeErrorCode);
  }
}

export function createRuntimeAuthRequest(token: string): RuntimeAuthRequest {
  return {
    kind: "auth",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    authVersion: LOCAL_RUNTIME_AUTH_VERSION,
    token,
  };
}

export function createRuntimeAuthResult(ok: boolean): RuntimeAuthResult {
  return {
    kind: "auth_result",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    authVersion: LOCAL_RUNTIME_AUTH_VERSION,
    ok,
  };
}

export function createRuntimeRequest(method: RuntimeMethod, params: JsonValue): RuntimeRequest {
  const checkedParams = parseRuntimeParams(method, params);
  return {
    kind: "request",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    params: checkedParams,
  } as RuntimeRequest;
}

export function createTypedRuntimeRequest<Method extends RuntimeMethod>(
  method: Method,
  params: RuntimeParams<Method>,
): RuntimeRequest<Method> {
  return createRuntimeRequest(method, params) as RuntimeRequest<Method>;
}

export function createRuntimeEvent<Topic extends string>(
  input: Omit<RuntimeEvent<Topic>, "eventId" | "protocolVersion"> & { eventId?: string },
): RuntimeEvent<Topic> {
  return {
    ...input,
    eventId: input.eventId ?? randomUUID(),
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
  };
}

export function createRuntimeError(
  requestId: string,
  code: RuntimeErrorCode,
  message: string,
): RuntimeErrorResponse {
  return {
    kind: "response",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}

export function serializeRuntimeEvent(event: RuntimeEvent): JsonValue {
  return {
    protocolVersion: event.protocolVersion,
    eventId: event.eventId,
    topic: event.topic,
    scope: {
      workspacePath: event.scope.workspacePath,
      ...(event.scope.sessionId ? { sessionId: event.scope.sessionId } : {}),
      ...(event.scope.runId ? { runId: event.scope.runId } : {}),
      ...(event.scope.jobId ? { jobId: event.scope.jobId } : {}),
    },
    resourceVersion: event.resourceVersion,
    at: event.at,
    payload: event.payload,
  };
}

export function encodeRuntimeFrame(message: RuntimeMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > MAX_RUNTIME_FRAME_BYTES) {
    throw protocolError("FRAME_TOO_LARGE", `IPC 消息超过 ${MAX_RUNTIME_FRAME_BYTES} 字节上限`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Stateful decoder for length-prefixed UTF-8 JSON frames. */
export class RuntimeFrameDecoder {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): RuntimeMessage[] {
    this.pending =
      this.pending.byteLength === 0
        ? detachedBufferCopy(chunk)
        : Buffer.concat([this.pending, chunk]);
    const messages: RuntimeMessage[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > MAX_RUNTIME_FRAME_BYTES) {
        throw protocolError("FRAME_TOO_LARGE", `IPC 帧超过 ${MAX_RUNTIME_FRAME_BYTES} 字节上限`);
      }
      if (this.pending.byteLength < 4 + length) break;
      const raw = this.pending.subarray(4, 4 + length).toString("utf8");
      const remainder = this.pending.subarray(4 + length);
      // A zero-length subarray still retains the consumed frame's backing memory. Credential
      // writes are intentionally write-only, so release consumed bytes immediately and copy
      // only an actual fragmented remainder into an independent allocation.
      this.pending = remainder.byteLength === 0 ? Buffer.alloc(0) : detachedBufferCopy(remainder);
      messages.push(parseRuntimeMessage(raw));
    }
    return messages;
  }
}

function detachedBufferCopy(source: Buffer): Buffer<ArrayBuffer> {
  const copy = Buffer.alloc(source.byteLength);
  source.copy(copy);
  return copy;
}

export function parseRuntimeMessage(raw: string): RuntimeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw protocolError("INVALID_JSON", "IPC 帧不是有效 JSON");
  }
  if (!isJsonObject(parsed)) throw protocolError("INVALID_KIND", "IPC 消息必须是对象");
  if (parsed.protocolVersion !== LOCAL_RUNTIME_PROTOCOL_VERSION) {
    throw protocolError("VERSION_MISMATCH", "IPC 协议版本不兼容");
  }
  if (parsed.kind === "request") return assertRequest(parsed);
  if (parsed.kind === "response") return assertResponse(parsed);
  if (parsed.kind === "event") return assertEventMessage(parsed);
  if (parsed.kind === "auth") return assertAuthRequest(parsed);
  if (parsed.kind === "auth_result") return assertAuthResult(parsed);
  throw protocolError("INVALID_KIND", "IPC 消息 kind 无效");
}

function assertAuthRequest(value: Record<string, unknown>): RuntimeAuthRequest {
  if (
    value.authVersion !== LOCAL_RUNTIME_AUTH_VERSION ||
    typeof value.token !== "string" ||
    value.token.length < 43
  ) {
    throw protocolError("INVALID_AUTH", "IPC auth 消息无效");
  }
  return value as unknown as RuntimeAuthRequest;
}

function assertAuthResult(value: Record<string, unknown>): RuntimeAuthResult {
  if (value.authVersion !== LOCAL_RUNTIME_AUTH_VERSION || typeof value.ok !== "boolean") {
    throw protocolError("INVALID_AUTH", "IPC auth_result 消息无效");
  }
  return value as unknown as RuntimeAuthResult;
}

function assertRequest(value: Record<string, unknown>): RuntimeRequest {
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    throw protocolError("INVALID_REQUEST", "IPC requestId 无效");
  }
  if (typeof value.method !== "string" || !isRuntimeMethod(value.method)) {
    throw protocolError("METHOD_NOT_FOUND", "IPC request method 无效");
  }
  if (!isJsonObject(value.params) || !isJsonValue(value.params)) {
    throw protocolError("INVALID_PARAMS", "IPC request params 必须是 JSON 对象");
  }
  return value as unknown as RuntimeRequest;
}

function assertResponse(value: Record<string, unknown>): RuntimeResponse {
  if (typeof value.requestId !== "string" || typeof value.ok !== "boolean") {
    throw protocolError("INVALID_REQUEST", "IPC response 无效");
  }
  if (value.ok && isJsonValue(value.result)) return value as unknown as RuntimeSuccessResponse;
  if (
    !value.ok &&
    isJsonObject(value.error) &&
    isRuntimeErrorCode(value.error.code) &&
    typeof value.error.message === "string"
  ) {
    return value as unknown as RuntimeErrorResponse;
  }
  throw protocolError("INVALID_REQUEST", "IPC response 内容无效");
}

function assertEventMessage(value: Record<string, unknown>): RuntimeEventMessage {
  if (!isJsonObject(value.event) || !isRuntimeEvent(value.event)) {
    throw protocolError("INVALID_REQUEST", "IPC event 无效");
  }
  return value as unknown as RuntimeEventMessage;
}

function isRuntimeEvent(value: Record<string, unknown>): boolean {
  const scope = value.scope;
  return (
    value.protocolVersion === LOCAL_RUNTIME_PROTOCOL_VERSION &&
    typeof value.eventId === "string" &&
    typeof value.topic === "string" &&
    isJsonObject(scope) &&
    typeof scope.workspacePath === "string" &&
    optionalStringField(scope, "sessionId") &&
    optionalStringField(scope, "runId") &&
    optionalStringField(scope, "jobId") &&
    typeof value.resourceVersion === "number" &&
    Number.isSafeInteger(value.resourceVersion) &&
    value.resourceVersion >= 0 &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    isJsonValue(value.payload)
  );
}

function optionalStringField(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

export function isRuntimeMethod(value: string): value is RuntimeMethod {
  return (RUNTIME_METHODS as readonly string[]).includes(value);
}

/**
 * Validates the transport-level invariant shared by every method. Business
 * services remain responsible for validating required fields and permissions.
 */
export function parseRuntimeParams<Method extends RuntimeMethod>(
  method: Method,
  input: unknown,
): RuntimeParams<Method> {
  if (!isRuntimeMethod(method)) {
    throw protocolError("METHOD_NOT_FOUND", "IPC request method 无效");
  }
  if (!isJsonObject(input) || !isJsonValue(input)) {
    throw protocolError("INVALID_PARAMS", "IPC request params 必须是 JSON 对象");
  }
  return input as RuntimeParams<Method>;
}

type RuntimeParamRule = (value: unknown, path: string) => void;
type RuntimeParamShape = Readonly<Record<string, RuntimeParamRule>>;
type RuntimeParamValidator = (value: Record<string, unknown>) => void;

const stringParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "string") throw invalidParams(`${path} 必须是字符串`);
};
const booleanParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "boolean") throw invalidParams(`${path} 必须是布尔值`);
};
const finiteNumberParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidParams(`${path} 必须是有限数字`);
  }
};
const jsonObjectParam: RuntimeParamRule = (value, path) => {
  if (!isJsonObject(value) || !isJsonValue(value)) {
    throw invalidParams(`${path} 必须是 JSON 对象`);
  }
};
const jsonValueParam: RuntimeParamRule = (value, path) => {
  if (!isJsonValue(value)) throw invalidParams(`${path} 必须是 JSON 值`);
};
const stringArrayParam: RuntimeParamRule = (value, path) => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalidParams(`${path} 必须是字符串数组`);
  }
};

function oneOfParam<const Values extends readonly string[]>(values: Values): RuntimeParamRule {
  const allowed = new Set<string>(values);
  return (value, path) => {
    if (typeof value !== "string" || !allowed.has(value)) {
      throw invalidParams(`${path} 必须是 ${values.join(" | ")} 之一`);
    }
  };
}

function exactParamShape(
  required: RuntimeParamShape,
  optional: RuntimeParamShape = {},
): RuntimeParamValidator {
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  return (value) => {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw invalidParams(`params 不允许字段 ${key}`);
    }
    for (const [key, rule] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) throw invalidParams(`params.${key} 为必填字段`);
      rule(value[key], `params.${key}`);
    }
    for (const [key, rule] of Object.entries(optional)) {
      if (Object.hasOwn(value, key)) rule(value[key], `params.${key}`);
    }
  };
}

function assertNestedShape(
  value: unknown,
  path: string,
  required: RuntimeParamShape,
  optional: RuntimeParamShape = {},
): void {
  if (!isJsonObject(value) || !isJsonValue(value)) {
    throw invalidParams(`${path} 必须是 JSON 对象`);
  }
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidParams(`${path} 不允许字段 ${key}`);
  }
  for (const [key, rule] of Object.entries(required)) {
    if (!Object.hasOwn(value, key)) throw invalidParams(`${path}.${key} 为必填字段`);
    rule(value[key], `${path}.${key}`);
  }
  for (const [key, rule] of Object.entries(optional)) {
    if (Object.hasOwn(value, key)) rule(value[key], `${path}.${key}`);
  }
}

const interactionModeParam = oneOfParam(["default", "plan", "auto", "yolo"] as const);
const providerProtocolParam = oneOfParam(["openai", "claude", "gemini"] as const);
const sessionBehaviorParam = oneOfParam(["auto", "steer", "queue", "replace"] as const);

const runtimeUserInputParam: RuntimeParamRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidParams(`${path} 必须是用户输入对象`);
  if (value["kind"] === "skill") {
    assertNestedShape(
      value,
      path,
      { kind: oneOfParam(["skill"]), name: stringParam },
      {
        args: stringParam,
      },
    );
    return;
  }
  if (value["kind"] === "agent") {
    assertNestedShape(value, path, {
      kind: oneOfParam(["agent"]),
      name: stringParam,
      task: stringParam,
    });
    return;
  }
  assertNestedShape(value, path, { text: stringParam }, { kind: oneOfParam(["text"]) });
};

const runtimeProviderParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(
    value,
    path,
    {
      id: stringParam,
      protocol: providerProtocolParam,
      baseURL: stringParam,
      apiKeyEnv: stringParam,
      models: stringArrayParam,
      discoverModels: booleanParam,
    },
    { modelCapabilities: jsonObjectParam },
  );
};

const runtimeUserDefaultsParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(
    value,
    path,
    {},
    {
      modelRouteId: stringParam,
      mode: interactionModeParam,
      thinkingEffort: stringParam,
    },
  );
};

const noParams = exactParamShape({});
const workspaceParams = exactParamShape({ workspacePath: stringParam });
const workspaceSessionParams = exactParamShape({
  workspacePath: stringParam,
  sessionId: stringParam,
});
const workspaceRunParams = exactParamShape({ workspacePath: stringParam, runId: stringParam });
const workspaceJobParams = exactParamShape({ workspacePath: stringParam, jobId: stringParam });

const STRICT_RUNTIME_PARAM_VALIDATORS = {
  "runtime.ping": noParams,
  "workspace.init": workspaceParams,
  "diagnostics.run": workspaceParams,
  "diagnostics.resources": workspaceParams,
  "session.list": exactParamShape(
    { workspacePath: stringParam },
    { includeArchived: booleanParam },
  ),
  "session.get": workspaceSessionParams,
  "session.create": exactParamShape({ workspacePath: stringParam }, { title: stringParam }),
  "session.archive": workspaceSessionParams,
  "session.restore": workspaceSessionParams,
  "session.rename": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    title: stringParam,
  }),
  "session.fork": workspaceSessionParams,
  "session.compact": workspaceSessionParams,
  "session.settings.get": workspaceSessionParams,
  "session.settings.update": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    {
      modelRouteId: stringParam,
      mode: interactionModeParam,
      permissions: interactionModeParam,
      thinkingEffort: stringParam,
    },
  ),
  "goal.get": workspaceSessionParams,
  "session.send": exactParamShape(
    { workspacePath: stringParam, input: runtimeUserInputParam, idempotencyKey: stringParam },
    {
      sessionId: stringParam,
      behavior: sessionBehaviorParam,
      expectedRunId: stringParam,
    },
  ),
  "session.transcript": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    { before: stringParam, limit: finiteNumberParam, expectedRevision: stringParam },
  ),
  "run.start": exactParamShape(
    { workspacePath: stringParam, prompt: stringParam },
    { sessionId: stringParam, idempotencyKey: stringParam },
  ),
  "run.cancel": exactParamShape(
    { workspacePath: stringParam, runId: stringParam },
    { reason: stringParam },
  ),
  "run.pause": workspaceRunParams,
  "run.resume": workspaceRunParams,
  "run.steer": exactParamShape({
    workspacePath: stringParam,
    runId: stringParam,
    message: stringParam,
  }),
  "runs.list": exactParamShape({ workspacePath: stringParam }, { sessionId: stringParam }),
  "approval.respond": exactParamShape(
    {
      workspacePath: stringParam,
      approvalId: stringParam,
      decision: oneOfParam(["allow_once", "allow_session", "deny"]),
    },
    { reason: stringParam, idempotencyKey: stringParam },
  ),
  "prompt.respond": exactParamShape(
    { workspacePath: stringParam, promptId: stringParam, answer: jsonValueParam },
    { idempotencyKey: stringParam },
  ),
  "changes.list": workspaceRunParams,
  "changes.diff": exactParamShape({
    workspacePath: stringParam,
    runId: stringParam,
    path: stringParam,
  }),
  "changes.review": exactParamShape(
    {
      workspacePath: stringParam,
      runId: stringParam,
      decision: oneOfParam(["approve", "request_changes"]),
      expectedFingerprint: stringParam,
    },
    { message: stringParam },
  ),
  "changes.apply": exactParamShape({
    workspacePath: stringParam,
    runId: stringParam,
    expectedFingerprint: stringParam,
  }),
  "rewind.list": workspaceSessionParams,
  "rewind.preview": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    checkpointId: stringParam,
  }),
  "rewind.apply": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    checkpointId: stringParam,
    expectedFingerprint: stringParam,
  }),
  "jobs.list": workspaceParams,
  "jobs.create": exactParamShape(
    {
      workspacePath: stringParam,
      name: stringParam,
      prompt: stringParam,
      schedule: stringParam,
    },
    { enabled: booleanParam },
  ),
  "jobs.update": exactParamShape(
    { workspacePath: stringParam, jobId: stringParam },
    { name: stringParam, prompt: stringParam, schedule: stringParam },
  ),
  "jobs.delete": workspaceJobParams,
  "jobs.setEnabled": exactParamShape({
    workspacePath: stringParam,
    jobId: stringParam,
    enabled: booleanParam,
  }),
  "jobs.runNow": workspaceJobParams,
  "jobs.history": exactParamShape(
    { workspacePath: stringParam, jobId: stringParam },
    { limit: finiteNumberParam },
  ),
  "config.get": workspaceParams,
  "config.update": exactParamShape({
    workspacePath: stringParam,
    patch: jsonObjectParam,
    expectedVersion: finiteNumberParam,
  }),
  "config.providers": workspaceParams,
  "config.user.get": noParams,
  "config.user.update": exactParamShape({
    defaults: runtimeUserDefaultsParam,
    expectedRevision: stringParam,
  }),
  "config.effective.get": workspaceParams,
  "provider.list": noParams,
  "provider.upsert": exactParamShape({
    provider: runtimeProviderParam,
    expectedRevision: stringParam,
  }),
  "provider.delete": exactParamShape({ providerId: stringParam, expectedRevision: stringParam }),
  "provider.credential.status": exactParamShape({ providerId: stringParam }),
  "provider.credential.set": exactParamShape({
    providerId: stringParam,
    secret: stringParam,
    expectedProviderFingerprint: stringParam,
  }),
  "provider.credential.delete": exactParamShape({
    providerId: stringParam,
    expectedProviderFingerprint: stringParam,
  }),
  "catalog.agents": workspaceParams,
  "catalog.skills": workspaceParams,
  "config.skills": workspaceParams,
  "config.mcpServers": workspaceParams,
  "usage.get": exactParamShape(
    { workspacePath: stringParam },
    { sessionId: stringParam, from: finiteNumberParam, to: finiteNumberParam },
  ),
  "workspace.register": workspaceParams,
  "workspace.unregister": workspaceParams,
  "workspace.status": workspaceParams,
  "workspace.list": noParams,
  "workspace.trust": exactParamShape({
    workspacePath: stringParam,
    trusted: booleanParam,
  }),
  "workspace.trustStatus": workspaceParams,
  "events.replay": exactParamShape(
    {},
    { workspacePath: stringParam, afterEventId: stringParam, limit: finiteNumberParam },
  ),
  "events.subscribe": exactParamShape(
    {},
    { workspacePath: stringParam, afterEventId: stringParam },
  ),
} satisfies Readonly<Record<RuntimeMethod, RuntimeParamValidator>>;

/**
 * Applies the exact, method-specific request contract used at privileged UI boundaries.
 * Unlike the transport parser, this rejects unknown keys and validates nested request objects.
 */
export function parseStrictRuntimeParams<Method extends RuntimeMethod>(
  method: Method,
  input: unknown,
): RuntimeParams<Method> {
  const params = parseRuntimeParams(method, input);
  STRICT_RUNTIME_PARAM_VALIDATORS[method](params);
  return params;
}

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
  return (
    typeof value === "string" &&
    (Object.values(RUNTIME_ERROR_CODES) as readonly string[]).includes(value)
  );
}

export function isJsonObject(value: JsonValue): value is JsonObject;
export function isJsonObject(value: unknown): value is Record<string, unknown>;
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

function protocolError(code: RuntimeErrorCode, message: string): RuntimeProtocolError {
  return new RuntimeProtocolError(code, message);
}

function invalidParams(message: string): RuntimeProtocolError {
  return protocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
}
