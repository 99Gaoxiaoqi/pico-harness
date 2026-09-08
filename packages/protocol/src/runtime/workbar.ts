// Session workbar, Git, browser, terminal, and rewind contracts with their boundary rules.
import type {
  CheckpointId,
  EmptyParams,
  JsonObject,
  RunId,
  RuntimeRewindMode,
  SessionId,
  WorkspaceParams,
} from "./base.js";
import {
  booleanParam,
  boundedNonEmptyStringParam,
  exactParamShape,
  exactResultShape,
  jsonObjectParam,
  noParams,
  nonNegativeIntegerParam,
  nullableParam,
  oneOfParam,
  positiveIntegerParam,
  resultArray,
  resultBoolean,
  resultBoundedString,
  resultFiniteNumber,
  resultJsonObject,
  resultNonEmptyString,
  resultNonNegativeInteger,
  resultNullable,
  resultOneOf,
  resultPositiveInteger,
  resultShape,
  resultString,
  resultStringArray,
  stringParam,
  workspaceRunParams,
  workspaceSessionParams,
} from "./validation.js";
import type { RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

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

export type RuntimeChange = JsonObject & {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
};

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

const runtimeChangeResult = resultShape({
  path: resultString,
  status: resultOneOf(["added", "modified", "deleted", "renamed"]),
  additions: resultFiniteNumber,
  deletions: resultFiniteNumber,
});

export type WorkbarMethodMap = {
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
  readonly "session.graph.query": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly action: "list" | "get" | "timeline";
      readonly graphId?: string;
      readonly cursor?: string;
      readonly limit?: number;
    };
    readonly result: JsonObject;
  };
  readonly "session.graph.stop": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId; readonly graphId: string };
    readonly result: { readonly stopped: boolean };
  };
  readonly "session.graph.retryWake": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly graphId: string;
      readonly wakeId: string;
    };
    readonly result: { readonly retried: boolean };
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
      /** 同一确认动作的稳定键；缺省时 daemon 按精确请求派生兼容键。 */
      readonly idempotencyKey?: string;
    };
    readonly result: {
      readonly applied: boolean;
      readonly sessionId: SessionId;
      /** v2 旧 daemon 未返回该字段；存在时必须与请求源 Session 一致。 */
      readonly sourceSessionId?: SessionId;
    };
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
};

export const workbarParamValidators = {
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
  "session.graph.query": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      action: oneOfParam(["list", "get", "timeline"] as const),
    },
    {
      graphId: boundedNonEmptyStringParam(512),
      cursor: boundedNonEmptyStringParam(2_048),
      limit: positiveIntegerParam,
    },
  ),
  "session.graph.stop": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    graphId: boundedNonEmptyStringParam(512),
  }),
  "session.graph.retryWake": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    graphId: boundedNonEmptyStringParam(512),
    wakeId: boundedNonEmptyStringParam(512),
  }),
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
    {
      mode: oneOfParam(["code", "conversation", "both"]),
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
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
} satisfies Readonly<Record<keyof WorkbarMethodMap, RuntimeParamValidator>>;

export const workbarResultValidators = {
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
  "session.graph.query": resultJsonObject,
  "session.graph.stop": exactResultShape({ stopped: resultBoolean }),
  "session.graph.retryWake": exactResultShape({ retried: resultBoolean }),
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
  "rewind.apply": exactResultShape(
    { applied: resultBoolean, sessionId: resultString },
    { sourceSessionId: resultNonEmptyString },
  ),
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
} satisfies Readonly<Record<keyof WorkbarMethodMap, RuntimeResultRule>>;
