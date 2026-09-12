// Notification wire contracts, metadata checks, and durable event replay rules.
import type { RuntimeJob } from "./automation.js";
import {
  EPHEMERAL_RUNTIME_NOTIFICATION_TOPICS,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  hasExactKeys,
  isJsonObject,
  isJsonValue,
  nonEmptyString,
  nonNegativeSafeInteger,
  optionalStringField,
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
import { invalidResult } from "./errors.js";
import type { RuntimeErrorCode } from "./errors.js";
import type { RuntimeDiscoveryProjection, RuntimePlanProjection } from "./planning.js";
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
import type { RuntimeWorkspaceInitResult } from "./workspace.js";

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

export function createRuntimeNotification<Topic extends string>(
  input: Omit<RuntimeNotification<Topic>, "eventId" | "protocolVersion"> & { eventId?: string },
): RuntimeNotification<Topic> {
  return {
    ...input,
    eventId: input.eventId ?? globalThis.crypto.randomUUID(),
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
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

export function isRuntimeNotification(value: Record<string, unknown>): boolean {
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
): value is RuntimeNotification<"memory.changed" | "memory.deleted"> {
  if (!isJsonObject(value) || !isRuntimeNotificationEnvelope(value)) return false;
  const payload = value.payload;
  if (!isJsonObject(payload)) return false;
  if (value.topic === "memory.changed") {
    return (
      hasExactKeys(payload, ["entityType", "entityId", "version", "change"]) &&
      ["item", "settings", "source"].includes(String(payload.entityType)) &&
      nonEmptyString(payload.entityId) &&
      nonNegativeSafeInteger(payload.version) &&
      payload.change === "updated"
    );
  }
  if (value.topic === "memory.deleted") {
    return (
      hasExactKeys(payload, ["itemId", "version"]) &&
      nonEmptyString(payload.itemId) &&
      nonNegativeSafeInteger(payload.version)
    );
  }
  return false;
}

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
