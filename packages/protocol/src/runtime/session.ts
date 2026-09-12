// Session lifecycle, user input, and run contracts with their parameter/result rules.
import { isJsonObject } from "./base.js";
import type {
  JsonObject,
  RunId,
  RuntimeCollaborationMode,
  RuntimeOrchestrationMode,
  RuntimePermissionMode,
  RuntimeProviderKind,
  RuntimeRunStatus,
  RuntimeSessionStatus,
  SessionId,
  SessionSendBehavior,
  SessionSendDisposition,
  WorkspaceParams,
} from "./base.js";
import { subagentPresetIdParam, subagentPresetIdResult } from "./subagents.js";
import { runtimeUserDefaultsParam } from "./config.js";
import type { RuntimeUserDefaults } from "./config.js";
import { invalidParams, invalidResult } from "./errors.js";
import {
  assertNestedShape,
  booleanParam,
  boundedNonEmptyStringParam,
  collaborationModeParam,
  exactParamShape,
  exactResultShape,
  oneOfParam,
  orchestrationModeParam,
  permissionModeParam,
  resultArray,
  resultBoolean,
  resultFiniteNumber,
  resultNonEmptyString,
  resultOneOf,
  resultShape,
  resultString,
  resultStringArray,
  stringParam,
  workspaceRunParams,
  workspaceSessionParams,
} from "./validation.js";
import type { RuntimeParamRule, RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export type RuntimeSessionSettings = {
  readonly sessionId: SessionId;
  readonly provider: RuntimeProviderKind;
  readonly model: string;
  readonly modelRouteId: string;
  readonly collaborationMode: RuntimeCollaborationMode;
  readonly orchestrationMode: RuntimeOrchestrationMode;
  readonly permissionMode: RuntimePermissionMode;
  readonly thinkingEffort: string;
  readonly thinkingEffortExplicit: boolean;
  readonly reasoningLevels: readonly string[];
  /** 会话附加授权目录（/add-dir 镜像；缺省=未配置）。 */
  readonly additionalDirectories?: readonly string[];
};

/** text 输入的内联图片附件（仅 base64；数量/大小上限在参数校验层强制）。 */
export type RuntimeInputAttachment = JsonObject & {
  readonly type: "image_base64";
  readonly mimeType: string;
  readonly data: string;
};

export type RuntimeTextUserInput = JsonObject & {
  /** Explicit per-turn override; retained with queued input without changing Session defaults. */
  readonly orchestrationMode?: "graph" | "swarm";
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
  readonly subagentId?: string;
  readonly name: string;
  readonly task: string;
};

export type RuntimeUserInput = RuntimeTextUserInput | RuntimeSkillUserInput | RuntimeAgentUserInput;

export type RuntimeQueuedInput = JsonObject & {
  readonly queueId: string;
  readonly sessionId: SessionId;
  readonly input: RuntimeUserInput;
  readonly createdAt: number;
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
  readonly parentSession?: {
    readonly sessionId: SessionId;
    readonly workspacePath: string;
    readonly agentName?: string;
  };
};

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
    assertNestedShape(
      value,
      path,
      {
        kind: oneOfParam(["agent"]),
        name: stringParam,
        task: stringParam,
      },
      { subagentId: subagentPresetIdParam },
    );
    return;
  }
  assertNestedShape(
    value,
    path,
    {
      kind: oneOfParam(["text"]),
      text: stringParam,
    },
    {
      attachments: runtimeInputAttachmentsParam,
      orchestrationMode: oneOfParam(["graph", "swarm"]),
    },
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

export const runtimeSessionResult = resultShape(
  {
    sessionId: resultString,
    workspacePath: resultString,
    title: resultString,
    status: resultOneOf(["active", "archived"]),
    pinned: resultBoolean,
    createdAt: resultFiniteNumber,
    updatedAt: resultFiniteNumber,
  },
  {
    parentSession: resultShape(
      { sessionId: resultNonEmptyString, workspacePath: resultNonEmptyString },
      { agentName: resultNonEmptyString },
    ),
  },
);

export const runtimeRunStatusResult = resultOneOf([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancelling",
  "cancelled",
  "failed",
  "succeeded",
]);

export const runtimeRunResult = resultShape(
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

const runtimeSessionSettingsResult = exactResultShape(
  {
    sessionId: resultString,
    provider: resultOneOf(["openai", "claude", "responses"]),
    model: resultString,
    modelRouteId: resultString,
    collaborationMode: resultOneOf(["agent", "plan"]),
    orchestrationMode: resultOneOf(["default", "graph", "swarm"]),
    permissionMode: resultOneOf(["ask", "auto", "full-access"]),
    thinkingEffort: resultString,
    thinkingEffortExplicit: resultBoolean,
    reasoningLevels: resultStringArray,
  },
  { additionalDirectories: resultStringArray },
);

export const runtimeQueuedInputResult = exactResultShape({
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
      exactResultShape(
        {
          kind: resultOneOf(["agent"]),
          name: resultString,
          task: resultString,
        },
        { subagentId: subagentPresetIdResult },
      )(value, path);
      return;
    }
    throw invalidResult(`${path}.kind 必须是 text | skill | agent 之一`);
  },
  createdAt: resultFiniteNumber,
});

export type SessionMethodMap = {
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
      readonly thinkingEffort?: string;
    };
    readonly result: { readonly settings: RuntimeSessionSettings };
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
};

export const sessionParamValidators = {
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
  "session.settings.update": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    {
      modelRouteId: stringParam,
      collaborationMode: collaborationModeParam,
      orchestrationMode: orchestrationModeParam,
      permissionMode: permissionModeParam,
      thinkingEffort: stringParam,
    },
  ),
  "session.send": exactParamShape(
    { workspacePath: stringParam, input: runtimeUserInputParam, idempotencyKey: stringParam },
    {
      sessionId: stringParam,
      initialSettings: runtimeUserDefaultsParam,
      behavior: sessionBehaviorParam,
      expectedRunId: stringParam,
    },
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
} satisfies Readonly<Record<keyof SessionMethodMap, RuntimeParamValidator>>;

export const sessionResultValidators = {
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
  "session.fork": resultShape({ session: runtimeSessionResult, sourceSessionId: resultString }),
  "session.send": resultShape(
    {
      session: runtimeSessionResult,
      disposition: resultOneOf(["started", "steered", "queued", "replaced"]),
    },
    { run: runtimeRunResult },
  ),
  "run.start": runtimeRunResult,
  "run.cancel": runtimeRunResult,
  "run.pause": runtimeRunResult,
  "run.resume": runtimeRunResult,
  "run.steer": runtimeRunResult,
  "runs.list": resultShape({ runs: resultArray(runtimeRunResult) }),
} satisfies Readonly<Record<keyof SessionMethodMap, RuntimeResultRule>>;
