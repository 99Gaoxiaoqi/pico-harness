// Notification wire contracts, metadata checks, and durable event replay rules.
import { runtimeJobResult } from "./automation.js";
import type { RuntimeJob } from "./automation.js";
import {
  EPHEMERAL_RUNTIME_NOTIFICATION_TOPICS,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  hasExactKeys,
  isJsonObject,
  isJsonValue,
  nonEmptyString,
  nonNegativeSafeInteger,
} from "./base.js";
import type {
  ApprovalId,
  CheckpointId,
  JobId,
  JsonObject,
  JsonValue,
  PromptId,
  RunId,
  SessionId,
  WorkspaceParams,
} from "./base.js";
import { invalidResult, isRuntimeErrorCode } from "./errors.js";
import type { RuntimeErrorCode } from "./errors.js";
import { runtimePlanProjectionResult } from "./planning.js";
import type { RuntimeDiscoveryProjection, RuntimePlanProjection } from "./planning.js";
import { runtimeRunResult, runtimeSessionResult, runtimeSessionSettingsResult } from "./session.js";
import type { RuntimeRun, RuntimeSession, RuntimeSessionSettings } from "./session.js";
import {
  exactParamShape,
  finiteNumberParam,
  resultArray,
  resultBoolean,
  resultOneOf,
  resultShape,
  resultString,
  stringParam,
} from "./validation.js";
import type { RuntimeParamValidator, RuntimeResultRule } from "./validation.js";
import { runtimeWorkspaceInitResult } from "./workspace.js";
import type { RuntimeWorkspaceInitResult } from "./workspace.js";
import { parseApprovalRequestedPayload } from "../runtime-normalize.js";

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
    readonly sourceSessionId?: SessionId;
    readonly checkpointId: CheckpointId;
  };
  readonly "memory.changed": {
    readonly entityType: "item" | "settings" | "source";
    readonly entityId: string;
    readonly version: number;
    readonly change: "updated";
  };
  readonly "memory.deleted": {
    readonly itemId: string;
    readonly version: number;
  };
  readonly "job.updated": { readonly job: RuntimeJob };
  readonly "job.runFinished": { readonly jobId: JobId; readonly run: RuntimeRun };
  readonly "config.updated":
    | {
        readonly scope: "user";
        readonly revision: string;
        readonly providerIds: readonly string[];
      }
    | {
        readonly scope: "user";
        readonly revision: string;
        readonly capabilities: readonly ("skills" | "mcp" | "subagents")[];
      };
  readonly "usage.updated": { readonly usage: JsonObject };
  readonly "runtime.error": {
    readonly code: RuntimeErrorCode;
    readonly message: string;
    readonly recoverable: boolean;
  };
};

export type RuntimeNotificationTopic = keyof RuntimeNotificationMap;

export const RUNTIME_NOTIFICATION_TOPICS = [
  "workspace.registered",
  "workspace.unregistered",
  "workspace.trustChanged",
  "workspace.initialized",
  "session.updated",
  "session.resourceChanged",
  "session.settingsUpdated",
  "run.started",
  "run.updated",
  "run.finished",
  "run.timeline",
  "approval.requested",
  "approval.resolved",
  "plan.updated",
  "discovery.updated",
  "prompt.requested",
  "prompt.resolved",
  "changes.updated",
  "changes.applied",
  "rewind.completed",
  "memory.changed",
  "memory.deleted",
  "job.updated",
  "job.runFinished",
  "config.updated",
  "usage.updated",
  "runtime.error",
] as const satisfies readonly RuntimeNotificationTopic[];

const RUNTIME_NOTIFICATION_TOPIC_SET = new Set<string>(RUNTIME_NOTIFICATION_TOPICS);

export function isRuntimeNotificationTopic(value: unknown): value is RuntimeNotificationTopic {
  return typeof value === "string" && RUNTIME_NOTIFICATION_TOPIC_SET.has(value);
}

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

export function createRuntimeNotification<Topic extends RuntimeNotificationTopic>(
  input: Omit<RuntimeNotification<Topic>, "eventId" | "protocolVersion" | "payload"> & {
    readonly eventId?: string;
    readonly payload: JsonValue;
  },
): RuntimeNotification<Topic> {
  return {
    ...input,
    eventId: input.eventId ?? globalThis.crypto.randomUUID(),
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
  } as RuntimeNotification<Topic>;
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

type RuntimeNotificationScopeId = "sessionId" | "runId" | "jobId";

const RUNTIME_NOTIFICATION_SCOPE_IDS = {
  "workspace.registered": { required: [], optional: [] },
  "workspace.unregistered": { required: [], optional: [] },
  "workspace.trustChanged": { required: [], optional: [] },
  "workspace.initialized": { required: [], optional: [] },
  "session.updated": { required: ["sessionId"], optional: [] },
  "session.resourceChanged": { required: ["sessionId"], optional: [] },
  "session.settingsUpdated": { required: ["sessionId"], optional: [] },
  "run.started": { required: ["runId"], optional: ["sessionId"] },
  "run.updated": { required: ["runId"], optional: ["sessionId"] },
  "run.finished": { required: ["runId"], optional: ["sessionId"] },
  "run.timeline": { required: ["runId"], optional: ["sessionId"] },
  "approval.requested": { required: ["sessionId", "runId"], optional: [] },
  "approval.resolved": { required: ["sessionId", "runId"], optional: [] },
  "plan.updated": { required: ["sessionId"], optional: [] },
  "discovery.updated": { required: ["sessionId"], optional: [] },
  "prompt.requested": { required: ["sessionId", "runId"], optional: [] },
  "prompt.resolved": { required: ["sessionId", "runId"], optional: [] },
  "changes.updated": { required: ["sessionId", "runId"], optional: [] },
  "changes.applied": { required: ["sessionId", "runId"], optional: [] },
  "rewind.completed": { required: ["sessionId"], optional: [] },
  "memory.changed": { required: [], optional: [] },
  "memory.deleted": { required: [], optional: [] },
  "job.updated": { required: ["jobId"], optional: [] },
  "job.runFinished": { required: ["jobId", "runId"], optional: ["sessionId"] },
  "config.updated": { required: [], optional: [] },
  "usage.updated": { required: [], optional: ["sessionId"] },
  "runtime.error": { required: [], optional: ["sessionId", "runId", "jobId"] },
} as const satisfies Readonly<
  Record<
    RuntimeNotificationTopic,
    {
      readonly required: readonly RuntimeNotificationScopeId[];
      readonly optional: readonly RuntimeNotificationScopeId[];
    }
  >
>;

function isRuntimeNotificationEnvelope(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  readonly topic: RuntimeNotificationTopic;
  readonly scope: Record<string, unknown>;
} {
  const scope = value.scope;
  return (
    hasExactKeys(value, [
      "protocolVersion",
      "eventId",
      "topic",
      "scope",
      "resourceVersion",
      "at",
      "payload",
    ]) &&
    value.protocolVersion === LOCAL_RUNTIME_PROTOCOL_VERSION &&
    nonEmptyString(value.eventId) &&
    isRuntimeNotificationTopic(value.topic) &&
    isJsonObject(scope) &&
    isNotificationScope(scope, value.topic) &&
    typeof value.resourceVersion === "number" &&
    Number.isSafeInteger(value.resourceVersion) &&
    value.resourceVersion >= 0 &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    isJsonValue(value.payload)
  );
}

function isNotificationScope(
  scope: Record<string, unknown>,
  topic: RuntimeNotificationTopic,
): boolean {
  const contract = RUNTIME_NOTIFICATION_SCOPE_IDS[topic];
  const allowed = new Set<string>(["workspacePath", ...contract.required, ...contract.optional]);
  if (!nonEmptyString(scope.workspacePath)) return false;
  if (Object.keys(scope).some((key) => !allowed.has(key))) return false;
  for (const key of contract.required) {
    if (!nonEmptyString(scope[key])) return false;
  }
  for (const key of contract.optional) {
    if (scope[key] !== undefined && !nonEmptyString(scope[key])) return false;
  }
  return true;
}

export function isRuntimeNotification(value: unknown): value is RuntimeNotification {
  if (!isJsonObject(value) || !isRuntimeNotificationEnvelope(value)) return false;
  const payload = value.payload;
  const scope = value.scope;
  switch (value.topic) {
    case "workspace.registered":
      return isExactObject(payload, ["registered"]) && payload.registered === true;
    case "workspace.unregistered":
      return isExactObject(payload, ["registered"]) && payload.registered === false;
    case "workspace.trustChanged":
      return isExactObject(payload, ["trusted"]) && typeof payload.trusted === "boolean";
    case "workspace.initialized":
      return isWorkspaceInitializedPayload(payload, scope.workspacePath);
    case "session.updated":
      return isSessionUpdatedPayload(payload, scope);
    case "session.resourceChanged":
      return isSessionResourceChangedPayload(payload);
    case "session.settingsUpdated":
      return isSessionSettingsUpdatedPayload(payload, scope);
    case "run.started":
    case "run.updated":
    case "run.finished":
      return isRunPayload(payload, scope);
    case "run.timeline":
      return isRunTimelinePayload(payload, scope.runId);
    case "approval.requested":
      return parseApprovalRequestedPayload(payload)?.runId === scope.runId;
    case "approval.resolved":
      return isApprovalResolvedPayload(payload);
    case "plan.updated":
      return isPlanUpdatedPayload(payload, scope.sessionId);
    case "discovery.updated":
      return isDiscoveryUpdatedPayload(payload, scope.sessionId);
    case "prompt.requested":
      return isPromptRequestedPayload(payload, scope.runId);
    case "prompt.resolved":
      return isExactObject(payload, ["promptId"]) && nonEmptyString(payload.promptId);
    case "changes.updated":
    case "changes.applied":
      return isChangesPayload(payload, scope.runId);
    case "rewind.completed":
      return isRewindCompletedPayload(payload, scope.sessionId);
    case "memory.changed":
    case "memory.deleted":
      return isMemoryPayload(value.topic, payload);
    case "job.updated":
      return isJobUpdatedPayload(payload, scope);
    case "job.runFinished":
      return isJobRunFinishedPayload(payload, scope);
    case "config.updated":
      return isConfigPayload(payload);
    case "usage.updated":
      return isExactObject(payload, ["usage"]) && isJsonObject(payload.usage);
    case "runtime.error":
      return isRuntimeErrorPayload(payload);
  }
}

export function parseRuntimeNotification(value: unknown): RuntimeNotification {
  if (!isRuntimeNotification(value)) throw invalidResult("value 不是有效的 Runtime event");
  return value;
}

export function isApprovalRequestedRuntimeNotification(
  value: unknown,
): value is RuntimeNotification<"approval.requested"> {
  if (
    !isJsonObject(value) ||
    !isRuntimeNotificationEnvelope(value) ||
    value.topic !== "approval.requested" ||
    !isJsonObject(value.scope)
  ) {
    return false;
  }
  const approval = parseApprovalRequestedPayload(value.payload);
  return approval !== undefined && value.scope.runId === approval.runId;
}

export function isConfigRuntimeNotification(
  value: unknown,
): value is RuntimeNotification<"config.updated"> {
  return (
    isJsonObject(value) &&
    isRuntimeNotificationEnvelope(value) &&
    value.topic === "config.updated" &&
    isConfigPayload(value.payload)
  );
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
  return isDiscoveryUpdatedPayload(value.payload, value.scope.sessionId);
}

/** Memory events are durable, so their payload is deliberately exact and body-free. */
export function isMemoryRuntimeNotification(
  value: unknown,
): value is RuntimeNotification<"memory.changed" | "memory.deleted"> {
  if (!isJsonObject(value) || !isRuntimeNotificationEnvelope(value)) return false;
  if (value.topic !== "memory.changed" && value.topic !== "memory.deleted") return false;
  return isMemoryPayload(value.topic, value.payload);
}

function isWorkspaceInitializedPayload(payload: unknown, workspacePath: unknown): boolean {
  return (
    matchesResultRule(runtimeWorkspaceInitResult, payload) &&
    isJsonObject(payload) &&
    payload.workspacePath === workspacePath
  );
}

function isSessionUpdatedPayload(payload: unknown, scope: Record<string, unknown>): boolean {
  if (!isExactObject(payload, ["session"]) || !isJsonObject(payload.session)) return false;
  return (
    matchesResultRule(runtimeSessionResult, payload.session) &&
    nonEmptyString(payload.session.sessionId) &&
    payload.session.sessionId === scope.sessionId &&
    payload.session.workspacePath === scope.workspacePath
  );
}

function isSessionResourceChangedPayload(payload: unknown): boolean {
  return (
    isExactObject(payload, ["resource"], ["revision", "watermark"]) &&
    ["tasks", "artifacts", "trace", "context"].includes(String(payload.resource)) &&
    (payload.revision === undefined || nonNegativeSafeInteger(payload.revision)) &&
    (payload.watermark === undefined || nonNegativeSafeInteger(payload.watermark))
  );
}

function isSessionSettingsUpdatedPayload(
  payload: unknown,
  scope: Record<string, unknown>,
): boolean {
  if (!isExactObject(payload, ["sessionId", "settings"])) return false;
  if (!nonEmptyString(payload.sessionId) || payload.sessionId !== scope.sessionId) return false;
  if (!isJsonObject(payload.settings)) return false;
  return (
    matchesResultRule(runtimeSessionSettingsResult, payload.settings) &&
    payload.settings.sessionId === payload.sessionId
  );
}

function isRunPayload(payload: unknown, scope: Record<string, unknown>): boolean {
  if (!isExactObject(payload, ["run"]) || !isJsonObject(payload.run)) return false;
  const run = payload.run;
  return (
    matchesResultRule(runtimeRunResult, run) &&
    nonEmptyString(run.runId) &&
    run.runId === scope.runId &&
    run.workspacePath === scope.workspacePath &&
    run.sessionId === scope.sessionId &&
    nonNegativeSafeInteger(run.version)
  );
}

function isRunTimelinePayload(payload: unknown, runId: unknown): boolean {
  return (
    isExactObject(payload, ["runId", "item"]) &&
    nonEmptyString(payload.runId) &&
    payload.runId === runId &&
    isJsonObject(payload.item)
  );
}

function isApprovalResolvedPayload(payload: unknown): boolean {
  return (
    isExactObject(payload, ["approvalId", "decision"]) &&
    nonEmptyString(payload.approvalId) &&
    ["allow_once", "allow_session", "deny"].includes(String(payload.decision))
  );
}

function isPlanUpdatedPayload(payload: unknown, sessionId: unknown): boolean {
  if (!isExactObject(payload, ["sessionId", "projection", "operation"])) return false;
  if (!nonEmptyString(payload.sessionId) || payload.sessionId !== sessionId) return false;
  if (
    !["proposed", "updated", "executing", "continue_editing", "rejected"].includes(
      String(payload.operation),
    )
  ) {
    return false;
  }
  return (
    isJsonObject(payload.projection) &&
    matchesResultRule(runtimePlanProjectionResult, payload.projection) &&
    payload.projection.sessionId === payload.sessionId &&
    nonNegativeSafeInteger(payload.projection.sessionSequence)
  );
}

function isDiscoveryUpdatedPayload(payload: unknown, sessionId: unknown): boolean {
  if (!isExactObject(payload, ["sessionId", "projection", "operation"])) return false;
  if (!nonEmptyString(payload.sessionId) || payload.sessionId !== sessionId) return false;
  if (!["started", "resumed", "cancelled", "updated"].includes(String(payload.operation))) {
    return false;
  }
  const projection = payload.projection;
  return (
    isExactObject(
      projection,
      ["sessionId", "sessionSequence", "discoveries"],
      ["latest", "active"],
    ) &&
    projection.sessionId === payload.sessionId &&
    nonNegativeSafeInteger(projection.sessionSequence) &&
    Array.isArray(projection.discoveries) &&
    projection.discoveries.every(isDiscoveryRun) &&
    (projection.latest === undefined || isDiscoveryRun(projection.latest)) &&
    (projection.active === undefined || isDiscoveryRun(projection.active))
  );
}

function isDiscoveryRun(value: unknown): boolean {
  if (
    !isExactObject(
      value,
      [
        "discoveryId",
        "objective",
        "depth",
        "phase",
        "status",
        "cycle",
        "inspectedFiles",
        "evidenceRefs",
        "openQuestions",
        "candidates",
        "branches",
        "startedAt",
        "updatedAt",
      ],
      ["reason", "report"],
    )
  ) {
    return false;
  }
  return (
    nonEmptyString(value.discoveryId) &&
    nonEmptyString(value.objective) &&
    ["quick", "balanced", "deep"].includes(String(value.depth)) &&
    ["forage", "focus", "deepen", "verify"].includes(String(value.phase)) &&
    ["active", "interrupted", "completed", "cancelled"].includes(String(value.status)) &&
    nonNegativeSafeInteger(value.cycle) &&
    isStringArray(value.inspectedFiles) &&
    isStringArray(value.evidenceRefs) &&
    isStringArray(value.openQuestions) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isJsonObject) &&
    Array.isArray(value.branches) &&
    value.branches.every(isJsonObject) &&
    nonEmptyString(value.startedAt) &&
    nonEmptyString(value.updatedAt) &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.report === undefined || isJsonObject(value.report))
  );
}

function isPromptRequestedPayload(payload: unknown, runId: unknown): boolean {
  return (
    isExactObject(payload, ["promptId", "runId", "prompt"]) &&
    nonEmptyString(payload.promptId) &&
    nonEmptyString(payload.runId) &&
    payload.runId === runId &&
    isJsonObject(payload.prompt)
  );
}

function isChangesPayload(payload: unknown, runId: unknown): boolean {
  return (
    isExactObject(payload, ["runId", "fingerprint"]) &&
    nonEmptyString(payload.runId) &&
    payload.runId === runId &&
    nonEmptyString(payload.fingerprint)
  );
}

function isRewindCompletedPayload(payload: unknown, sessionId: unknown): boolean {
  return (
    isExactObject(payload, ["sessionId", "checkpointId"], ["sourceSessionId"]) &&
    nonEmptyString(payload.sessionId) &&
    payload.sessionId === sessionId &&
    nonEmptyString(payload.checkpointId) &&
    (payload.sourceSessionId === undefined || nonEmptyString(payload.sourceSessionId))
  );
}

function isMemoryPayload(topic: "memory.changed" | "memory.deleted", payload: unknown): boolean {
  if (!isJsonObject(payload)) return false;
  if (topic === "memory.changed") {
    return (
      hasExactKeys(payload, ["entityType", "entityId", "version", "change"]) &&
      ["item", "settings", "source"].includes(String(payload.entityType)) &&
      nonEmptyString(payload.entityId) &&
      nonNegativeSafeInteger(payload.version) &&
      payload.change === "updated"
    );
  }
  return (
    hasExactKeys(payload, ["itemId", "version"]) &&
    nonEmptyString(payload.itemId) &&
    nonNegativeSafeInteger(payload.version)
  );
}

function isJobUpdatedPayload(payload: unknown, scope: Record<string, unknown>): boolean {
  if (!isExactObject(payload, ["job"]) || !isJsonObject(payload.job)) return false;
  return (
    matchesResultRule(runtimeJobResult, payload.job) &&
    nonEmptyString(payload.job.jobId) &&
    payload.job.jobId === scope.jobId &&
    payload.job.workspacePath === scope.workspacePath
  );
}

function isJobRunFinishedPayload(payload: unknown, scope: Record<string, unknown>): boolean {
  if (!isExactObject(payload, ["jobId", "run"]) || !isJsonObject(payload.run)) return false;
  return (
    nonEmptyString(payload.jobId) &&
    payload.jobId === scope.jobId &&
    matchesResultRule(runtimeRunResult, payload.run) &&
    nonEmptyString(payload.run.runId) &&
    payload.run.runId === scope.runId &&
    payload.run.workspacePath === scope.workspacePath &&
    payload.run.sessionId === scope.sessionId &&
    nonNegativeSafeInteger(payload.run.version)
  );
}

function isConfigPayload(payload: unknown): boolean {
  if (!isJsonObject(payload) || payload.scope !== "user" || !nonEmptyString(payload.revision)) {
    return false;
  }
  if (hasExactKeys(payload, ["scope", "revision", "providerIds"])) {
    return Array.isArray(payload.providerIds) && payload.providerIds.every(nonEmptyString);
  }
  if (!hasExactKeys(payload, ["scope", "revision", "capabilities"])) return false;
  return (
    Array.isArray(payload.capabilities) &&
    payload.capabilities.every((capability) =>
      ["skills", "mcp", "subagents"].includes(String(capability)),
    )
  );
}

function isRuntimeErrorPayload(payload: unknown): boolean {
  return (
    isExactObject(payload, ["code", "message", "recoverable"]) &&
    isRuntimeErrorCode(payload.code) &&
    nonEmptyString(payload.message) &&
    typeof payload.recoverable === "boolean"
  );
}

function isExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isJsonObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function matchesResultRule(rule: RuntimeResultRule, value: unknown): boolean {
  try {
    rule(value, "notification.payload");
    return true;
  } catch {
    return false;
  }
}

const runtimeNotificationResult: RuntimeResultRule = (value, path) => {
  if (!isRuntimeNotification(value)) throw invalidResult(`${path} 不是有效的 Runtime event`);
};

const durableRuntimeNotificationResult: RuntimeResultRule = (value, path) => {
  runtimeNotificationResult(value, path);
  if (isJsonObject(value) && isEphemeralRuntimeNotificationTopic(String(value["topic"] ?? ""))) {
    throw invalidResult(`${path} 不能包含 ephemeral Runtime event`);
  }
};

export type NotificationsMethodMap = {
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

export const notificationsParamValidators = {
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
} satisfies Readonly<Record<keyof NotificationsMethodMap, RuntimeParamValidator>>;

export const notificationsResultValidators = {
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
} satisfies Readonly<Record<keyof NotificationsMethodMap, RuntimeResultRule>>;
