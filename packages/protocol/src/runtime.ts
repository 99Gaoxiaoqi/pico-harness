export const LOCAL_RUNTIME_PROTOCOL_VERSION = 2;
export const LOCAL_RUNTIME_AUTH_VERSION = 1;
/** Increment when the Desktop-required result schema changes incompatibly. */
export const DESKTOP_RUNTIME_SCHEMA_REVISION = 16;
export const DESKTOP_RUNTIME_SCHEMA_CAPABILITY = "desktop-runtime-schema-v16";
export const CAPABILITY_SCOPE_RUNTIME_CAPABILITY = "capability-scopes-v1";
export const TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY = "temporary-workspace-v1";
export const MAX_RUNTIME_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 payload exposed through a host-facing ToolResult projection. */
export const MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES = 16 * 1024;
export const EPHEMERAL_RUNTIME_NOTIFICATION_TOPICS = [] as const;

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
export type PlanId = Identifier<"PlanId">;
export type PromptId = Identifier<"PromptId">;
export type CheckpointId = Identifier<"CheckpointId">;

export type RuntimeMemoryKind = "preference" | "correction" | "project_fact" | "reference";
export type RuntimeMemoryFactState = "active" | "disabled" | "archived" | "forgotten";
export type RuntimeMemoryProposalStatus = "pending" | "accepted" | "rejected" | "deleted";
export type RuntimeMemoryProposalConflictStatus = "none" | "potential" | "confirmed" | "resolved";

export type RuntimeMemoryFact = JsonObject & {
  readonly factId: string;
  readonly kind: RuntimeMemoryKind;
  readonly title: string | null;
  readonly content: string | null;
  readonly confidence: number;
  readonly state: RuntimeMemoryFactState;
  readonly pinned: boolean;
  readonly sourceId?: string;
  readonly source?: RuntimeMemorySourceMetadata;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly forgottenAt?: string;
};

export type RuntimeMemorySourceMetadata = JsonObject & {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly availability: "available" | "unavailable";
  readonly invalidatedAt?: string;
  readonly invalidationCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RuntimeMemoryProposal = JsonObject & {
  readonly proposalId: string;
  readonly kind: RuntimeMemoryKind;
  readonly title: string | null;
  readonly content: string | null;
  readonly reason: string | null;
  readonly confidence: number;
  readonly status: RuntimeMemoryProposalStatus;
  readonly conflictStatus: RuntimeMemoryProposalConflictStatus;
  readonly sourceId?: string;
  readonly conflictFactId?: string;
  readonly resolvedFactId?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string;
  readonly deletedAt?: string;
};

export type RuntimeMemorySettings = JsonObject & {
  readonly enabled: boolean;
  readonly autoPropose: boolean;
  readonly autoCommit: boolean;
  readonly injectionEnabled: boolean;
  readonly reviewMode: "eco" | "balanced" | "quality";
  readonly version: number;
  readonly updatedAt: string;
};

export type RuntimeMemoryReviewBudget = JsonObject & {
  readonly mode: RuntimeMemorySettings["reviewMode"];
  readonly allowed: boolean;
  readonly reason: "available" | "eco-mode" | "budget-exhausted";
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostUsd: number;
  readonly nextRecoveryAt?: string;
};

export type RuntimeMemoryContextBudget = JsonObject & {
  readonly maxFacts: number;
  readonly maxTokens: number;
  readonly usedFacts: number;
  readonly usedTokens: number;
  readonly truncated: boolean;
};

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
export type RuntimeRewindMode = "code" | "conversation" | "both";
export type RuntimeJobStatus = "idle" | "running" | "failed" | "succeeded";
export type SessionSendBehavior = "auto" | "steer" | "queue" | "replace";
export type SessionSendDisposition = "started" | "steered" | "queued" | "replaced";
export type RuntimeCollaborationMode = "agent" | "plan";
export type RuntimeOrchestrationMode = "default" | "graph";
export type RuntimePermissionMode = "default" | "auto" | "yolo";
/** @deprecated Compatibility input accepted by older clients. */
export type RuntimeInteractionMode = RuntimePermissionMode | "plan";
export type RuntimeProviderKind = "openai" | "claude";
export type RuntimeConfigSource =
  | "user"
  | "project"
  | "project-legacy"
  | "environment"
  | "session"
  | "cli";
export type RuntimeCredentialStatus = "ready" | "missing" | "environment" | "unsupported";
export type RuntimeCredentialSource = "config" | "keychain" | "environment" | "none";

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
  /** A durable config or legacy keychain credential exists. */
  readonly storedCredentialPresent: boolean;
};

export type RuntimeUserDefaults = JsonObject & {
  readonly modelRouteId?: string;
  readonly collaborationMode?: RuntimeCollaborationMode;
  readonly orchestrationMode?: RuntimeOrchestrationMode;
  readonly permissionMode?: RuntimePermissionMode;
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
  readonly collaborationMode: RuntimeCollaborationMode;
  readonly orchestrationMode: RuntimeOrchestrationMode;
  readonly permissionMode: RuntimePermissionMode;
  readonly thinkingEffort: string;
  readonly thinkingEffortExplicit: boolean;
  readonly reasoningLevels: readonly string[];
  /** 会话附加授权目录（/add-dir 镜像；缺省=未配置）。 */
  readonly additionalDirectories?: readonly string[];
};

export type RuntimePlanStep = JsonObject & {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: "pending" | "in_progress" | "completed" | "skipped";
  readonly note?: string;
};

export type RuntimePlanProposal = JsonObject & {
  readonly planId: PlanId;
  readonly revision: number;
  readonly title: string;
  readonly overview?: string;
  readonly steps: readonly RuntimePlanStep[];
  readonly risks?: readonly string[];
  readonly status: "pending" | "stale" | "approved" | "rejected";
  readonly proposedAt: string;
};

export type RuntimePlanProjection = JsonObject & {
  readonly sessionId: SessionId;
  readonly sessionSequence: number;
  readonly proposals: readonly RuntimePlanProposal[];
  readonly latestProposal?: RuntimePlanProposal;
  readonly pendingProposal?: RuntimePlanProposal;
};

export type RuntimeDiscoveryDepth = "quick" | "balanced" | "deep";
export type RuntimeDiscoveryStatus = "active" | "interrupted" | "completed" | "cancelled";

export type RuntimeDiscoveryRun = JsonObject & {
  readonly discoveryId: string;
  readonly objective: string;
  readonly depth: RuntimeDiscoveryDepth;
  readonly phase: "forage" | "focus" | "deepen" | "verify";
  readonly status: RuntimeDiscoveryStatus;
  readonly cycle: number;
  readonly inspectedFiles: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly openQuestions: readonly string[];
  readonly candidates: readonly JsonObject[];
  readonly branches: readonly JsonObject[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly reason?: string;
  readonly report?: JsonObject;
};

export type RuntimeDiscoveryProjection = JsonObject & {
  readonly sessionId: SessionId;
  readonly sessionSequence: number;
  readonly discoveries: readonly RuntimeDiscoveryRun[];
  readonly latest?: RuntimeDiscoveryRun;
  readonly active?: RuntimeDiscoveryRun;
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

/** text 输入的内联图片附件（仅 base64；数量/大小上限在参数校验层强制）。 */
export type RuntimeInputAttachment = JsonObject & {
  readonly type: "image_base64";
  readonly mimeType: string;
  readonly data: string;
};

export type RuntimeTextUserInput = JsonObject & {
  readonly kind: "text";
  readonly text: string;
  /** 图片附件（3-D 漏账补齐；无附件时省略字段，空数组非法）。 */
  readonly attachments?: readonly RuntimeInputAttachment[];
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

export type RuntimeCapabilityScope = "user" | "project" | "plugin";

/** Opaque provenance safe to expose to the sandboxed Renderer. */
export type RuntimeCapabilitySourceMetadata = JsonObject & {
  readonly scope: RuntimeCapabilityScope;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly readOnly: boolean;
  readonly effective: boolean;
  readonly shadowedBy?: string;
};

export type RuntimeScopedSkill = JsonObject & {
  readonly name: string;
  readonly description: string;
  readonly source: RuntimeCapabilitySourceMetadata;
  readonly allowedTools?: readonly string[];
  readonly model?: string;
};

type RuntimeMcpServerCommon = JsonObject & {
  readonly name: string;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabled?: boolean;
};

export type RuntimeMcpServerInput =
  | (RuntimeMcpServerCommon & {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    })
  | (RuntimeMcpServerCommon & {
      readonly transport: "http" | "sse";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    });

type RuntimeScopedMcpServerCommon = JsonObject & {
  readonly name: string;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabled?: boolean;
  readonly source: RuntimeCapabilitySourceMetadata;
};

/** Sanitized MCP projection: secret values are represented only by their key names. */
export type RuntimeScopedMcpServer =
  | (RuntimeScopedMcpServerCommon & {
      readonly transport: "stdio";
      /** Executable basename only; absolute/relative paths never cross the Renderer boundary. */
      readonly commandLabel: string;
      readonly hasArguments: boolean;
      readonly envKeys?: readonly string[];
    })
  | (RuntimeScopedMcpServerCommon & {
      readonly transport: "http" | "sse";
      /** URL origin only; paths can carry credentials and never cross the Renderer boundary. */
      readonly endpointLabel: string;
      readonly headerKeys?: readonly string[];
    });

export type RuntimeCapabilityRevisions = JsonObject & {
  readonly user: string;
  readonly project: string;
};

export type RuntimeQueuedInput = JsonObject & {
  readonly queueId: string;
  readonly sessionId: SessionId;
  readonly input: RuntimeUserInput;
  readonly createdAt: number;
};

export type RuntimeTranscriptDirection = "older" | "newer";

/**
 * Stable transcript page boundary captured against one fixed high-watermark.
 * `position`/`ordinal` map to the store record sequence/chunk index; byteOffset
 * continues an oversized record without replacing the durable ordering key.
 */
export type RuntimeTranscriptCursor = JsonObject & {
  readonly revision: string;
  readonly throughTranscriptSequence: number;
  readonly position: number;
  readonly ordinal: number;
  readonly byteOffset: number;
  readonly direction: RuntimeTranscriptDirection;
};

/** One UTF-8-safe byte range of a serialized RuntimeConversationItem. */
export type RuntimeTranscriptFragment = JsonObject & {
  readonly itemId: string;
  readonly position: number;
  readonly ordinal: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly json: string;
};

export const TRANSCRIPT_PROJECTOR_VERSION = 1 as const;

export type RuntimeTranscriptWatermark = JsonObject & {
  readonly historyEpoch: string;
  readonly projectorVersion: typeof TRANSCRIPT_PROJECTOR_VERSION;
  readonly throughSequence: number;
};

export type RuntimeTranscriptItemRecord = JsonObject & {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly positionSequence: number;
  readonly positionOrdinal: number;
  readonly item: RuntimeConversationItem;
};

/**
 * One UTF-8-safe range of the canonical JSON encoding of `RuntimeTranscriptItemRecord.item`.
 * Stable record metadata is repeated on every fragment so clients can validate and assemble
 * without retaining Host-side state between fixed-watermark requests.
 */
export type RuntimeTranscriptItemFragment = JsonObject & {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly positionSequence: number;
  readonly positionOrdinal: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly json: string;
};

export type RuntimeTranscriptPageCursor = JsonObject & {
  readonly historyEpoch: string;
  readonly projectorVersion: typeof TRANSCRIPT_PROJECTOR_VERSION;
  readonly throughSequence: number;
  readonly positionSequence: number;
  readonly positionOrdinal: number;
  readonly byteOffset: number;
};

export type RuntimeTranscriptAdvanceCursor = JsonObject & {
  readonly historyEpoch: string;
  readonly projectorVersion: typeof TRANSCRIPT_PROJECTOR_VERSION;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly changeSequence: number;
  readonly ordinal: number;
  readonly byteOffset: number;
};

export type RuntimeTranscriptChange =
  | (JsonObject & { readonly op: "upsert"; readonly record: RuntimeTranscriptItemRecord })
  | (JsonObject & {
      readonly op: "remove";
      readonly itemId: string;
      readonly itemRevision: number;
    });

export type RuntimeActiveOverlayEntry = JsonObject & {
  readonly runId: RunId;
  readonly turnId: string;
  readonly itemId: string;
  readonly streamId: string;
  readonly kind: "text" | "thinking" | "toolOutput";
  readonly startOffsetBytes: number;
  readonly endOffsetBytes: number;
  readonly text: string;
  readonly anchorSequence: number;
  readonly stream?: "stdout" | "stderr";
  readonly truncatedBeforeBytes?: number;
  readonly complete?: true;
};

export type RuntimeSessionSubscriptionEnvelope = JsonObject & {
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly sessionId: SessionId;
};

export type RuntimeSessionSubscriptionFrame = RuntimeSessionSubscriptionEnvelope &
  (
    | (JsonObject & {
        readonly type: "subscription.session_delta";
        readonly runId: RunId;
        readonly turnId: string;
        readonly itemId: string;
        readonly streamId: string;
        readonly kind: "text" | "thinking" | "toolOutput";
        readonly startOffsetBytes: number;
        readonly text: string;
        readonly stream?: "stdout" | "stderr";
        readonly reset?: true;
        readonly complete?: true;
      })
    | (JsonObject & {
        readonly type: "subscription.tool_event" | "subscription.subagent_update";
        readonly payload: JsonObject;
      })
    | (JsonObject & {
        readonly type: "subscription.run_state";
        readonly run: RuntimeRun;
      })
    | (JsonObject & {
        readonly type: "subscription.transcript_advanced";
        readonly watermark: RuntimeTranscriptWatermark;
      })
    | (JsonObject & {
        readonly type: "subscription.resource_changed";
        readonly resource: "tasks" | "artifacts" | "trace" | "context";
        readonly revision?: number;
        readonly watermark?: number;
      })
    | (JsonObject & {
        readonly type: "subscription.continuity_degraded";
        readonly reason: "partial_persistence_failed" | "recovery_failed";
      })
    | (JsonObject & {
        readonly type: "subscription.closed";
        readonly reason: "client_closed" | "slow_consumer" | "host_shutdown";
      })
  );

export function isRuntimeTranscriptCursor(value: unknown): value is RuntimeTranscriptCursor {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 6 &&
    keys.every((key) =>
      [
        "revision",
        "throughTranscriptSequence",
        "position",
        "ordinal",
        "byteOffset",
        "direction",
      ].includes(key),
    ) &&
    typeof value["revision"] === "string" &&
    value["revision"].length > 0 &&
    Number.isSafeInteger(value["throughTranscriptSequence"]) &&
    (value["throughTranscriptSequence"] as number) > 0 &&
    Number.isSafeInteger(value["position"]) &&
    (value["position"] as number) >= 0 &&
    Number.isSafeInteger(value["ordinal"]) &&
    (value["ordinal"] as number) >= 0 &&
    Number.isSafeInteger(value["byteOffset"]) &&
    (value["byteOffset"] as number) >= 0 &&
    (value["direction"] === "older" || value["direction"] === "newer")
  );
}

export type RuntimeToolResultEnvelope = JsonObject & {
  readonly version: 1;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: "succeeded" | "failed" | "rejected" | "cancelled" | "interrupted";
  readonly rawSizeBytes: number;
  readonly sha256: string;
  readonly deliveryTruncated: boolean;
  readonly projection: JsonObject & {
    readonly version: 1;
    readonly mode: "full" | "preview" | "synthetic";
    readonly text: string;
    readonly strategy: string;
    readonly truncated: boolean;
  };
  readonly evidence?: JsonObject & {
    readonly uri: string;
    readonly ref: JsonObject & {
      readonly schemaVersion: 2;
      readonly contentHash: string;
      readonly sessionId: string;
      readonly kind: "tool-exchange";
    };
  };
};

export type RuntimeConversationItem = (
  | (JsonObject & {
      readonly id: string;
      readonly kind: "userMessage" | "systemNotice" | "error";
      readonly content: string;
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "assistantMessage";
      readonly content: string;
      /** Present when the durable answer can be tied to one Runtime model turn. */
      readonly runId?: RunId;
      readonly turnId?: string;
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      /** Provider explicitly returned reasoning/thinking content. */
      readonly kind: "thinking";
      readonly content: string;
      /** Present when the durable message can be tied to one Runtime model turn. */
      readonly runId?: RunId;
      readonly turnId?: string;
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
      /** Present only after a canonical tool.result.recorded fact exists. */
      readonly result?: RuntimeToolResultEnvelope;
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
      readonly kind: "approval" | "prompt" | "changes" | "goal";
      readonly title: string;
      readonly detail?: string;
      readonly state?: string;
      readonly at?: number;
      readonly data?: JsonObject;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "subagent";
      readonly name?: string;
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
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type RuntimeSessionTaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type RuntimeSessionTask = JsonObject & {
  readonly taskId: string;
  readonly title: string;
  readonly detail?: string;
  readonly status: RuntimeSessionTaskStatus;
  readonly ordinal: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type RuntimeSessionArtifact = JsonObject & {
  readonly artifactId: string;
  readonly title: string;
  readonly mimeType: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** Versioned extension of the legacy context JsonObject returned under `context`. */
export type RuntimeSessionContextSnapshot = JsonObject & {
  readonly version: 2;
  readonly sessionId: SessionId;
  readonly generatedAt: number;
  readonly traceWatermark: number;
};

export type RuntimeGitReviewSource = "branch" | "staged" | "unstaged";
export type RuntimeGitReviewFile = JsonObject & {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  readonly additions: number;
  readonly deletions: number;
};

export type RuntimeTerminalStatus = "starting" | "running" | "interrupted" | "exited";
export type RuntimeTerminalCapability = "pty" | "pipe";
export type RuntimeTerminalSession = JsonObject & {
  readonly terminalId: string;
  readonly workspacePath: string;
  readonly sessionId: SessionId;
  readonly resourceEpoch: string;
  readonly sequence: number;
  readonly status: RuntimeTerminalStatus;
  readonly capability: RuntimeTerminalCapability;
  readonly resizeSupported: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly exitCode?: number;
};

export type RuntimeBrowserAgentAction =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "get_state"
  | "click"
  | "type";

/** Fixed-operation command consumed only by the visible Electron browser panel. */
export type RuntimeBrowserAgentCommand = JsonObject & {
  readonly commandId: string;
  readonly sessionId: SessionId;
  readonly action: RuntimeBrowserAgentAction;
  readonly input: JsonObject;
  readonly createdAt: number;
  readonly expiresAt: number;
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
  /** Plugin snapshot diagnostics are surfaced by the host; they are not resource entries. */
  readonly pluginDiagnostics?: readonly RuntimePluginDiagnostic[];
  readonly output: string;
};

export type RuntimePluginDiagnostic = {
  readonly pluginId: string;
  readonly sourcePath: string;
  readonly message: string;
  readonly code?: string;
  readonly scope?: "user" | "project" | "local";
  readonly severity?: "error" | "warning" | "info";
  readonly compatibility?: "compatible" | "degraded" | "blocked";
};

export type RuntimeMethodMap = {
  readonly "runtime.ping": {
    readonly params: JsonObject;
    readonly result: {
      readonly pong: true;
      readonly protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
      readonly desktopSchemaRevision: typeof DESKTOP_RUNTIME_SCHEMA_REVISION;
      readonly capabilities: readonly string[];
      /** Canonical state root used by this daemon. */
      readonly picoHome: string;
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
  readonly "session.pin": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.unpin": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.delete": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: {
      readonly sessionId: SessionId;
      readonly deleted: true;
      /** Includes hidden Side Chat children whose host resources were removed in the same saga. */
      readonly closedSessionIds?: readonly SessionId[];
    };
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
  /** 活跃路由的上下文预算与能力报告（BLOCKED 收口：/context 镜像）。 */
  readonly "session.context.get": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly context: RuntimeSessionContextSnapshot };
  };
  readonly "session.tasks.query": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly taskId?: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly revision?: number;
    };
    readonly result: {
      readonly revision: number;
      readonly tasks: readonly RuntimeSessionTask[];
      readonly nextCursor?: string;
    };
  };
  readonly "session.tasks.command": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly action: "create" | "update";
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
      readonly taskId?: string;
      readonly title?: string;
      readonly detail?: string | null;
      readonly status?: RuntimeSessionTaskStatus;
    };
    readonly result: { readonly revision: number; readonly task: RuntimeSessionTask };
  };
  readonly "session.artifacts.query": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly action: "list" | "get" | "read_chunk";
      readonly artifactId?: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly revision?: number;
      readonly offsetBytes?: number;
      readonly limitBytes?: number;
    };
    readonly result: JsonObject;
  };
  readonly "session.artifacts.command": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly action: "begin" | "append" | "commit" | "abort" | "delete";
      readonly expectedRevision?: number;
      readonly idempotencyKey?: string;
      readonly artifactId?: string;
      readonly ingestId?: string;
      readonly title?: string;
      readonly mimeType?: string;
      readonly offsetBytes?: number;
      readonly contentBase64?: string;
      readonly expectedDigest?: string;
      readonly expectedSizeBytes?: number;
    };
    readonly result: JsonObject;
  };
  readonly "session.trace.query": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly throughSequence?: number;
      readonly afterSequence?: number;
      readonly limit?: number;
    };
    readonly result: {
      readonly throughSequence: number;
      readonly events: readonly JsonObject[];
      readonly nextAfterSequence?: number;
    };
  };
  readonly "git.review.snapshot": {
    readonly params: WorkspaceParams & { readonly source?: RuntimeGitReviewSource };
    readonly result: {
      readonly revision: string;
      readonly branch: string;
      readonly source: RuntimeGitReviewSource;
      readonly files: readonly RuntimeGitReviewFile[];
      readonly truncated: boolean;
    };
  };
  readonly "git.review.diff": {
    readonly params: WorkspaceParams & {
      readonly path: string;
      readonly source: RuntimeGitReviewSource;
      readonly expectedRevision: string;
    };
    readonly result: {
      readonly path: string;
      readonly source: RuntimeGitReviewSource;
      readonly revision: string;
      readonly patch: string;
      readonly truncated: boolean;
    };
  };
  readonly "browser.agent.lease": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly visible: boolean;
      readonly generation: number;
      readonly leaseId?: string;
    };
    readonly result: {
      readonly leaseId: string;
      readonly expiresAt: number;
      readonly visible: boolean;
    };
  };
  readonly "browser.agent.next": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly leaseId: string;
      readonly waitMs?: number;
    };
    readonly result: { readonly command: RuntimeBrowserAgentCommand | null };
  };
  readonly "browser.agent.resolve": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly leaseId: string;
      readonly commandId: string;
      readonly ok: boolean;
      readonly result?: JsonObject;
      readonly error?: string;
    };
    readonly result: { readonly accepted: true };
  };
  readonly "terminal.create": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly cols?: number;
      readonly rows?: number;
    };
    readonly result: {
      readonly terminal: RuntimeTerminalSession;
      readonly resourceEpoch: string;
      readonly sequence: number;
      readonly snapshot: string;
      readonly truncated: boolean;
    };
  };
  readonly "terminal.list": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly terminals: readonly RuntimeTerminalSession[] };
  };
  readonly "terminal.attach": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly terminalId: string;
      readonly afterSequence?: number;
      readonly maxBytes?: number;
    };
    readonly result: {
      readonly terminal: RuntimeTerminalSession;
      readonly resourceEpoch: string;
      readonly sequence: number;
      readonly snapshot: string;
      readonly truncated: boolean;
    };
  };
  readonly "terminal.input": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly terminalId: string;
      readonly resourceEpoch: string;
      readonly data: string;
    };
    readonly result: { readonly accepted: true; readonly sequence: number };
  };
  readonly "terminal.resize": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly terminalId: string;
      readonly resourceEpoch: string;
      readonly cols: number;
      readonly rows: number;
    };
    readonly result: { readonly resized: true; readonly sequence: number };
  };
  readonly "terminal.stop": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly terminalId: string;
      readonly resourceEpoch: string;
    };
    readonly result: { readonly terminal: RuntimeTerminalSession };
  };
  readonly "terminal.detach": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly terminalId: string;
      readonly resourceEpoch: string;
    };
    readonly result: { readonly detached: true };
  };
  /** Host-only lifecycle fence; intentionally omitted from DESKTOP_RUNTIME_METHODS. */
  readonly "terminal.stopAll": {
    readonly params: EmptyParams;
    readonly result: { readonly stopped: number };
  };
  /** Host-only lifecycle gate; intentionally omitted from DESKTOP_RUNTIME_METHODS. */
  readonly "terminal.resume": {
    readonly params: EmptyParams;
    readonly result: { readonly accepting: true };
  };
  readonly "sideChat.create": {
    readonly params: WorkspaceParams & {
      readonly sourceSessionId: SessionId;
      readonly panelId: string;
      readonly idempotencyKey: string;
    };
    readonly result: {
      readonly session: RuntimeSession;
      readonly sourceSessionId: SessionId;
      readonly throughEventId: string;
    };
  };
  readonly "sideChat.close": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly cleanupScheduled: true };
  };
  readonly "session.settings.update": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly modelRouteId?: string;
      readonly collaborationMode?: RuntimeCollaborationMode;
      readonly orchestrationMode?: RuntimeOrchestrationMode;
      readonly permissionMode?: RuntimePermissionMode;
      /** @deprecated Legacy combined mode. `plan` enters planning; all other values update permission only. */
      readonly mode?: RuntimeInteractionMode;
      /** @deprecated Legacy permission alias. `plan` enters planning. */
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
      /** Settings applied before the first run starts. Valid only when creating a session. */
      readonly initialSettings?: RuntimeUserDefaults;
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
  readonly "session.subscription.open": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly tailLimit?: number;
      readonly maxBytes?: number;
    };
    readonly result: {
      readonly session: RuntimeSession;
      readonly hostEpoch: string;
      readonly subscriptionId: string;
      readonly nextSequence: number;
      readonly watermark: RuntimeTranscriptWatermark;
      readonly durableTail: readonly RuntimeTranscriptItemRecord[];
      readonly durableTailFragments?: readonly RuntimeTranscriptItemFragment[];
      readonly activeOverlay: readonly RuntimeActiveOverlayEntry[];
      readonly queuedInputs: readonly RuntimeQueuedInput[];
      readonly activeRun?: RuntimeRun;
      readonly olderCursor?: RuntimeTranscriptPageCursor;
      readonly continuityDegradedReason?: "partial_persistence_failed" | "recovery_failed";
    };
  };
  readonly "session.subscription.close": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly subscriptionId: string;
    };
    readonly result: { readonly closed: true };
  };
  readonly "session.transcript.page": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly through: RuntimeTranscriptWatermark;
      readonly cursor?: RuntimeTranscriptPageCursor;
      readonly limit?: number;
      readonly maxBytes?: number;
    };
    readonly result: {
      readonly watermark: RuntimeTranscriptWatermark;
      readonly items: readonly RuntimeTranscriptItemRecord[];
      readonly fragments?: readonly RuntimeTranscriptItemFragment[];
      readonly nextCursor?: RuntimeTranscriptPageCursor;
    };
  };
  readonly "session.transcript.advance": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly after: RuntimeTranscriptWatermark;
      readonly through: RuntimeTranscriptWatermark;
      readonly cursor?: RuntimeTranscriptAdvanceCursor;
      readonly limit?: number;
      readonly maxBytes?: number;
    };
    readonly result: {
      readonly after: RuntimeTranscriptWatermark;
      readonly through: RuntimeTranscriptWatermark;
      readonly changes: readonly RuntimeTranscriptChange[];
      readonly fragments?: readonly RuntimeTranscriptItemFragment[];
      readonly nextCursor?: RuntimeTranscriptAdvanceCursor;
    };
  };
  readonly "session.evidence.read": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly evidenceUri: string;
      readonly offsetBytes?: number;
      readonly limitBytes?: number;
    };
    readonly result: {
      readonly evidenceUri: string;
      readonly content: string;
      readonly offsetBytes: number;
      readonly endOffsetBytes: number;
      readonly totalBytes: number;
      readonly limitBytes: number;
      readonly truncated: boolean;
      readonly nextOffsetBytes?: number;
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
      readonly runId?: RunId;
      readonly sessionId?: SessionId;
      readonly decision: "allow_once" | "allow_session" | "deny";
      readonly reason?: string;
      readonly idempotencyKey?: string;
    };
    readonly result: { readonly accepted: boolean; readonly alreadyResolved: boolean };
  };
  readonly "plan.respond": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly planId: PlanId;
      readonly action:
        | "execute"
        | "continue_editing"
        | "reject_exit"
        | "resume_execution"
        | "cancel_execution"
        | "replan_execution";
      readonly expectedRevision: number;
      readonly expectedSessionSequence: number;
      readonly operationId: string;
      readonly feedback?: string;
    };
    readonly result: {
      readonly accepted: boolean;
      readonly projection: RuntimePlanProjection;
      readonly run?: RuntimeRun;
    };
  };
  readonly "prompt.respond": {
    readonly params: WorkspaceParams & {
      readonly promptId: PromptId;
      readonly runId?: RunId;
      readonly sessionId?: SessionId;
      readonly answer: JsonValue;
      readonly idempotencyKey?: string;
    };
    readonly result: { readonly accepted: boolean; readonly alreadyResolved: boolean };
  };
  readonly "prompt.cancel": {
    readonly params: WorkspaceParams & {
      readonly promptId: PromptId;
      readonly runId?: RunId;
      readonly sessionId?: SessionId;
      readonly reason?: string;
    };
    readonly result: { readonly cancelled: boolean };
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
      /** 回滚范围（fork mode）；缺省 both（向后兼容旧客户端）。 */
      readonly mode?: RuntimeRewindMode;
    };
    readonly result: { readonly applied: boolean; readonly sessionId: SessionId };
  };
  /** 单文件恢复（/changes）：checkpoint 维度的逐文件 diff + 当前指纹（preview）。 */
  readonly "rewind.changes": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly checkpointId: CheckpointId;
    };
    readonly result: {
      readonly checkpointId: CheckpointId;
      readonly files: readonly (JsonObject & {
        readonly path: string;
        readonly status: "created" | "deleted" | "modified";
        readonly additions: number;
        readonly deletions: number;
        /** 文件当前内容指纹——restoreFile 的一致性守卫。 */
        readonly fingerprint: string;
        readonly patch: string;
        readonly truncated: boolean;
      })[];
      readonly addedLines: number;
      readonly removedLines: number;
      readonly partial?: boolean;
      readonly warnings?: readonly string[];
    };
  };
  /** 单文件恢复（/changes）：把一个文件还原到 checkpoint 之前（其余不动）。 */
  readonly "rewind.restoreFile": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly checkpointId: CheckpointId;
      readonly path: string;
      readonly expectedFingerprint: string;
    };
    readonly result: {
      readonly restored: boolean;
      readonly path: string;
      readonly status: "created" | "deleted" | "modified";
    };
  };
  readonly "memory.list": {
    readonly params: WorkspaceParams & {
      readonly states?: readonly RuntimeMemoryFactState[];
      readonly kinds?: readonly RuntimeMemoryKind[];
      readonly limit?: number;
    };
    readonly result: { readonly facts: readonly RuntimeMemoryFact[] };
  };
  readonly "memory.get": {
    readonly params: WorkspaceParams & { readonly factId: string };
    readonly result: { readonly fact: RuntimeMemoryFact };
  };
  /** /memory remember（TUI 直写）：显式记住一条 workspace fact（安全扫描 + 幂等 + 再激活）。 */
  readonly "memory.create": {
    readonly params: WorkspaceParams & { readonly text: string };
    readonly result: { readonly fact: RuntimeMemoryFact };
  };
  readonly "memory.update": {
    readonly params: WorkspaceParams & {
      readonly factId: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly kind?: RuntimeMemoryKind;
      readonly title?: string;
      readonly content?: string;
      readonly confidence?: number;
      readonly state?: Exclude<RuntimeMemoryFactState, "forgotten">;
      readonly pinned?: boolean;
      readonly expiresAt?: string | null;
      readonly lastUsedAt?: string | null;
    };
    readonly result: { readonly fact: RuntimeMemoryFact };
  };
  readonly "memory.forget": {
    readonly params: WorkspaceParams & {
      readonly factId: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
    };
    readonly result: { readonly fact: RuntimeMemoryFact };
  };
  readonly "memory.review.list": {
    readonly params: WorkspaceParams & {
      readonly statuses?: readonly RuntimeMemoryProposalStatus[];
      readonly limit?: number;
    };
    readonly result: { readonly proposals: readonly RuntimeMemoryProposal[] };
  };
  readonly "memory.review.resolve": {
    readonly params: WorkspaceParams & {
      readonly proposalId: string;
      readonly resolution: "accepted" | "rejected";
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly factId?: string;
      readonly patch?: {
        readonly kind?: RuntimeMemoryKind;
        readonly title?: string;
        readonly content?: string;
        readonly reason?: string;
        readonly confidence?: number;
      };
    };
    readonly result: {
      readonly proposal: RuntimeMemoryProposal;
      readonly fact?: RuntimeMemoryFact;
    };
  };
  readonly "memory.settings.get": {
    readonly params: WorkspaceParams;
    readonly result: {
      readonly settings: RuntimeMemorySettings;
      readonly reviewBudget: RuntimeMemoryReviewBudget;
    };
  };
  readonly "memory.settings.update": {
    readonly params: WorkspaceParams & {
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly enabled?: boolean;
      readonly autoPropose?: boolean;
      readonly autoCommit?: false;
      readonly injectionEnabled?: boolean;
      readonly reviewMode?: "eco" | "balanced" | "quality";
    };
    readonly result: {
      readonly settings: RuntimeMemorySettings;
      readonly reviewBudget: RuntimeMemoryReviewBudget;
    };
  };
  readonly "memory.context.preview": {
    readonly params: WorkspaceParams & {
      readonly maxFacts?: number;
      readonly maxTokens?: number;
    };
    readonly result: {
      readonly facts: readonly RuntimeMemoryFact[];
      readonly budget: RuntimeMemoryContextBudget;
    };
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
  /**
   * Trusted TUI-to-daemon boundary. These methods are intentionally absent from
   * the Desktop preload allowlist: the daemon re-resolves Provider authority and
   * background policy before mutating the durable Cron ledger or credential vault.
   */
  readonly "automation.credential.import": {
    readonly params: WorkspaceParams & {
      readonly modelRouteId: string;
      readonly expectedCredentialRef: string;
      readonly secret: string;
    };
    readonly result: {
      readonly imported: true;
      readonly credentialRef: string;
    };
  };
  readonly "automation.create": {
    readonly params: WorkspaceParams & {
      readonly name?: string;
      readonly prompt: string;
      readonly schedule: string;
      readonly timeZone?: string;
      readonly modelRouteId: string;
      readonly expectedCredentialRef: string;
      readonly allowedTools: readonly string[];
      readonly toolNetworkPolicy: "allow" | "disabled" | "allowlist";
      readonly allowedToolNetworkHosts?: readonly string[];
      readonly enabled?: boolean;
    };
    readonly result: { readonly job: RuntimeJob };
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
  /**
   * Trusted local-host import used by TUI. The secret is write-only and never
   * appears in the result, events, or persisted user configuration.
   */
  readonly "provider.importEnvironment": {
    readonly params: {
      readonly provider: RuntimeProviderInput;
      readonly defaultModel: string;
      readonly secret: string;
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
      readonly storedCredentialPresent: boolean;
      readonly providerFingerprint: string;
    };
  };
  readonly "provider.credential.set": {
    readonly params: {
      readonly providerId: string;
      readonly secret: string;
      readonly expectedRevision: string;
    };
    readonly result: {
      readonly providerId: string;
      readonly status: "ready";
      readonly source: "config";
      readonly storedCredentialPresent: true;
      readonly providerFingerprint: string;
      readonly revision: string;
    };
  };
  readonly "provider.credential.delete": {
    readonly params: {
      readonly providerId: string;
      readonly expectedRevision: string;
    };
    readonly result: {
      readonly providerId: string;
      readonly status: RuntimeCredentialStatus;
      readonly source: RuntimeCredentialSource;
      readonly storedCredentialPresent: boolean;
      readonly providerFingerprint: string;
      readonly revision: string;
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
  readonly "skills.user.list": {
    readonly params: EmptyParams;
    readonly result: { readonly skills: readonly RuntimeScopedSkill[]; readonly revision: string };
  };
  readonly "skills.effective.list": {
    readonly params: WorkspaceParams;
    readonly result: {
      readonly skills: readonly RuntimeScopedSkill[];
      readonly revisions: RuntimeCapabilityRevisions;
    };
  };
  readonly "mcp.user.list": {
    readonly params: EmptyParams;
    readonly result: {
      readonly servers: readonly RuntimeScopedMcpServer[];
      readonly revision: string;
    };
  };
  readonly "mcp.user.upsert": {
    readonly params: {
      readonly server: RuntimeMcpServerInput;
      readonly expectedRevision: string;
      readonly idempotencyKey: string;
    };
    readonly result: { readonly server: RuntimeScopedMcpServer; readonly revision: string };
  };
  readonly "mcp.user.delete": {
    readonly params: {
      readonly serverName: string;
      readonly expectedRevision: string;
      readonly idempotencyKey: string;
    };
    readonly result: {
      readonly serverName: string;
      readonly deleted: true;
      readonly revision: string;
    };
  };
  /** 用户级 MCP 服务器启用开关（3-D BLOCKED 收口：/mcp enable/disable 镜像）。 */
  readonly "mcp.user.setEnabled": {
    readonly params: {
      readonly serverName: string;
      readonly enabled: boolean;
      readonly expectedRevision: string;
      readonly idempotencyKey: string;
    };
    readonly result: {
      readonly server: RuntimeScopedMcpServer;
      readonly revision: string;
    };
  };
  /** 会话附加授权目录（3-D BLOCKED 收口：/add-dir 镜像；daemon 侧校验+持久化）。 */
  readonly "session.directories.add": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly path: string;
    };
    readonly result: {
      readonly directories: readonly string[];
      readonly added: boolean;
    };
  };
  /** Hook 管理面（3-D BLOCKED 收口：/hooks 镜像——list/review/trust/enable/disable/reload）。 */
  readonly "hooks.manage": {
    readonly params: WorkspaceParams & {
      readonly action: "list" | "review" | "trust" | "enable" | "disable" | "reload";
      readonly handlerId?: string;
    };
    readonly result: { readonly result: JsonObject };
  };
  /** 存储操作处置面（3-D BLOCKED 收口：/operations 镜像——list/show/retry/abort）。 */
  readonly "operations.manage": {
    readonly params: WorkspaceParams & {
      readonly action: "list" | "show" | "retry" | "abort";
      readonly operationId?: string;
      readonly expectedVersion?: number;
      readonly reason?: string;
    };
    readonly result: { readonly result: JsonObject };
  };
  /** 插件管理面（BLOCKED 收口：/plugin 镜像——list/inspect/install/trust 两阶段/enable/disable）。 */
  readonly "plugin.manage": {
    readonly params: WorkspaceParams & {
      readonly action:
        | "list"
        | "inspect"
        | "install"
        | "trust.prepare"
        | "trust.confirm"
        | "enable"
        | "disable";
      readonly id?: string;
      readonly scope?: "user" | "project" | "local";
      readonly path?: string;
      readonly confirmId?: string;
      readonly fingerprint?: string;
    };
    readonly result: { readonly result: JsonObject };
  };
  readonly "mcp.effective.list": {
    readonly params: WorkspaceParams;
    readonly result: {
      readonly servers: readonly RuntimeScopedMcpServer[];
      readonly revisions: RuntimeCapabilityRevisions;
    };
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
  readonly "workspace.temporary.ensure": {
    readonly params: EmptyParams;
    readonly result: WorkspaceStatusResult & { readonly temporary: true };
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
    readonly params: WorkspaceParams & {
      readonly afterEventId?: string;
      readonly highWatermarkEventId?: string;
      readonly limit?: number;
    };
    readonly result: RuntimeNotificationPage;
  };
  readonly "events.subscribe": {
    readonly params: WorkspaceParams & { readonly afterEventId?: string };
    readonly result: RuntimeNotificationPage & {
      readonly subscribed: true;
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
  "session.pin",
  "session.unpin",
  "session.delete",
  "session.rename",
  "session.fork",
  "session.compact",
  "session.settings.get",
  "session.context.get",
  "session.tasks.query",
  "session.tasks.command",
  "session.artifacts.query",
  "session.artifacts.command",
  "session.trace.query",
  "git.review.snapshot",
  "git.review.diff",
  "browser.agent.lease",
  "browser.agent.next",
  "browser.agent.resolve",
  "terminal.create",
  "terminal.list",
  "terminal.attach",
  "terminal.input",
  "terminal.resize",
  "terminal.stop",
  "terminal.detach",
  "terminal.stopAll",
  "terminal.resume",
  "sideChat.create",
  "sideChat.close",
  "session.settings.update",
  "session.directories.add",
  "hooks.manage",
  "operations.manage",
  "plugin.manage",
  "goal.get",
  "session.send",
  "session.subscription.open",
  "session.subscription.close",
  "session.transcript.page",
  "session.transcript.advance",
  "session.evidence.read",
  "run.start",
  "run.cancel",
  "run.pause",
  "run.resume",
  "run.steer",
  "runs.list",
  "approval.respond",
  "plan.respond",
  "prompt.respond",
  "prompt.cancel",
  "changes.list",
  "changes.diff",
  "changes.review",
  "changes.apply",
  "rewind.list",
  "rewind.preview",
  "rewind.apply",
  "rewind.changes",
  "rewind.restoreFile",
  "memory.list",
  "memory.get",
  "memory.create",
  "memory.update",
  "memory.forget",
  "memory.review.list",
  "memory.review.resolve",
  "memory.settings.get",
  "memory.settings.update",
  "memory.context.preview",
  "jobs.list",
  "jobs.create",
  "jobs.update",
  "jobs.delete",
  "jobs.setEnabled",
  "jobs.runNow",
  "jobs.history",
  "automation.credential.import",
  "automation.create",
  "config.get",
  "config.update",
  "config.providers",
  "config.user.get",
  "config.user.update",
  "config.effective.get",
  "provider.list",
  "provider.upsert",
  "provider.importEnvironment",
  "provider.delete",
  "provider.credential.status",
  "provider.credential.set",
  "provider.credential.delete",
  "catalog.agents",
  "catalog.skills",
  "config.skills",
  "config.mcpServers",
  "skills.user.list",
  "skills.effective.list",
  "mcp.user.list",
  "mcp.user.upsert",
  "mcp.user.setEnabled",
  "mcp.user.delete",
  "mcp.effective.list",
  "usage.get",
  "workspace.register",
  "workspace.unregister",
  "workspace.status",
  "workspace.list",
  "workspace.temporary.ensure",
  "workspace.trust",
  "workspace.trustStatus",
  "events.replay",
  "events.subscribe",
] as const satisfies readonly (keyof RuntimeMethodMap)[];

export type RuntimeMethod = keyof RuntimeMethodMap;
export type RuntimeMethodName = RuntimeMethod;
export type RuntimeParams<Method extends RuntimeMethod> = RuntimeMethodMap[Method]["params"];
export type RuntimeResult<Method extends RuntimeMethod> = RuntimeMethodMap[Method]["result"];

/**
 * Runtime methods that the Electron preload may expose to its sandboxed Renderer.
 *
 * This is an explicit security surface rather than a derived subset of RUNTIME_METHODS:
 * trusted-host methods that import credentials or create background automations must not
 * become Renderer-accessible merely because they exist in the local daemon protocol.
 */
export const DESKTOP_RUNTIME_METHODS = [
  "runtime.ping",
  "workspace.init",
  "diagnostics.run",
  "diagnostics.resources",
  "session.list",
  "session.get",
  "session.create",
  "session.archive",
  "session.restore",
  "session.pin",
  "session.unpin",
  "session.delete",
  "session.rename",
  "session.fork",
  "session.compact",
  "session.settings.get",
  "session.context.get",
  "session.tasks.query",
  "session.tasks.command",
  "session.artifacts.query",
  "session.artifacts.command",
  "session.trace.query",
  "git.review.snapshot",
  "git.review.diff",
  "browser.agent.lease",
  "browser.agent.next",
  "browser.agent.resolve",
  "terminal.create",
  "terminal.list",
  "terminal.attach",
  "terminal.input",
  "terminal.resize",
  "terminal.stop",
  "terminal.detach",
  "sideChat.create",
  "sideChat.close",
  "session.settings.update",
  "session.directories.add",
  "hooks.manage",
  "operations.manage",
  "plugin.manage",
  "goal.get",
  "session.send",
  "session.subscription.open",
  "session.subscription.close",
  "session.transcript.page",
  "session.transcript.advance",
  "session.evidence.read",
  "run.start",
  "run.cancel",
  "run.pause",
  "run.resume",
  "run.steer",
  "runs.list",
  "approval.respond",
  "plan.respond",
  "prompt.respond",
  "prompt.cancel",
  "changes.list",
  "changes.diff",
  "changes.review",
  "changes.apply",
  "rewind.list",
  "rewind.preview",
  "rewind.apply",
  "rewind.changes",
  "rewind.restoreFile",
  "memory.list",
  "memory.get",
  "memory.create",
  "memory.update",
  "memory.forget",
  "memory.review.list",
  "memory.review.resolve",
  "memory.settings.get",
  "memory.settings.update",
  "memory.context.preview",
  "jobs.list",
  "jobs.create",
  "jobs.update",
  "jobs.delete",
  "jobs.setEnabled",
  "jobs.runNow",
  "jobs.history",
  "config.get",
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
  "skills.user.list",
  "skills.effective.list",
  "mcp.user.list",
  "mcp.user.upsert",
  "mcp.user.setEnabled",
  "mcp.user.delete",
  "mcp.effective.list",
  "usage.get",
  "workspace.register",
  "workspace.unregister",
  "workspace.status",
  "workspace.list",
  "workspace.temporary.ensure",
  "workspace.trust",
  "workspace.trustStatus",
  "events.replay",
] as const satisfies readonly RuntimeMethod[];

export type DesktopRuntimeMethod = (typeof DESKTOP_RUNTIME_METHODS)[number];

export type RuntimeNotificationMap = {
  readonly "workspace.registered": { readonly registered: true };
  readonly "workspace.unregistered": { readonly registered: false };
  readonly "workspace.trustChanged": { readonly trusted: boolean };
  readonly "workspace.initialized": RuntimeWorkspaceInitResult;
  readonly "session.updated": { readonly session: RuntimeSession };
  readonly "session.resourceChanged": {
    readonly resource: "tasks" | "artifacts" | "trace" | "context";
    readonly revision?: number;
    readonly watermark?: number;
  };
  readonly "session.settingsUpdated": {
    readonly sessionId: SessionId;
    readonly settings: RuntimeSessionSettings;
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
  readonly "plan.updated": {
    readonly sessionId: SessionId;
    readonly projection: RuntimePlanProjection;
    readonly operation: "proposed" | "updated" | "executing" | "continue_editing" | "rejected";
  };
  readonly "discovery.updated": {
    readonly sessionId: SessionId;
    readonly projection: RuntimeDiscoveryProjection;
    readonly operation: "started" | "resumed" | "cancelled" | "updated";
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
  readonly "memory.proposed": {
    readonly proposalId: string;
    readonly version: number;
    readonly kind: RuntimeMemoryKind;
  };
  readonly "memory.changed": {
    readonly entityType: "fact" | "proposal" | "settings" | "source";
    readonly entityId: string;
    readonly version: number;
    readonly change: "updated" | "resolved" | "source_unavailable";
  };
  readonly "memory.forgotten": {
    readonly factId: string;
    readonly version: number;
  };
  readonly "job.updated": { readonly job: RuntimeJob };
  readonly "job.runFinished": { readonly jobId: JobId; readonly run: RuntimeRun };
  readonly "config.updated": {
    /** Legacy project-config version retained for older clients. */
    readonly version?: number;
    readonly scope?: "user" | "project";
    readonly revision?: string;
    readonly providerIds?: readonly string[];
    readonly capabilities?: readonly ("skills" | "mcp")[];
  };
  readonly "usage.updated": { readonly usage: JsonObject };
  readonly "runtime.error": {
    readonly code: RuntimeErrorCode;
    readonly message: string;
    readonly recoverable: boolean;
  };
};

export type RuntimeNotificationTopic = keyof RuntimeNotificationMap;
export type EphemeralRuntimeNotificationTopic =
  (typeof EPHEMERAL_RUNTIME_NOTIFICATION_TOPICS)[number];

export function isEphemeralRuntimeNotificationTopic(
  topic: string,
): topic is EphemeralRuntimeNotificationTopic {
  return (EPHEMERAL_RUNTIME_NOTIFICATION_TOPICS as readonly string[]).includes(topic);
}
type NotificationPayload<Topic extends string> = Topic extends RuntimeNotificationTopic
  ? RuntimeNotificationMap[Topic]
  : JsonValue;

export interface RuntimeNotification<Topic extends string = string> {
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
  payload: NotificationPayload<Topic>;
}

export interface RuntimeNotificationPage {
  readonly events: readonly RuntimeNotification[];
  /** True when another byte-bounded page remains before the captured high-watermark. */
  readonly hasMore: boolean;
  /** Exclusive cursor for the next page. Present whenever this page advanced the cursor. */
  readonly nextAfterEventId?: string;
  /** Fixed upper bound captured by the first page so live appends cannot move the replay target. */
  readonly highWatermarkEventId?: string;
}

export type TypedRuntimeNotification = {
  [Topic in RuntimeNotificationTopic]: RuntimeNotification<Topic>;
}[RuntimeNotificationTopic];

export interface EventLogStorageStatusResult extends JsonObject {
  readonly logicalBytes: number;
  readonly hardLimitBytes: number;
  readonly lowWatermarkBytes: number;
  readonly status: "within_limit" | "retention_required" | "quota_blocked";
  readonly canStartNewWork: boolean;
  readonly canWriteClosure: boolean;
  readonly plannedSessionCount: number;
  readonly estimatedLogicalBytesReclaimed: number;
}

export type WorkspaceStatusResult = JsonObject & {
  workspacePath: string;
  registered: boolean;
  readonly temporary?: true;
  schedulerStatus: "unknown";
  mode: "folder" | "git";
  branch: string;
  capabilities: {
    readonly foregroundRuns: boolean;
    readonly fileHistory: boolean;
    readonly isolatedWorktrees: boolean;
    readonly branchMerge: boolean;
  };
  eventLog: EventLogStorageStatusResult | null;
};

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
  RESET_REQUIRED: "RESET_REQUIRED",
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

export interface RuntimeNotificationMessage {
  kind: "event";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  event: RuntimeNotification;
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
  | RuntimeNotificationMessage;

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
    requestId: globalThis.crypto.randomUUID(),
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

export function createRuntimeNotification<Topic extends string>(
  input: Omit<RuntimeNotification<Topic>, "eventId" | "protocolVersion"> & { eventId?: string },
): RuntimeNotification<Topic> {
  return {
    ...input,
    eventId: input.eventId ?? globalThis.crypto.randomUUID(),
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

export function serializeRuntimeNotification(event: RuntimeNotification): JsonValue {
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
  if (parsed.kind === "event") return assertNotificationMessage(parsed);
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

function assertNotificationMessage(value: Record<string, unknown>): RuntimeNotificationMessage {
  if (!isJsonObject(value.event) || !isRuntimeNotification(value.event)) {
    throw protocolError("INVALID_REQUEST", "IPC event 无效");
  }
  return value as unknown as RuntimeNotificationMessage;
}

function isRuntimeNotificationEnvelope(value: Record<string, unknown>): boolean {
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

function isRuntimeNotification(value: Record<string, unknown>): boolean {
  if (!isRuntimeNotificationEnvelope(value)) return false;
  if (value.topic === "discovery.updated") return isDiscoveryRuntimeNotification(value);
  if (typeof value.topic === "string" && value.topic.startsWith("memory.")) {
    return isMemoryRuntimeNotification(value);
  }
  return true;
}

export function isDiscoveryRuntimeNotification(
  value: unknown,
): value is RuntimeNotification<"discovery.updated"> {
  if (
    !isJsonObject(value) ||
    !isRuntimeNotificationEnvelope(value) ||
    value.topic !== "discovery.updated"
  ) {
    return false;
  }
  const scope = value.scope;
  const payload = value.payload;
  if (!isJsonObject(scope) || !isJsonObject(payload)) return false;
  if (!hasExactKeys(payload, ["sessionId", "projection", "operation"])) return false;
  if (!nonEmptyString(payload.sessionId) || scope.sessionId !== payload.sessionId) return false;
  if (!["started", "resumed", "cancelled", "updated"].includes(String(payload.operation))) {
    return false;
  }
  const projection = payload.projection;
  return (
    isJsonObject(projection) &&
    projection.sessionId === payload.sessionId &&
    nonNegativeSafeInteger(projection.sessionSequence) &&
    Array.isArray(projection.discoveries) &&
    projection.discoveries.every(isJsonObject) &&
    (projection.latest === undefined || isJsonObject(projection.latest)) &&
    (projection.active === undefined || isJsonObject(projection.active))
  );
}

/** Memory events are durable, so their payload is deliberately exact and body-free. */
export function isMemoryRuntimeNotification(
  value: unknown,
): value is RuntimeNotification<"memory.proposed" | "memory.changed" | "memory.forgotten"> {
  if (!isJsonObject(value) || !isRuntimeNotificationEnvelope(value)) return false;
  const payload = value.payload;
  if (!isJsonObject(payload)) return false;
  if (value.topic === "memory.proposed") {
    return (
      hasExactKeys(payload, ["proposalId", "version", "kind"]) &&
      nonEmptyString(payload.proposalId) &&
      nonNegativeSafeInteger(payload.version) &&
      ["preference", "correction", "project_fact", "reference"].includes(String(payload.kind))
    );
  }
  if (value.topic === "memory.changed") {
    return (
      hasExactKeys(payload, ["entityType", "entityId", "version", "change"]) &&
      ["fact", "proposal", "settings", "source"].includes(String(payload.entityType)) &&
      nonEmptyString(payload.entityId) &&
      nonNegativeSafeInteger(payload.version) &&
      ["updated", "resolved", "source_unavailable"].includes(String(payload.change))
    );
  }
  if (value.topic === "memory.forgotten") {
    return (
      hasExactKeys(payload, ["factId", "version"]) &&
      nonEmptyString(payload.factId) &&
      nonNegativeSafeInteger(payload.version)
    );
  }
  return false;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
const positiveIntegerParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidParams(`${path} 必须是正安全整数`);
  }
};
const nonNegativeIntegerParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidParams(`${path} 必须是非负安全整数`);
  }
};
const confidenceParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidParams(`${path} 必须是 0 到 1 之间的有限数字`);
  }
};
function boundedNonEmptyStringParam(maxLength: number): RuntimeParamRule {
  return (value, path) => {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
      throw invalidParams(`${path} 必须是长度 1-${maxLength} 的非空字符串`);
    }
  };
}
function nullableParam(rule: RuntimeParamRule): RuntimeParamRule {
  return (value, path) => {
    if (value !== null) rule(value, path);
  };
}
function enumArrayParam<const Values extends readonly string[]>(values: Values): RuntimeParamRule {
  const allowed = new Set(values);
  return (value, path) => {
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string" && allowed.has(item))
    ) {
      throw invalidParams(`${path} 必须是 ${values.join(" | ")} 组成的数组`);
    }
  };
}
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
const stringRecordParam: RuntimeParamRule = (value, path) => {
  if (
    !isJsonObject(value) ||
    !Object.entries(value).every(
      ([key, item]) => key.length > 0 && key.length <= 512 && typeof item === "string",
    )
  ) {
    throw invalidParams(`${path} 必须是字符串键值对象`);
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

const transcriptProjectorVersionParam: RuntimeParamRule = (value, path) => {
  if (value !== TRANSCRIPT_PROJECTOR_VERSION) {
    throw invalidParams(`${path} 必须是 ${TRANSCRIPT_PROJECTOR_VERSION}`);
  }
};

const transcriptWatermarkParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(value, path, {
    historyEpoch: boundedNonEmptyStringParam(512),
    projectorVersion: transcriptProjectorVersionParam,
    throughSequence: nonNegativeIntegerParam,
  });
};

const transcriptPageCursorParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(value, path, {
    historyEpoch: boundedNonEmptyStringParam(512),
    projectorVersion: transcriptProjectorVersionParam,
    throughSequence: nonNegativeIntegerParam,
    positionSequence: nonNegativeIntegerParam,
    positionOrdinal: nonNegativeIntegerParam,
    byteOffset: nonNegativeIntegerParam,
  });
};

const transcriptAdvanceCursorParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(value, path, {
    historyEpoch: boundedNonEmptyStringParam(512),
    projectorVersion: transcriptProjectorVersionParam,
    fromSequence: nonNegativeIntegerParam,
    throughSequence: nonNegativeIntegerParam,
    changeSequence: nonNegativeIntegerParam,
    ordinal: nonNegativeIntegerParam,
    byteOffset: nonNegativeIntegerParam,
  });
};

const interactionModeParam = oneOfParam(["default", "plan", "auto", "yolo"] as const);
const collaborationModeParam = oneOfParam(["agent", "plan"] as const);
const orchestrationModeParam = oneOfParam(["default", "graph"] as const);
const permissionModeParam = oneOfParam(["default", "auto", "yolo"] as const);
const providerProtocolParam = oneOfParam(["openai", "claude"] as const);
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
  assertNestedShape(
    value,
    path,
    {
      kind: oneOfParam(["text"]),
      text: stringParam,
    },
    { attachments: runtimeInputAttachmentsParam },
  );
};

/** 图片附件上限对齐 headless-one-shot-runner（4 张 / 总 256KB 解码后字节）。 */
const MAX_INPUT_ATTACHMENTS = 4;
const MAX_INPUT_ATTACHMENTS_TOTAL_BASE64_CHARS = Math.floor((256 * 1024 * 4) / 3);

const runtimeInputAttachmentsParam: RuntimeParamRule = (value, path) => {
  if (!Array.isArray(value)) throw invalidParams(`${path} 必须是附件数组`);
  if (value.length === 0) throw invalidParams(`${path} 不能为空数组（无附件时省略字段）`);
  if (value.length > MAX_INPUT_ATTACHMENTS) {
    throw invalidParams(`${path} 最多 ${MAX_INPUT_ATTACHMENTS} 张图片`);
  }
  let totalChars = 0;
  for (const [index, item] of value.entries()) {
    assertNestedShape(item, `${path}[${index}]`, {
      type: oneOfParam(["image_base64"]),
      mimeType: boundedNonEmptyStringParam(128),
      data: stringParam,
    });
    const data = isJsonObject(item) && typeof item["data"] === "string" ? item["data"] : "";
    totalChars += data.length;
    if (totalChars > MAX_INPUT_ATTACHMENTS_TOTAL_BASE64_CHARS) {
      throw invalidParams(`${path} 解码后总大小超过 256KB 上限`);
    }
  }
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
      collaborationMode: collaborationModeParam,
      orchestrationMode: orchestrationModeParam,
      permissionMode: permissionModeParam,
      mode: interactionModeParam,
      thinkingEffort: stringParam,
    },
  );
};

const runtimeMcpServerParam: RuntimeParamRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidParams(`${path} 必须是 MCP server 对象`);
  const common = {
    startupTimeoutMs: positiveIntegerParam,
    toolTimeoutMs: positiveIntegerParam,
    enabled: booleanParam,
  } as const;
  if (value["transport"] === "stdio") {
    assertNestedShape(
      value,
      path,
      {
        name: boundedNonEmptyStringParam(256),
        transport: oneOfParam(["stdio"]),
        command: boundedNonEmptyStringParam(4_096),
      },
      { ...common, args: stringArrayParam, env: stringRecordParam },
    );
    return;
  }
  assertNestedShape(
    value,
    path,
    {
      name: boundedNonEmptyStringParam(256),
      transport: oneOfParam(["http", "sse"]),
      url: boundedNonEmptyStringParam(8_192),
    },
    { ...common, headers: stringRecordParam },
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
const memoryKindParam = oneOfParam(["preference", "correction", "project_fact", "reference"]);
const memoryFactStateParam = oneOfParam(["active", "disabled", "archived"]);

function memoryUpdateParams(value: Record<string, unknown>): void {
  exactParamShape(
    {
      workspacePath: stringParam,
      factId: boundedNonEmptyStringParam(512),
      expectedVersion: positiveIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
    {
      kind: memoryKindParam,
      title: boundedNonEmptyStringParam(512),
      content: boundedNonEmptyStringParam(32_000),
      confidence: confidenceParam,
      state: memoryFactStateParam,
      pinned: booleanParam,
      expiresAt: nullableParam(boundedNonEmptyStringParam(128)),
      lastUsedAt: nullableParam(boundedNonEmptyStringParam(128)),
    },
  )(value);
  if (
    !["kind", "title", "content", "confidence", "state", "pinned", "expiresAt", "lastUsedAt"].some(
      (key) => Object.hasOwn(value, key),
    )
  ) {
    throw invalidParams("memory.update 至少需要一个更新字段");
  }
}

function memorySettingsUpdateParams(value: Record<string, unknown>): void {
  exactParamShape(
    {
      workspacePath: stringParam,
      expectedVersion: positiveIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
    {
      enabled: booleanParam,
      autoPropose: booleanParam,
      autoCommit: (candidate, path) => {
        if (candidate !== false) throw invalidParams(`${path} 首版只允许为 false`);
      },
      injectionEnabled: booleanParam,
      reviewMode: oneOfParam(["eco", "balanced", "quality"]),
    },
  )(value);
  if (
    !["enabled", "autoPropose", "autoCommit", "injectionEnabled", "reviewMode"].some((key) =>
      Object.hasOwn(value, key),
    )
  ) {
    throw invalidParams("memory.settings.update 至少需要一个更新字段");
  }
}

function memoryReviewResolveParams(value: Record<string, unknown>): void {
  exactParamShape(
    {
      workspacePath: stringParam,
      proposalId: boundedNonEmptyStringParam(512),
      resolution: oneOfParam(["accepted", "rejected"]),
      expectedVersion: positiveIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
    {
      factId: boundedNonEmptyStringParam(512),
      patch: (candidate, path) => {
        assertNestedShape(
          candidate,
          path,
          {},
          {
            kind: oneOfParam(["preference", "correction", "project_fact", "reference"]),
            title: boundedNonEmptyStringParam(512),
            content: boundedNonEmptyStringParam(32_000),
            reason: boundedNonEmptyStringParam(4_000),
            confidence: confidenceParam,
          },
        );
        if (Object.keys(candidate as Record<string, unknown>).length === 0) {
          throw invalidParams(`${path} 至少需要一个更新字段`);
        }
      },
    },
  )(value);
  if (value["resolution"] === "rejected" && value["patch"] !== undefined) {
    throw invalidParams("params.patch 仅能用于批准建议");
  }
}

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
  "session.pin": workspaceSessionParams,
  "session.unpin": workspaceSessionParams,
  "session.delete": workspaceSessionParams,
  "session.rename": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    title: stringParam,
  }),
  "session.fork": workspaceSessionParams,
  "session.compact": workspaceSessionParams,
  "session.settings.get": workspaceSessionParams,
  "session.context.get": workspaceSessionParams,
  "session.tasks.query": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    {
      taskId: boundedNonEmptyStringParam(512),
      cursor: boundedNonEmptyStringParam(2_048),
      limit: positiveIntegerParam,
      revision: nonNegativeIntegerParam,
    },
  ),
  "session.tasks.command": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      action: oneOfParam(["create", "update"] as const),
      expectedRevision: nonNegativeIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
    {
      taskId: boundedNonEmptyStringParam(512),
      title: boundedNonEmptyStringParam(2_048),
      detail: nullableParam(boundedNonEmptyStringParam(16_000)),
      status: oneOfParam([
        "pending",
        "in_progress",
        "blocked",
        "completed",
        "failed",
        "cancelled",
      ] as const),
    },
  ),
  "session.artifacts.query": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      action: oneOfParam(["list", "get", "read_chunk"] as const),
    },
    {
      artifactId: boundedNonEmptyStringParam(512),
      cursor: boundedNonEmptyStringParam(2_048),
      limit: positiveIntegerParam,
      revision: nonNegativeIntegerParam,
      offsetBytes: nonNegativeIntegerParam,
      limitBytes: positiveIntegerParam,
    },
  ),
  "session.artifacts.command": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      action: oneOfParam(["begin", "append", "commit", "abort", "delete"] as const),
    },
    {
      expectedRevision: nonNegativeIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
      artifactId: boundedNonEmptyStringParam(512),
      ingestId: boundedNonEmptyStringParam(512),
      title: boundedNonEmptyStringParam(2_048),
      mimeType: boundedNonEmptyStringParam(256),
      offsetBytes: nonNegativeIntegerParam,
      contentBase64: boundedNonEmptyStringParam(48_000),
      expectedDigest: boundedNonEmptyStringParam(64),
      expectedSizeBytes: nonNegativeIntegerParam,
    },
  ),
  "session.trace.query": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    {
      throughSequence: nonNegativeIntegerParam,
      afterSequence: nonNegativeIntegerParam,
      limit: positiveIntegerParam,
    },
  ),
  "git.review.snapshot": exactParamShape(
    { workspacePath: stringParam },
    { source: oneOfParam(["branch", "staged", "unstaged"] as const) },
  ),
  "git.review.diff": exactParamShape({
    workspacePath: stringParam,
    path: boundedNonEmptyStringParam(4_096),
    source: oneOfParam(["branch", "staged", "unstaged"] as const),
    expectedRevision: boundedNonEmptyStringParam(512),
  }),
  "browser.agent.lease": exactParamShape(
    {
      sessionId: boundedNonEmptyStringParam(512),
      visible: booleanParam,
      generation: nonNegativeIntegerParam,
    },
    { leaseId: boundedNonEmptyStringParam(512) },
  ),
  "browser.agent.next": exactParamShape(
    {
      sessionId: boundedNonEmptyStringParam(512),
      leaseId: boundedNonEmptyStringParam(512),
    },
    { waitMs: nonNegativeIntegerParam },
  ),
  "browser.agent.resolve": exactParamShape(
    {
      sessionId: boundedNonEmptyStringParam(512),
      leaseId: boundedNonEmptyStringParam(512),
      commandId: boundedNonEmptyStringParam(512),
      ok: booleanParam,
    },
    {
      result: jsonObjectParam,
      error: boundedNonEmptyStringParam(4_000),
    },
  ),
  "terminal.create": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    { cols: positiveIntegerParam, rows: positiveIntegerParam },
  ),
  "terminal.list": workspaceSessionParams,
  "terminal.attach": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      terminalId: boundedNonEmptyStringParam(512),
    },
    { afterSequence: nonNegativeIntegerParam, maxBytes: positiveIntegerParam },
  ),
  "terminal.input": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    terminalId: boundedNonEmptyStringParam(512),
    resourceEpoch: boundedNonEmptyStringParam(512),
    data: boundedNonEmptyStringParam(64 * 1024),
  }),
  "terminal.resize": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    terminalId: boundedNonEmptyStringParam(512),
    resourceEpoch: boundedNonEmptyStringParam(512),
    cols: positiveIntegerParam,
    rows: positiveIntegerParam,
  }),
  "terminal.stop": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    terminalId: boundedNonEmptyStringParam(512),
    resourceEpoch: boundedNonEmptyStringParam(512),
  }),
  "terminal.detach": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    terminalId: boundedNonEmptyStringParam(512),
    resourceEpoch: boundedNonEmptyStringParam(512),
  }),
  "terminal.stopAll": noParams,
  "terminal.resume": noParams,
  "sideChat.create": exactParamShape({
    workspacePath: stringParam,
    sourceSessionId: stringParam,
    panelId: boundedNonEmptyStringParam(512),
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "sideChat.close": workspaceSessionParams,
  "session.directories.add": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    path: boundedNonEmptyStringParam(4_096),
  }),
  "hooks.manage": exactParamShape(
    {
      workspacePath: stringParam,
      action: oneOfParam(["list", "review", "trust", "enable", "disable", "reload"] as const),
    },
    { handlerId: boundedNonEmptyStringParam(256) },
  ),
  "operations.manage": exactParamShape(
    {
      workspacePath: stringParam,
      action: oneOfParam(["list", "show", "retry", "abort"] as const),
    },
    {
      operationId: boundedNonEmptyStringParam(256),
      expectedVersion: positiveIntegerParam,
      reason: boundedNonEmptyStringParam(4_096),
    },
  ),
  "plugin.manage": exactParamShape(
    {
      workspacePath: stringParam,
      action: oneOfParam([
        "list",
        "inspect",
        "install",
        "trust.prepare",
        "trust.confirm",
        "enable",
        "disable",
      ] as const),
    },
    {
      id: boundedNonEmptyStringParam(256),
      scope: oneOfParam(["user", "project", "local"] as const),
      path: boundedNonEmptyStringParam(4_096),
      confirmId: boundedNonEmptyStringParam(256),
      fingerprint: boundedNonEmptyStringParam(512),
    },
  ),
  "session.settings.update": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    {
      modelRouteId: stringParam,
      collaborationMode: collaborationModeParam,
      orchestrationMode: orchestrationModeParam,
      permissionMode: permissionModeParam,
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
      initialSettings: runtimeUserDefaultsParam,
      behavior: sessionBehaviorParam,
      expectedRunId: stringParam,
    },
  ),
  "session.subscription.open": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    { tailLimit: positiveIntegerParam, maxBytes: positiveIntegerParam },
  ),
  "session.subscription.close": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    subscriptionId: boundedNonEmptyStringParam(512),
  }),
  "session.transcript.page": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam, through: transcriptWatermarkParam },
    {
      cursor: transcriptPageCursorParam,
      limit: positiveIntegerParam,
      maxBytes: positiveIntegerParam,
    },
  ),
  "session.transcript.advance": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      after: transcriptWatermarkParam,
      through: transcriptWatermarkParam,
    },
    {
      cursor: transcriptAdvanceCursorParam,
      limit: positiveIntegerParam,
      maxBytes: positiveIntegerParam,
    },
  ),
  "session.evidence.read": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam, evidenceUri: stringParam },
    { offsetBytes: finiteNumberParam, limitBytes: finiteNumberParam },
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
    {
      runId: stringParam,
      sessionId: stringParam,
      reason: stringParam,
      idempotencyKey: stringParam,
    },
  ),
  "plan.respond": (value: Record<string, unknown>) => {
    assertNestedShape(
      value,
      "params",
      {
        workspacePath: stringParam,
        sessionId: stringParam,
        planId: stringParam,
        action: oneOfParam([
          "execute",
          "continue_editing",
          "reject_exit",
          "resume_execution",
          "cancel_execution",
          "replan_execution",
        ]),
        expectedRevision: finiteNumberParam,
        expectedSessionSequence: finiteNumberParam,
        operationId: stringParam,
      },
      { feedback: stringParam },
    );
    if (value["action"] === "continue_editing") {
      const feedback = value["feedback"];
      if (typeof feedback !== "string" || feedback.trim().length === 0) {
        throw invalidParams("params.feedback 在 continue_editing 时为必填字段");
      }
    }
  },
  "prompt.respond": exactParamShape(
    { workspacePath: stringParam, promptId: stringParam, answer: jsonValueParam },
    { runId: stringParam, sessionId: stringParam, idempotencyKey: stringParam },
  ),
  "prompt.cancel": exactParamShape(
    { workspacePath: stringParam, promptId: stringParam },
    { runId: stringParam, sessionId: stringParam, reason: stringParam },
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
  "rewind.apply": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      checkpointId: stringParam,
      expectedFingerprint: stringParam,
    },
    { mode: oneOfParam(["code", "conversation", "both"]) },
  ),
  "rewind.changes": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    checkpointId: stringParam,
  }),
  "rewind.restoreFile": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    checkpointId: stringParam,
    path: stringParam,
    expectedFingerprint: stringParam,
  }),
  "memory.list": exactParamShape(
    { workspacePath: stringParam },
    {
      states: enumArrayParam(["active", "disabled", "archived", "forgotten"]),
      kinds: enumArrayParam(["preference", "correction", "project_fact", "reference"]),
      limit: positiveIntegerParam,
    },
  ),
  "memory.get": exactParamShape({
    workspacePath: stringParam,
    factId: boundedNonEmptyStringParam(512),
  }),
  "memory.create": exactParamShape({
    workspacePath: stringParam,
    text: boundedNonEmptyStringParam(8192),
  }),
  "memory.update": memoryUpdateParams,
  "memory.forget": exactParamShape({
    workspacePath: stringParam,
    factId: boundedNonEmptyStringParam(512),
    expectedVersion: positiveIntegerParam,
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "memory.review.list": exactParamShape(
    { workspacePath: stringParam },
    {
      statuses: enumArrayParam(["pending", "accepted", "rejected", "deleted"]),
      limit: positiveIntegerParam,
    },
  ),
  "memory.review.resolve": memoryReviewResolveParams,
  "memory.settings.get": workspaceParams,
  "memory.settings.update": memorySettingsUpdateParams,
  "memory.context.preview": exactParamShape(
    { workspacePath: stringParam },
    { maxFacts: positiveIntegerParam, maxTokens: positiveIntegerParam },
  ),
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
  "automation.credential.import": exactParamShape({
    workspacePath: stringParam,
    modelRouteId: stringParam,
    expectedCredentialRef: stringParam,
    secret: stringParam,
  }),
  "automation.create": exactParamShape(
    {
      workspacePath: stringParam,
      prompt: stringParam,
      schedule: stringParam,
      modelRouteId: stringParam,
      expectedCredentialRef: stringParam,
      allowedTools: stringArrayParam,
      toolNetworkPolicy: oneOfParam(["allow", "disabled", "allowlist"]),
    },
    {
      name: stringParam,
      timeZone: stringParam,
      allowedToolNetworkHosts: stringArrayParam,
      enabled: booleanParam,
    },
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
  "provider.importEnvironment": exactParamShape({
    provider: runtimeProviderParam,
    defaultModel: stringParam,
    secret: stringParam,
    expectedRevision: stringParam,
  }),
  "provider.delete": exactParamShape({ providerId: stringParam, expectedRevision: stringParam }),
  "provider.credential.status": exactParamShape({ providerId: stringParam }),
  "provider.credential.set": exactParamShape({
    providerId: stringParam,
    secret: stringParam,
    expectedRevision: stringParam,
  }),
  "provider.credential.delete": exactParamShape({
    providerId: stringParam,
    expectedRevision: stringParam,
  }),
  "catalog.agents": workspaceParams,
  "catalog.skills": workspaceParams,
  "config.skills": workspaceParams,
  "config.mcpServers": workspaceParams,
  "skills.user.list": noParams,
  "skills.effective.list": workspaceParams,
  "mcp.user.list": noParams,
  "mcp.user.upsert": exactParamShape({
    server: runtimeMcpServerParam,
    expectedRevision: boundedNonEmptyStringParam(512),
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "mcp.user.delete": exactParamShape({
    serverName: boundedNonEmptyStringParam(256),
    expectedRevision: boundedNonEmptyStringParam(512),
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "mcp.user.setEnabled": exactParamShape({
    serverName: boundedNonEmptyStringParam(256),
    enabled: booleanParam,
    expectedRevision: boundedNonEmptyStringParam(512),
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "mcp.effective.list": workspaceParams,
  "usage.get": exactParamShape(
    { workspacePath: stringParam },
    { sessionId: stringParam, from: finiteNumberParam, to: finiteNumberParam },
  ),
  "workspace.register": workspaceParams,
  "workspace.unregister": workspaceParams,
  "workspace.status": workspaceParams,
  "workspace.list": noParams,
  "workspace.temporary.ensure": noParams,
  "workspace.trust": exactParamShape({
    workspacePath: stringParam,
    trusted: booleanParam,
  }),
  "workspace.trustStatus": workspaceParams,
  "events.replay": exactParamShape(
    { workspacePath: stringParam },
    {
      afterEventId: stringParam,
      highWatermarkEventId: stringParam,
      limit: finiteNumberParam,
    },
  ),
  "events.subscribe": exactParamShape(
    { workspacePath: stringParam },
    { afterEventId: stringParam },
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

type DesktopRuntimeBoundaryMethod = DesktopRuntimeMethod | "events.subscribe";
type RuntimeResultRule = (value: unknown, path: string) => void;
type RuntimeResultShape = Readonly<Record<string, RuntimeResultRule>>;

const resultString: RuntimeResultRule = (value, path) => {
  if (typeof value !== "string") throw invalidResult(`${path} 必须是字符串`);
};
const resultNonEmptyString: RuntimeResultRule = (value, path) => {
  resultString(value, path);
  if ((value as string).length === 0) throw invalidResult(`${path} 不能为空`);
};
const resultBoundedString =
  (maxBytes: number): RuntimeResultRule =>
  (value, path) => {
    resultString(value, path);
    if (new TextEncoder().encode(value as string).byteLength > maxBytes) {
      throw invalidResult(`${path} 超过 ${maxBytes} UTF-8 字节上限`);
    }
  };
const resultBoolean: RuntimeResultRule = (value, path) => {
  if (typeof value !== "boolean") throw invalidResult(`${path} 必须是布尔值`);
};
const resultFiniteNumber: RuntimeResultRule = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidResult(`${path} 必须是有限数字`);
  }
};
const resultNonNegativeNumber: RuntimeResultRule = (value, path) => {
  resultFiniteNumber(value, path);
  if ((value as number) < 0) throw invalidResult(`${path} 不能为负数`);
};
const resultNonNegativeInteger: RuntimeResultRule = (value, path) => {
  resultNonNegativeNumber(value, path);
  if (!Number.isSafeInteger(value)) throw invalidResult(`${path} 必须是安全整数`);
};
const resultPositiveInteger: RuntimeResultRule = (value, path) => {
  resultNonNegativeInteger(value, path);
  if ((value as number) < 1) throw invalidResult(`${path} 必须是正整数`);
};
const transcriptWatermarkResult: RuntimeResultRule = (value, path) => {
  exactResultShape({
    historyEpoch: resultNonEmptyString,
    projectorVersion: resultOneOf([TRANSCRIPT_PROJECTOR_VERSION]),
    throughSequence: resultNonNegativeInteger,
  })(value, path);
};
const transcriptPageCursorResult: RuntimeResultRule = (value, path) => {
  exactResultShape({
    historyEpoch: resultNonEmptyString,
    projectorVersion: resultOneOf([TRANSCRIPT_PROJECTOR_VERSION]),
    throughSequence: resultNonNegativeInteger,
    positionSequence: resultNonNegativeInteger,
    positionOrdinal: resultNonNegativeInteger,
    byteOffset: resultNonNegativeInteger,
  })(value, path);
};
const transcriptAdvanceCursorResult: RuntimeResultRule = (value, path) => {
  exactResultShape({
    historyEpoch: resultNonEmptyString,
    projectorVersion: resultOneOf([TRANSCRIPT_PROJECTOR_VERSION]),
    fromSequence: resultNonNegativeInteger,
    throughSequence: resultNonNegativeInteger,
    changeSequence: resultNonNegativeInteger,
    ordinal: resultNonNegativeInteger,
    byteOffset: resultNonNegativeInteger,
  })(value, path);
};
const resultJsonObject: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path} 必须是 JSON 对象`);
};
const resultStringArray = resultArray(resultString);

function resultOneOf<const Values extends readonly (boolean | number | string)[]>(
  values: Values,
): RuntimeResultRule {
  const allowed = new Set<boolean | number | string>(values);
  return (value, path) => {
    if (
      (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") ||
      !allowed.has(value)
    ) {
      throw invalidResult(`${path} 必须是 ${values.join(" | ")} 之一`);
    }
  };
}

function resultArray(itemRule: RuntimeResultRule): RuntimeResultRule {
  return (value, path) => {
    if (!Array.isArray(value)) throw invalidResult(`${path} 必须是数组`);
    value.forEach((item, index) => itemRule(item, `${path}[${index}]`));
  };
}

function resultShape(
  required: RuntimeResultShape,
  optional: RuntimeResultShape = {},
): RuntimeResultRule {
  return (value, path) => {
    if (!isJsonObject(value)) throw invalidResult(`${path} 必须是 JSON 对象`);
    for (const [key, rule] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) throw invalidResult(`${path}.${key} 为必填字段`);
      rule(value[key], `${path}.${key}`);
    }
    for (const [key, rule] of Object.entries(optional)) {
      if (Object.hasOwn(value, key)) rule(value[key], `${path}.${key}`);
    }
  };
}

function exactResultShape(
  required: RuntimeResultShape,
  optional: RuntimeResultShape = {},
): RuntimeResultRule {
  const validate = resultShape(required, optional);
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  return (value, path) => {
    validate(value, path);
    if (!isJsonObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw invalidResult(`${path} 不允许字段 ${key}`);
    }
  };
}

function resultNullable(rule: RuntimeResultRule): RuntimeResultRule {
  return (value, path) => {
    if (value !== null) rule(value, path);
  };
}

const capabilitySourceMetadataResult = exactResultShape(
  {
    scope: resultOneOf(["user", "project", "plugin"]),
    sourceId: resultString,
    sourceLabel: resultString,
    readOnly: resultBoolean,
    effective: resultBoolean,
  },
  { shadowedBy: resultString },
);

const runtimeScopedSkillResult = exactResultShape(
  {
    name: resultString,
    description: resultString,
    source: capabilitySourceMetadataResult,
  },
  { allowedTools: resultStringArray, model: resultString },
);

const runtimeCapabilityRevisionsResult = exactResultShape({
  user: resultString,
  project: resultString,
});

const runtimeScopedMcpServerResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path} 必须是 MCP server 对象`);
  const common = {
    startupTimeoutMs: resultPositiveInteger,
    toolTimeoutMs: resultPositiveInteger,
    enabled: resultBoolean,
  } as const;
  if (value["transport"] === "stdio") {
    exactResultShape(
      {
        name: resultString,
        transport: resultOneOf(["stdio"]),
        commandLabel: resultCommandLabel,
        hasArguments: resultBoolean,
        source: capabilitySourceMetadataResult,
      },
      { ...common, envKeys: resultStringArray },
    )(value, path);
    return;
  }
  exactResultShape(
    {
      name: resultString,
      transport: resultOneOf(["http", "sse"]),
      endpointLabel: resultEndpointLabel,
      source: capabilitySourceMetadataResult,
    },
    { ...common, headerKeys: resultStringArray },
  )(value, path);
};

const resultCommandLabel: RuntimeResultRule = (value, path) => {
  resultString(value, path);
  const label = value as string;
  if (!label || label === "." || label === ".." || /[\\/]/u.test(label)) {
    throw invalidResult(`${path} 必须是不含路径的可执行文件名`);
  }
};

const resultEndpointLabel: RuntimeResultRule = (value, path) => {
  resultString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(value as string);
  } catch {
    throw invalidResult(`${path} 必须是安全的 HTTP(S) endpoint 摘要`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    value !== parsed.origin
  ) {
    throw invalidResult(`${path} 只能包含 HTTP(S) origin`);
  }
};

const memoryFactResult = exactResultShape(
  {
    factId: resultString,
    kind: resultOneOf(["preference", "correction", "project_fact", "reference"]),
    title: resultNullable(resultString),
    content: resultNullable(resultString),
    confidence: resultFiniteNumber,
    state: resultOneOf(["active", "disabled", "archived", "forgotten"]),
    pinned: resultBoolean,
    version: resultFiniteNumber,
    createdAt: resultString,
    updatedAt: resultString,
  },
  {
    sourceId: resultString,
    source: exactResultShape(
      {
        sourceId: resultString,
        sessionId: resultString,
        availability: resultOneOf(["available", "unavailable"]),
        createdAt: resultString,
        updatedAt: resultString,
      },
      {
        branchId: resultString,
        invalidatedAt: resultString,
        invalidationCode: resultString,
      },
    ),
    expiresAt: resultString,
    lastUsedAt: resultString,
    forgottenAt: resultString,
  },
);

const memoryProposalResult = exactResultShape(
  {
    proposalId: resultString,
    kind: resultOneOf(["preference", "correction", "project_fact", "reference"]),
    title: resultNullable(resultString),
    content: resultNullable(resultString),
    reason: resultNullable(resultString),
    confidence: resultFiniteNumber,
    status: resultOneOf(["pending", "accepted", "rejected", "deleted"]),
    conflictStatus: resultOneOf(["none", "potential", "confirmed", "resolved"]),
    version: resultFiniteNumber,
    createdAt: resultString,
    updatedAt: resultString,
  },
  {
    sourceId: resultString,
    conflictFactId: resultString,
    resolvedFactId: resultString,
    reviewedAt: resultString,
    deletedAt: resultString,
  },
);

const memorySettingsResult = exactResultShape({
  enabled: resultBoolean,
  autoPropose: resultBoolean,
  autoCommit: resultBoolean,
  injectionEnabled: resultBoolean,
  reviewMode: resultOneOf(["eco", "balanced", "quality"]),
  version: resultFiniteNumber,
  updatedAt: resultString,
});

const memoryReviewBudgetResult = exactResultShape(
  {
    mode: resultOneOf(["eco", "balanced", "quality"]),
    allowed: resultBoolean,
    reason: resultOneOf(["available", "eco-mode", "budget-exhausted"]),
    calls: resultNonNegativeInteger,
    inputTokens: resultNonNegativeInteger,
    outputTokens: resultNonNegativeInteger,
    costUsd: resultNonNegativeNumber,
    maxCalls: resultNonNegativeInteger,
    maxInputTokens: resultNonNegativeInteger,
    maxOutputTokens: resultNonNegativeInteger,
    maxCostUsd: resultNonNegativeNumber,
  },
  { nextRecoveryAt: resultString },
);

const runtimeSessionResult = resultShape({
  sessionId: resultString,
  workspacePath: resultString,
  title: resultString,
  status: resultOneOf(["active", "archived"]),
  pinned: resultBoolean,
  createdAt: resultFiniteNumber,
  updatedAt: resultFiniteNumber,
});

const runtimeSessionTaskResult = exactResultShape(
  {
    taskId: resultNonEmptyString,
    title: resultNonEmptyString,
    status: resultOneOf(["pending", "in_progress", "blocked", "completed", "failed", "cancelled"]),
    ordinal: resultNonNegativeInteger,
    version: resultPositiveInteger,
    createdAt: resultFiniteNumber,
    updatedAt: resultFiniteNumber,
  },
  { detail: resultString },
);

const runtimeGitReviewFileResult = exactResultShape({
  path: resultNonEmptyString,
  status: resultOneOf(["added", "modified", "deleted", "renamed", "untracked"]),
  additions: resultNonNegativeInteger,
  deletions: resultNonNegativeInteger,
});

const runtimeTerminalSessionResult = exactResultShape(
  {
    terminalId: resultNonEmptyString,
    workspacePath: resultNonEmptyString,
    sessionId: resultNonEmptyString,
    resourceEpoch: resultNonEmptyString,
    sequence: resultNonNegativeInteger,
    status: resultOneOf(["starting", "running", "interrupted", "exited"]),
    capability: resultOneOf(["pty", "pipe"]),
    resizeSupported: resultBoolean,
    createdAt: resultFiniteNumber,
    updatedAt: resultFiniteNumber,
  },
  { exitCode: resultFiniteNumber },
);

const runtimeBrowserAgentCommandResult = exactResultShape({
  commandId: resultNonEmptyString,
  sessionId: resultNonEmptyString,
  action: resultOneOf(["navigate", "back", "forward", "reload", "get_state", "click", "type"]),
  input: resultJsonObject,
  createdAt: resultFiniteNumber,
  expiresAt: resultFiniteNumber,
});

const runtimeRunStatusResult = resultOneOf([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancelling",
  "cancelled",
  "failed",
  "succeeded",
]);

const runtimeRunResult = resultShape(
  {
    runId: resultString,
    workspacePath: resultString,
    description: resultString,
    status: runtimeRunStatusResult,
    startedAt: resultFiniteNumber,
    updatedAt: resultFiniteNumber,
    version: resultFiniteNumber,
  },
  { sessionId: resultString, finishedAt: resultFiniteNumber, error: resultString },
);

const runtimeWorkspaceInitResult = exactResultShape({
  workspacePath: resultString,
  files: resultArray(
    exactResultShape({
      path: resultOneOf(["AGENTS.md", ".pico/config.json"]),
      status: resultOneOf(["created", "existing"]),
    }),
  ),
  message: resultString,
});

const runtimeDiagnosticCheckResult = exactResultShape(
  {
    id: resultString,
    label: resultString,
    status: resultOneOf(["ok", "warning", "error", "unavailable"]),
    summary: resultString,
  },
  { recommendation: resultString },
);

const runtimeDiagnosticsResult = exactResultShape({
  workspacePath: resultString,
  healthy: resultBoolean,
  checks: resultArray(runtimeDiagnosticCheckResult),
  output: resultString,
});

const runtimePluginDiagnosticResult = exactResultShape(
  {
    pluginId: resultString,
    sourcePath: resultString,
    message: resultString,
  },
  {
    code: resultString,
    scope: resultOneOf(["user", "project", "local"]),
    severity: resultOneOf(["error", "warning", "info"]),
    compatibility: resultOneOf(["compatible", "degraded", "blocked"]),
  },
);

const runtimeResourceDiagnosticsResult = exactResultShape(
  {
    workDir: resultString,
    picoHome: resultString,
    workspaceStateRoot: resultString,
    entries: resultArray(
      exactResultShape(
        {
          kind: resultString,
          origin: resultOneOf(["claude-compat", "legacy", "pico-native", "runtime-state"]),
          path: resultString,
          status: resultOneOf(["missing", "present", "unsafe"]),
          authority: resultBoolean,
        },
        { reason: resultString },
      ),
    ),
    findings: resultStringArray,
    output: resultString,
  },
  { pluginDiagnostics: resultArray(runtimePluginDiagnosticResult) },
);

const runtimeSessionSettingsResult = exactResultShape(
  {
    sessionId: resultString,
    provider: resultOneOf(["openai", "claude"]),
    model: resultString,
    collaborationMode: resultOneOf(["agent", "plan"]),
    orchestrationMode: resultOneOf(["default", "graph"]),
    permissionMode: resultOneOf(["default", "auto", "yolo"]),
    thinkingEffort: resultString,
    thinkingEffortExplicit: resultBoolean,
    reasoningLevels: resultStringArray,
  },
  { modelRouteId: resultString, additionalDirectories: resultStringArray },
);

const runtimeGoalBudgetConfigResult = exactResultShape(
  {},
  {
    maxTurns: resultFiniteNumber,
    maxTokens: resultFiniteNumber,
    maxCostCNY: resultFiniteNumber,
    maxWallClockMs: resultFiniteNumber,
  },
);

const runtimeGoalResult = exactResultShape(
  {
    id: resultString,
    title: resultString,
    description: resultString,
    status: resultOneOf(["active", "paused", "blocked", "complete"]),
    createdAt: resultFiniteNumber,
    budgetUsage: exactResultShape({
      turns: resultFiniteNumber,
      tokens: resultFiniteNumber,
      costCNY: resultFiniteNumber,
      startedAt: resultFiniteNumber,
    }),
  },
  {
    budgetConfig: runtimeGoalBudgetConfigResult,
    progress: resultString,
    blockedReason: resultString,
  },
);

const runtimeGoalSnapshotResult = exactResultShape({
  stateVersion: resultOneOf([1]),
  sequence: resultFiniteNumber,
  activeGoalId: resultNullable(resultString),
  goals: resultArray(runtimeGoalResult),
});

const runtimePlanStepResult = resultShape(
  {
    id: resultString,
    title: resultString,
    description: resultString,
    status: resultOneOf(["pending", "in_progress", "completed", "skipped"]),
  },
  { note: resultString },
);

const runtimePlanProposalResult = resultShape(
  {
    planId: resultString,
    revision: resultFiniteNumber,
    title: resultString,
    steps: resultArray(runtimePlanStepResult),
    status: resultOneOf(["pending", "stale", "approved", "rejected"]),
    proposedAt: resultString,
  },
  { overview: resultString, risks: resultStringArray },
);

const runtimePlanProjectionResult = resultShape(
  {
    sessionId: resultString,
    sessionSequence: resultFiniteNumber,
    proposals: resultArray(runtimePlanProposalResult),
  },
  {
    latestProposal: runtimePlanProposalResult,
    pendingProposal: runtimePlanProposalResult,
  },
);

const runtimeJobResult = resultShape({
  jobId: resultString,
  workspacePath: resultString,
  name: resultString,
  prompt: resultString,
  schedule: resultString,
  enabled: resultBoolean,
  status: resultOneOf(["idle", "running", "failed", "succeeded"]),
  updatedAt: resultFiniteNumber,
});

const runtimeProviderInputResult = resultShape(
  {
    id: resultString,
    protocol: resultOneOf(["openai", "claude"]),
    baseURL: resultString,
    apiKeyEnv: resultString,
    models: resultStringArray,
    discoverModels: resultBoolean,
  },
  { modelCapabilities: resultJsonObject },
);

const runtimeProviderProfileResult = resultShape(
  {
    id: resultString,
    protocol: resultOneOf(["openai", "claude"]),
    baseURL: resultString,
    apiKeyEnv: resultString,
    models: resultStringArray,
    discoverModels: resultBoolean,
    origin: resultOneOf(["user", "project-legacy", "environment"]),
    fingerprint: resultString,
    credentialStatus: resultOneOf(["ready", "missing", "environment", "unsupported"]),
    credentialSource: resultOneOf(["config", "keychain", "environment", "none"]),
    storedCredentialPresent: resultBoolean,
  },
  { modelCapabilities: resultJsonObject },
);

const runtimeUserDefaultsResult = exactResultShape(
  {},
  {
    modelRouteId: resultString,
    collaborationMode: resultOneOf(["agent", "plan"]),
    orchestrationMode: resultOneOf(["default", "graph"]),
    permissionMode: resultOneOf(["default", "auto", "yolo"]),
    mode: resultOneOf(["default", "plan", "auto", "yolo"]),
    thinkingEffort: resultString,
  },
);

const runtimeUserConfigResult = resultShape({
  version: resultOneOf([1]),
  defaults: runtimeUserDefaultsResult,
  providers: resultArray(runtimeProviderInputResult),
});

const runtimeEffectiveConfigResult = resultShape(
  {
    providers: resultArray(runtimeProviderProfileResult),
    sources: resultJsonObject,
    revisions: exactResultShape({ user: resultString, project: resultString }),
  },
  { defaultModelRouteId: resultString },
);

const runtimeCatalogAgentResult = resultShape(
  {
    name: resultString,
    description: resultString,
    source: resultString,
    sourcePath: resultString,
    tools: resultStringArray,
  },
  { modelRouteId: resultString },
);

const runtimeCatalogSkillResult = resultShape(
  { name: resultString, description: resultString },
  { sourcePath: resultString, allowedTools: resultStringArray, model: resultString },
);

const workspaceStatusResultRule = resultShape(
  {
    workspacePath: resultString,
    registered: resultBoolean,
    schedulerStatus: resultOneOf(["unknown"]),
    mode: resultOneOf(["folder", "git"]),
    branch: resultString,
    capabilities: resultShape({
      foregroundRuns: resultBoolean,
      fileHistory: resultBoolean,
      isolatedWorktrees: resultBoolean,
      branchMerge: resultBoolean,
    }),
  },
  {
    temporary: resultOneOf([true]),
    eventLog: resultNullable(
      resultShape({
        logicalBytes: resultNonNegativeInteger,
        hardLimitBytes: resultNonNegativeInteger,
        lowWatermarkBytes: resultNonNegativeInteger,
        status: resultOneOf(["within_limit", "retention_required", "quota_blocked"]),
        canStartNewWork: resultBoolean,
        canWriteClosure: resultBoolean,
        plannedSessionCount: resultNonNegativeInteger,
        estimatedLogicalBytesReclaimed: resultNonNegativeInteger,
      }),
    ),
  },
);

const temporaryWorkspaceStatusResultRule: RuntimeResultRule = (value, path) => {
  workspaceStatusResultRule(value, path);
  if (isJsonObject(value)) resultOneOf([true])(value["temporary"], `${path}.temporary`);
};

const runtimeToolResultEnvelopeResult: RuntimeResultRule = (value, path) => {
  exactResultShape(
    {
      version: resultOneOf([1]),
      toolCallId: resultNonEmptyString,
      toolName: resultNonEmptyString,
      status: resultOneOf(["succeeded", "failed", "rejected", "cancelled", "interrupted"]),
      rawSizeBytes: resultNonNegativeInteger,
      sha256: resultString,
      deliveryTruncated: resultBoolean,
      projection: resultJsonObject,
    },
    {
      evidence: resultJsonObject,
    },
  )(value, path);
  if (!isJsonObject(value)) return;
  if (!/^[a-f0-9]{64}$/u.test(String(value["sha256"]))) {
    throw invalidResult(`${path}.sha256 必须是 SHA-256`);
  }
  const projection = value["projection"];
  exactResultShape({
    version: resultOneOf([1]),
    mode: resultOneOf(["full", "preview", "synthetic"]),
    text: resultString,
    strategy: resultNonEmptyString,
    truncated: resultBoolean,
  })(projection, `${path}.projection`);
  if (
    isJsonObject(projection) &&
    typeof projection["text"] === "string" &&
    Buffer.byteLength(projection["text"], "utf8") > MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES
  ) {
    throw invalidResult(
      `${path}.projection.text 超过 ${MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES} 字节上限`,
    );
  }
  if (
    isJsonObject(projection) &&
    projection["mode"] === "synthetic" &&
    (value["status"] === "succeeded" || value["status"] === "failed")
  ) {
    throw invalidResult(`${path}.projection.mode 与 status 不兼容`);
  }

  const evidence = value["evidence"];
  if (evidence === undefined) return;
  exactResultShape({ uri: resultString, ref: resultJsonObject })(evidence, `${path}.evidence`);
  if (!isJsonObject(evidence)) return;
  const reference = evidence["ref"];
  exactResultShape({
    schemaVersion: resultOneOf([2]),
    contentHash: resultString,
    sessionId: resultNonEmptyString,
    kind: resultOneOf(["tool-exchange"]),
  })(reference, `${path}.evidence.ref`);
  if (!isJsonObject(reference) || !/^[a-f0-9]{64}$/u.test(String(reference["contentHash"]))) {
    throw invalidResult(`${path}.evidence.ref.contentHash 必须是 SHA-256`);
  }
  const expectedUri = `pico://evidence/${encodeURIComponent(
    String(reference["sessionId"]),
  )}/${String(reference["contentHash"])}`;
  if (evidence["uri"] !== expectedUri) {
    throw invalidResult(`${path}.evidence.uri 与 ref 不一致`);
  }
};

const runtimeConversationItemResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path} 必须是对象`);
  const kind = value["kind"];
  resultShape(
    {
      id: resultString,
      kind: resultOneOf([
        "userMessage",
        "assistantMessage",
        "systemNotice",
        "error",
        "thinking",
        "skill",
        "plan",
        "tool",
        "runBoundary",
        "approval",
        "prompt",
        "changes",
        "subagent",
        "goal",
      ]),
    },
    {
      at: resultFiniteNumber,
      truncated: resultOneOf([true]),
      originalBytes: resultFiniteNumber,
    },
  )(value, path);
  if (kind === "userMessage" || kind === "systemNotice" || kind === "error") {
    resultShape({ content: resultString })(value, path);
    return;
  }
  if (kind === "assistantMessage" || kind === "thinking") {
    resultShape({ content: resultString }, { runId: resultString, turnId: resultString })(
      value,
      path,
    );
    return;
  }
  if (kind === "skill") {
    resultShape({
      name: resultString,
      args: resultString,
      trigger: resultOneOf(["user-slash", "model-tool"]),
    })(value, path);
    return;
  }
  if (
    kind === "plan" ||
    ["approval", "prompt", "changes", "subagent", "goal"].includes(String(kind))
  ) {
    resultShape(
      { title: resultString },
      {
        detail: resultString,
        state: resultString,
        ...(kind === "subagent" ? { name: resultString } : {}),
      },
    )(value, path);
    return;
  }
  if (kind === "tool") {
    exactResultShape(
      {
        id: resultString,
        kind: resultOneOf(["tool"]),
        name: resultString,
        args: resultString,
        status: resultOneOf(["running", "success", "error"]),
      },
      {
        summary: resultString,
        result: runtimeToolResultEnvelopeResult,
        at: resultFiniteNumber,
        truncated: resultOneOf([true]),
        originalBytes: resultNonNegativeInteger,
      },
    )(value, path);
    return;
  }
  if (kind === "runBoundary") {
    resultShape(
      { status: runtimeRunStatusResult, startedAt: resultFiniteNumber },
      { runId: resultString, finishedAt: resultFiniteNumber, error: resultString },
    )(value, path);
    return;
  }
};

const transcriptItemRecordResult: RuntimeResultRule = exactResultShape({
  itemId: resultNonEmptyString,
  itemRevision: resultPositiveInteger,
  positionSequence: resultNonNegativeInteger,
  positionOrdinal: resultNonNegativeInteger,
  item: runtimeConversationItemResult,
});

const transcriptItemFragmentResult: RuntimeResultRule = (value, path) => {
  exactResultShape({
    itemId: resultNonEmptyString,
    itemRevision: resultPositiveInteger,
    positionSequence: resultNonNegativeInteger,
    positionOrdinal: resultNonNegativeInteger,
    byteOffset: resultNonNegativeInteger,
    byteLength: resultPositiveInteger,
    totalBytes: resultPositiveInteger,
    json: resultString,
  })(value, path);
  const fragment = value as RuntimeTranscriptItemFragment;
  if (fragment.byteOffset + fragment.byteLength > fragment.totalBytes) {
    throw invalidResult(`${path} 字节范围超过完整 item JSON`);
  }
  if (new TextEncoder().encode(fragment.json).byteLength !== fragment.byteLength) {
    throw invalidResult(`${path}.byteLength 与 UTF-8 JSON 分片不一致`);
  }
};

const transcriptChangeResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path} 必须是 transcript change 对象`);
  if (value["op"] === "upsert") {
    exactResultShape({ op: resultOneOf(["upsert"]), record: transcriptItemRecordResult })(
      value,
      path,
    );
    return;
  }
  exactResultShape({
    op: resultOneOf(["remove"]),
    itemId: resultNonEmptyString,
    itemRevision: resultPositiveInteger,
  })(value, path);
};

const activeOverlayEntryResult: RuntimeResultRule = exactResultShape(
  {
    runId: resultNonEmptyString,
    turnId: resultNonEmptyString,
    itemId: resultNonEmptyString,
    streamId: resultNonEmptyString,
    kind: resultOneOf(["text", "thinking", "toolOutput"]),
    startOffsetBytes: resultNonNegativeInteger,
    endOffsetBytes: resultNonNegativeInteger,
    text: resultString,
    anchorSequence: resultNonNegativeInteger,
  },
  {
    stream: resultOneOf(["stdout", "stderr"]),
    truncatedBeforeBytes: resultNonNegativeInteger,
    complete: resultOneOf([true]),
  },
);

const runtimeQueuedInputResult = exactResultShape({
  queueId: resultString,
  sessionId: resultString,
  input: (value, path) => {
    if (!isJsonObject(value)) throw invalidResult(`${path} 必须是用户输入对象`);
    if (value["kind"] === "text") {
      exactResultShape({
        kind: resultOneOf(["text"]),
        text: resultString,
      })(value, path);
      return;
    }
    if (value["kind"] === "skill") {
      exactResultShape(
        {
          kind: resultOneOf(["skill"]),
          name: resultString,
        },
        { args: resultString },
      )(value, path);
      return;
    }
    if (value["kind"] === "agent") {
      exactResultShape({
        kind: resultOneOf(["agent"]),
        name: resultString,
        task: resultString,
      })(value, path);
      return;
    }
    throw invalidResult(`${path}.kind 必须是 text | skill | agent 之一`);
  },
  createdAt: resultFiniteNumber,
});

const runtimeChangeResult = resultShape({
  path: resultString,
  status: resultOneOf(["added", "modified", "deleted", "renamed"]),
  additions: resultFiniteNumber,
  deletions: resultFiniteNumber,
});

const runtimeNotificationResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value) || !isRuntimeNotification(value)) {
    throw invalidResult(`${path} 不是有效的 Runtime event`);
  }
};

const durableRuntimeNotificationResult: RuntimeResultRule = (value, path) => {
  runtimeNotificationResult(value, path);
  if (isJsonObject(value) && isEphemeralRuntimeNotificationTopic(String(value["topic"] ?? ""))) {
    throw invalidResult(`${path} 不能包含 ephemeral Runtime event`);
  }
};

const runtimePingResult: RuntimeResultRule = (value, path) => {
  resultShape({
    pong: resultOneOf([true]),
    protocolVersion: resultOneOf([LOCAL_RUNTIME_PROTOCOL_VERSION]),
    desktopSchemaRevision: resultFiniteNumber,
    capabilities: resultStringArray,
    picoHome: resultString,
  })(value, path);
  if (!isJsonObject(value)) return;
  const capabilities = value["capabilities"];
  if (
    value["desktopSchemaRevision"] !== DESKTOP_RUNTIME_SCHEMA_REVISION ||
    !Array.isArray(capabilities) ||
    !capabilities.includes(DESKTOP_RUNTIME_SCHEMA_CAPABILITY) ||
    !capabilities.includes(CAPABILITY_SCOPE_RUNTIME_CAPABILITY) ||
    !capabilities.includes(TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY)
  ) {
    throw protocolError(
      RUNTIME_ERROR_CODES.VERSION_MISMATCH,
      `Desktop 需要 Runtime schema v${DESKTOP_RUNTIME_SCHEMA_REVISION}，请完全退出并重新启动 Pico`,
    );
  }
};

const RUNTIME_RESULT_VALIDATORS = {
  "runtime.ping": runtimePingResult,
  "workspace.init": runtimeWorkspaceInitResult,
  "diagnostics.run": runtimeDiagnosticsResult,
  "diagnostics.resources": runtimeResourceDiagnosticsResult,
  "workspace.list": resultShape({ workspaces: resultArray(workspaceStatusResultRule) }),
  "workspace.status": workspaceStatusResultRule,
  "workspace.temporary.ensure": temporaryWorkspaceStatusResultRule,
  "workspace.register": resultShape({
    workspacePath: resultString,
    registered: resultOneOf([true]),
  }),
  "workspace.trustStatus": resultShape({ workspacePath: resultString, trusted: resultBoolean }),
  "session.list": resultShape({ sessions: resultArray(runtimeSessionResult) }),
  "session.get": exactResultShape({ session: runtimeSessionResult }),
  "session.create": exactResultShape({ session: runtimeSessionResult }),
  "session.archive": exactResultShape({ session: runtimeSessionResult }),
  "session.restore": exactResultShape({ session: runtimeSessionResult }),
  "session.pin": exactResultShape({ session: runtimeSessionResult }),
  "session.unpin": exactResultShape({ session: runtimeSessionResult }),
  "session.delete": exactResultShape(
    { sessionId: resultString, deleted: resultOneOf([true]) },
    { closedSessionIds: resultStringArray },
  ),
  "session.rename": exactResultShape({ session: runtimeSessionResult }),
  "session.compact": exactResultShape({
    session: runtimeSessionResult,
    compacted: resultOneOf([true]),
    beforeMessageCount: resultFiniteNumber,
    afterMessageCount: resultFiniteNumber,
  }),
  "session.settings.get": exactResultShape({ settings: runtimeSessionSettingsResult }),
  "session.context.get": exactResultShape({ context: resultJsonObject }),
  "session.tasks.query": exactResultShape(
    { revision: resultNonNegativeInteger, tasks: resultArray(runtimeSessionTaskResult) },
    { nextCursor: resultNonEmptyString },
  ),
  "session.tasks.command": exactResultShape({
    revision: resultNonNegativeInteger,
    task: runtimeSessionTaskResult,
  }),
  "session.artifacts.query": resultJsonObject,
  "session.artifacts.command": resultJsonObject,
  "session.trace.query": exactResultShape(
    { throughSequence: resultNonNegativeInteger, events: resultArray(resultJsonObject) },
    { nextAfterSequence: resultNonNegativeInteger },
  ),
  "git.review.snapshot": exactResultShape({
    revision: resultNonEmptyString,
    branch: resultString,
    source: resultOneOf(["branch", "staged", "unstaged"]),
    files: resultArray(runtimeGitReviewFileResult),
    truncated: resultBoolean,
  }),
  "git.review.diff": exactResultShape({
    path: resultNonEmptyString,
    source: resultOneOf(["branch", "staged", "unstaged"]),
    revision: resultNonEmptyString,
    patch: resultBoundedString(512 * 1024),
    truncated: resultBoolean,
  }),
  "browser.agent.lease": exactResultShape({
    leaseId: resultNonEmptyString,
    expiresAt: resultFiniteNumber,
    visible: resultBoolean,
  }),
  "browser.agent.next": exactResultShape({
    command: resultNullable(runtimeBrowserAgentCommandResult),
  }),
  "browser.agent.resolve": exactResultShape({ accepted: resultOneOf([true]) }),
  "terminal.create": exactResultShape({
    terminal: runtimeTerminalSessionResult,
    resourceEpoch: resultNonEmptyString,
    sequence: resultNonNegativeInteger,
    snapshot: resultBoundedString(256 * 1024),
    truncated: resultBoolean,
  }),
  "terminal.list": exactResultShape({ terminals: resultArray(runtimeTerminalSessionResult) }),
  "terminal.attach": exactResultShape({
    terminal: runtimeTerminalSessionResult,
    resourceEpoch: resultNonEmptyString,
    sequence: resultNonNegativeInteger,
    snapshot: resultBoundedString(256 * 1024),
    truncated: resultBoolean,
  }),
  "terminal.input": exactResultShape({
    accepted: resultOneOf([true]),
    sequence: resultNonNegativeInteger,
  }),
  "terminal.resize": exactResultShape({
    resized: resultOneOf([true]),
    sequence: resultNonNegativeInteger,
  }),
  "terminal.stop": exactResultShape({ terminal: runtimeTerminalSessionResult }),
  "terminal.detach": exactResultShape({ detached: resultOneOf([true]) }),
  "terminal.stopAll": exactResultShape({ stopped: resultNonNegativeInteger }),
  "terminal.resume": exactResultShape({ accepting: resultOneOf([true]) }),
  "sideChat.create": exactResultShape({
    session: runtimeSessionResult,
    sourceSessionId: resultNonEmptyString,
    throughEventId: resultNonEmptyString,
  }),
  "sideChat.close": exactResultShape({ cleanupScheduled: resultOneOf([true]) }),
  "session.settings.update": exactResultShape({ settings: runtimeSessionSettingsResult }),
  "session.directories.add": exactResultShape({
    directories: resultStringArray,
    added: resultBoolean,
  }),
  "hooks.manage": exactResultShape({ result: resultJsonObject }),
  "operations.manage": exactResultShape({ result: resultJsonObject }),
  "plugin.manage": exactResultShape({ result: resultJsonObject }),
  "goal.get": exactResultShape({ goal: resultNullable(runtimeGoalSnapshotResult) }),
  "session.fork": resultShape({ session: runtimeSessionResult, sourceSessionId: resultString }),
  "session.send": resultShape(
    {
      session: runtimeSessionResult,
      disposition: resultOneOf(["started", "steered", "queued", "replaced"]),
    },
    { run: runtimeRunResult },
  ),
  "session.subscription.open": exactResultShape(
    {
      session: runtimeSessionResult,
      hostEpoch: resultNonEmptyString,
      subscriptionId: resultNonEmptyString,
      nextSequence: resultPositiveInteger,
      watermark: transcriptWatermarkResult,
      durableTail: resultArray(transcriptItemRecordResult),
      activeOverlay: resultArray(activeOverlayEntryResult),
      queuedInputs: resultArray(runtimeQueuedInputResult),
    },
    {
      activeRun: runtimeRunResult,
      durableTailFragments: resultArray(transcriptItemFragmentResult),
      olderCursor: transcriptPageCursorResult,
      continuityDegradedReason: resultOneOf(["partial_persistence_failed", "recovery_failed"]),
    },
  ),
  "session.subscription.close": exactResultShape({ closed: resultOneOf([true]) }),
  "session.transcript.page": exactResultShape(
    {
      watermark: transcriptWatermarkResult,
      items: resultArray(transcriptItemRecordResult),
    },
    {
      fragments: resultArray(transcriptItemFragmentResult),
      nextCursor: transcriptPageCursorResult,
    },
  ),
  "session.transcript.advance": exactResultShape(
    {
      after: transcriptWatermarkResult,
      through: transcriptWatermarkResult,
      changes: resultArray(transcriptChangeResult),
    },
    {
      fragments: resultArray(transcriptItemFragmentResult),
      nextCursor: transcriptAdvanceCursorResult,
    },
  ),
  "session.evidence.read": resultShape(
    {
      evidenceUri: resultString,
      content: resultString,
      offsetBytes: resultNonNegativeInteger,
      endOffsetBytes: resultNonNegativeInteger,
      totalBytes: resultNonNegativeInteger,
      limitBytes: resultNonNegativeInteger,
      truncated: resultBoolean,
    },
    { nextOffsetBytes: resultNonNegativeInteger },
  ),
  "run.start": runtimeRunResult,
  "run.cancel": runtimeRunResult,
  "run.pause": runtimeRunResult,
  "run.resume": runtimeRunResult,
  "run.steer": runtimeRunResult,
  "runs.list": resultShape({ runs: resultArray(runtimeRunResult) }),
  "approval.respond": exactResultShape({
    accepted: resultBoolean,
    alreadyResolved: resultBoolean,
  }),
  "plan.respond": exactResultShape(
    { accepted: resultBoolean, projection: runtimePlanProjectionResult },
    { run: runtimeRunResult },
  ),
  "prompt.respond": exactResultShape({
    accepted: resultBoolean,
    alreadyResolved: resultBoolean,
  }),
  "prompt.cancel": exactResultShape({ cancelled: resultBoolean }),
  "changes.list": resultShape({
    changes: resultArray(runtimeChangeResult),
    fingerprint: resultString,
  }),
  "changes.diff": resultShape({
    path: resultString,
    patch: resultString,
    truncated: resultBoolean,
    fingerprint: resultString,
  }),
  "changes.review": exactResultShape({ accepted: resultBoolean, fingerprint: resultString }),
  "changes.apply": exactResultShape({ applied: resultBoolean, fingerprint: resultString }),
  "rewind.list": exactResultShape({
    checkpoints: resultArray(
      resultShape({
        checkpointId: resultString,
        label: resultString,
        createdAt: resultFiniteNumber,
      }),
    ),
  }),
  "rewind.preview": exactResultShape({
    checkpointId: resultString,
    changes: resultArray(runtimeChangeResult),
    fingerprint: resultString,
  }),
  "rewind.apply": exactResultShape({ applied: resultBoolean, sessionId: resultString }),
  "rewind.changes": exactResultShape(
    {
      checkpointId: resultString,
      files: resultArray(
        resultShape({
          path: resultString,
          status: resultOneOf(["created", "deleted", "modified"]),
          additions: resultFiniteNumber,
          deletions: resultFiniteNumber,
          fingerprint: resultString,
          patch: resultString,
          truncated: resultBoolean,
        }),
      ),
      addedLines: resultFiniteNumber,
      removedLines: resultFiniteNumber,
    },
    { partial: resultBoolean, warnings: resultStringArray },
  ),
  "rewind.restoreFile": exactResultShape({
    restored: resultBoolean,
    path: resultString,
    status: resultOneOf(["created", "deleted", "modified"]),
  }),
  "memory.list": exactResultShape({ facts: resultArray(memoryFactResult) }),
  "memory.get": exactResultShape({ fact: memoryFactResult }),
  "memory.create": exactResultShape({ fact: memoryFactResult }),
  "memory.update": exactResultShape({ fact: memoryFactResult }),
  "memory.forget": exactResultShape({ fact: memoryFactResult }),
  "memory.review.list": exactResultShape({ proposals: resultArray(memoryProposalResult) }),
  "memory.review.resolve": exactResultShape(
    { proposal: memoryProposalResult },
    { fact: memoryFactResult },
  ),
  "memory.settings.get": exactResultShape({
    settings: memorySettingsResult,
    reviewBudget: memoryReviewBudgetResult,
  }),
  "memory.settings.update": exactResultShape({
    settings: memorySettingsResult,
    reviewBudget: memoryReviewBudgetResult,
  }),
  "memory.context.preview": exactResultShape({
    facts: resultArray(memoryFactResult),
    budget: exactResultShape({
      maxFacts: resultFiniteNumber,
      maxTokens: resultFiniteNumber,
      usedFacts: resultFiniteNumber,
      usedTokens: resultFiniteNumber,
      truncated: resultBoolean,
    }),
  }),
  "jobs.list": exactResultShape({ jobs: resultArray(runtimeJobResult) }),
  "jobs.create": exactResultShape({ job: runtimeJobResult }),
  "jobs.update": exactResultShape({ job: runtimeJobResult }),
  "jobs.delete": exactResultShape({ deleted: resultBoolean }),
  "jobs.setEnabled": exactResultShape({ job: runtimeJobResult }),
  "jobs.runNow": exactResultShape({ job: runtimeJobResult, runId: resultString }),
  "jobs.history": exactResultShape({ runs: resultArray(runtimeRunResult) }),
  "automation.credential.import": exactResultShape({
    imported: resultOneOf([true]),
    credentialRef: resultString,
  }),
  "automation.create": exactResultShape({ job: runtimeJobResult }),
  "config.get": exactResultShape({ config: resultJsonObject, version: resultFiniteNumber }),
  "config.update": exactResultShape({ config: resultJsonObject, version: resultFiniteNumber }),
  "config.providers": exactResultShape({ providers: resultArray(resultJsonObject) }),
  "config.user.get": exactResultShape({
    config: runtimeUserConfigResult,
    revision: resultString,
  }),
  "config.user.update": exactResultShape({
    config: runtimeUserConfigResult,
    revision: resultString,
  }),
  "config.effective.get": exactResultShape({ config: runtimeEffectiveConfigResult }),
  "provider.list": exactResultShape({
    providers: resultArray(runtimeProviderProfileResult),
    revision: resultString,
  }),
  "provider.upsert": exactResultShape({
    provider: runtimeProviderProfileResult,
    revision: resultString,
  }),
  "provider.importEnvironment": exactResultShape({
    provider: runtimeProviderProfileResult,
    revision: resultString,
  }),
  "provider.delete": exactResultShape({
    deleted: resultOneOf([true]),
    revision: resultString,
  }),
  "provider.credential.status": exactResultShape({
    providerId: resultString,
    status: resultOneOf(["ready", "missing", "environment", "unsupported"]),
    source: resultOneOf(["config", "keychain", "environment", "none"]),
    storedCredentialPresent: resultBoolean,
    providerFingerprint: resultString,
  }),
  "provider.credential.set": exactResultShape({
    providerId: resultString,
    status: resultOneOf(["ready"]),
    source: resultOneOf(["config"]),
    storedCredentialPresent: resultOneOf([true]),
    providerFingerprint: resultString,
    revision: resultString,
  }),
  "provider.credential.delete": exactResultShape({
    providerId: resultString,
    status: resultOneOf(["ready", "missing", "environment", "unsupported"]),
    source: resultOneOf(["config", "keychain", "environment", "none"]),
    storedCredentialPresent: resultBoolean,
    providerFingerprint: resultString,
    revision: resultString,
  }),
  "catalog.agents": exactResultShape({ agents: resultArray(runtimeCatalogAgentResult) }),
  "catalog.skills": exactResultShape({ skills: resultArray(runtimeCatalogSkillResult) }),
  "config.skills": exactResultShape({ skills: resultArray(resultJsonObject) }),
  "config.mcpServers": exactResultShape({ servers: resultArray(resultJsonObject) }),
  "skills.user.list": exactResultShape({
    skills: resultArray(runtimeScopedSkillResult),
    revision: resultString,
  }),
  "skills.effective.list": exactResultShape({
    skills: resultArray(runtimeScopedSkillResult),
    revisions: runtimeCapabilityRevisionsResult,
  }),
  "mcp.user.list": exactResultShape({
    servers: resultArray(runtimeScopedMcpServerResult),
    revision: resultString,
  }),
  "mcp.user.upsert": exactResultShape({
    server: runtimeScopedMcpServerResult,
    revision: resultString,
  }),
  "mcp.user.delete": exactResultShape({
    serverName: resultString,
    deleted: resultOneOf([true]),
    revision: resultString,
  }),
  "mcp.user.setEnabled": exactResultShape({
    server: runtimeScopedMcpServerResult,
    revision: resultString,
  }),
  "mcp.effective.list": exactResultShape({
    servers: resultArray(runtimeScopedMcpServerResult),
    revisions: runtimeCapabilityRevisionsResult,
  }),
  "usage.get": exactResultShape({ usage: resultJsonObject }),
  "workspace.unregister": exactResultShape({
    workspacePath: resultString,
    registered: resultOneOf([false]),
  }),
  "workspace.trust": exactResultShape({
    workspacePath: resultString,
    trusted: resultBoolean,
  }),
  "events.replay": resultShape(
    { events: resultArray(durableRuntimeNotificationResult), hasMore: resultBoolean },
    { nextAfterEventId: resultString, highWatermarkEventId: resultString },
  ),
  "events.subscribe": resultShape(
    {
      subscribed: resultOneOf([true]),
      events: resultArray(durableRuntimeNotificationResult),
      hasMore: resultBoolean,
    },
    { nextAfterEventId: resultString, highWatermarkEventId: resultString },
  ),
} satisfies Readonly<Record<RuntimeMethod, RuntimeResultRule>>;

/**
 * Applies the method-specific response contract at every Runtime client boundary.
 */
export function parseRuntimeResult<Method extends RuntimeMethod>(
  method: Method,
  value: unknown,
): RuntimeResult<Method> {
  if (!isJsonValue(value)) throw invalidResult(`${method} result 必须是 JSON 值`);
  RUNTIME_RESULT_VALIDATORS[method](value, `${method} result`);
  return value as RuntimeResult<Method>;
}

/** Desktop-compatible alias retained for the preload/Main boundary. */
export function parseDesktopRuntimeResult<Method extends DesktopRuntimeBoundaryMethod>(
  method: Method,
  value: unknown,
): RuntimeResult<Method> {
  return parseRuntimeResult(method, value);
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

function invalidResult(message: string): RuntimeProtocolError {
  return protocolError(RUNTIME_ERROR_CODES.INVALID_REQUEST, `Runtime 响应不兼容: ${message}`);
}
