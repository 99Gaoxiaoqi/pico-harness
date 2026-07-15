import { createHash } from "node:crypto";
import type { SubagentActivityEvent, SubagentTraceEvent } from "../engine/reporter.js";
import type { Session } from "../engine/session.js";
import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import {
  projectTranscriptEvents,
  type TranscriptEntry,
  type TranscriptEvent,
} from "../presentation/transcript-event-store.js";
import {
  isJsonValue,
  type JsonObject,
  type JsonValue,
  type RuntimeNotification,
} from "./protocol.js";

const RUN_BOUNDARY_TOPICS = new Set([
  "run.started",
  "run.pause_requested",
  "run.paused",
  "run.resumed",
  "run.cancel_requested",
  "run.finished",
]);

export function isDesktopTranscriptNotification(topic: string): boolean {
  return (
    RUN_BOUNDARY_TOPICS.has(topic) ||
    topic === "run.timeline" ||
    topic === "approval.requested" ||
    topic === "approval.resolved" ||
    topic === "prompt.requested" ||
    topic === "prompt.resolved" ||
    topic === "changes.updated" ||
    topic === "changes.applied"
  );
}

export async function ingestDesktopRuntimeNotification(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  if (RUN_BOUNDARY_TOPICS.has(notification.topic)) {
    return persistRunBoundary(session, notification);
  }
  switch (notification.topic) {
    case "run.timeline":
      return persistTimelineEvent(session, notification);
    case "approval.requested":
      return persistApprovalRequested(session, notification);
    case "approval.resolved":
      return persistApprovalResolved(session, notification);
    case "prompt.requested":
      return persistPromptRequested(session, notification);
    case "prompt.resolved":
      return persistPromptResolved(session, notification);
    case "changes.updated":
    case "changes.applied":
      return persistChangesEvent(session, notification);
    default:
      return false;
  }
}

async function persistRunBoundary(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  const sessionId = notification.scope.sessionId;
  const runId = notification.scope.runId;
  if (!sessionId || !runId) return false;
  const payload = isJsonRecord(notification.payload) ? notification.payload : undefined;
  const run = payload && isJsonRecord(payload["run"]) ? payload["run"] : undefined;
  if (
    !run ||
    run["runId"] !== runId ||
    run["sessionId"] !== sessionId ||
    !isRuntimeRunStatus(run["status"]) ||
    typeof run["startedAt"] !== "number" ||
    !Number.isFinite(run["startedAt"]) ||
    !Number.isSafeInteger(run["version"])
  ) {
    return false;
  }
  return persistTranscriptEntry(session, {
    sourceEventId: notification.eventId,
    entryId: `run:${runId}:${run["version"]}:${notification.topic}`,
    createdAt: notification.at,
    entry: {
      kind: "run-boundary",
      runId,
      status: run["status"],
      startedAt: run["startedAt"],
      ...(typeof run["finishedAt"] === "number" ? { finishedAt: run["finishedAt"] } : {}),
      ...(typeof run["error"] === "string" && run["error"].trim()
        ? { error: run["error"].trim() }
        : {}),
    },
  });
}

async function persistTimelineEvent(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  const sessionId = notification.scope.sessionId;
  const runId = notification.scope.runId;
  const payload = isJsonRecord(notification.payload) ? notification.payload : undefined;
  const item = payload && isJsonRecord(payload["item"]) ? payload["item"] : undefined;
  const eventType = item && typeof item["eventType"] === "string" ? item["eventType"] : undefined;
  const data = item && isJsonRecord(item["data"]) ? item["data"] : undefined;
  if (!sessionId || !runId || !eventType || !data) return false;

  if (eventType === "tool.started") {
    const name = optionalNonEmptyText(data["toolName"]);
    const args = typeof data["args"] === "string" ? data["args"] : "";
    if (!name) return false;
    if (isPlanTimelineTool(name)) {
      const detail = safePlanDetail(args);
      return persistTranscriptEntry(session, {
        sourceEventId: notification.eventId,
        entryId: runtimeTranscriptId("plan", runId, notification.eventId),
        createdAt: notification.at,
        entry: {
          kind: "plan",
          title: planTimelineTitle(name),
          ...(detail ? { detail } : {}),
          state: "active",
        },
      });
    }
    const providerCallId = optionalNonEmptyText(data["providerCallId"]);
    return persistTranscriptEvent(session, {
      sourceEventId: notification.eventId,
      create: (_snapshot, sequence, eventId) => ({
        eventId,
        sequence,
        createdAt: notification.at,
        type: "tool.started",
        entryId: runtimeTranscriptId("tool-entry", runId, notification.eventId),
        toolCallId: runtimeTranscriptId("tool-call", runId, notification.eventId),
        ...(providerCallId ? { providerCallId } : {}),
        name,
        args,
      }),
    });
  }

  if (eventType === "tool.completed") {
    const name = optionalNonEmptyText(data["toolName"]);
    if (!name || isPlanTimelineTool(name)) return false;
    const providerCallId = optionalNonEmptyText(data["providerCallId"]);
    const isError = data["isError"] === true;
    const size = safeToolResultBytes(data);
    const truncated = data["truncated"] === true;
    return persistTranscriptEvent(session, {
      sourceEventId: notification.eventId,
      create: (snapshot, sequence, eventId) => {
        const toolCallId = findPendingRuntimeTool(snapshot, name, providerCallId);
        if (!toolCallId) return undefined;
        return {
          eventId,
          sequence,
          createdAt: notification.at,
          type: "tool.completed",
          toolCallId,
          status: isError ? "error" : "success",
          summary: `${isError ? "Tool failed" : "Tool completed"} · ${size} bytes${truncated ? " · truncated" : ""}`,
          size,
          truncated,
        };
      },
    });
  }

  // Raw stdout/stderr and ToolResult text are deliberately absent from the durable
  // renderer projection. tool.completed above records only a bounded status summary.
  if (eventType === "tool.output") return false;

  if (eventType === "subagent.activity") {
    const activity = runtimeSubagentActivity(data);
    if (!activity) return false;
    return persistTranscriptEvent(session, {
      sourceEventId: notification.eventId,
      create: (_snapshot, sequence, eventId) => ({
        eventId,
        sequence,
        createdAt: notification.at,
        type: "subagent.activity.updated",
        entryId: runtimeTranscriptId("subagent", runId, activity.activityId),
        activityId: activity.activityId,
        activity: activity.activity,
      }),
    });
  }

  if (eventType === "subagent.trace") {
    const trace = runtimeSubagentTrace(data);
    if (!trace) return false;
    return persistTranscriptEvent(session, {
      sourceEventId: notification.eventId,
      create: (_snapshot, sequence, eventId) => ({
        eventId,
        sequence,
        createdAt: notification.at,
        type: "subagent.trace.recorded",
        trace,
      }),
    });
  }

  if (eventType !== "subagent.claimed") return false;
  const activityIds = Array.isArray(data["activityIds"])
    ? data["activityIds"].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  let persisted = false;
  for (const [index, activityId] of activityIds.entries()) {
    persisted =
      (await persistTranscriptEvent(session, {
        sourceEventId: `${notification.eventId}:${index}`,
        create: (_snapshot, sequence, eventId) => ({
          eventId,
          sequence,
          createdAt: notification.at,
          type: "subagent.activity.claimed",
          activityId,
        }),
      })) || persisted;
  }
  return persisted;
}

async function persistApprovalRequested(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  const sessionId = notification.scope.sessionId;
  const payload = isJsonRecord(notification.payload) ? notification.payload : undefined;
  const approvalId = payload && optionalNonEmptyText(payload["approvalId"]);
  const request = payload && isJsonRecord(payload["request"]) ? payload["request"] : undefined;
  if (!sessionId || !approvalId || !request) return false;
  const title = optionalNonEmptyText(request["title"]) ?? "Approval required";
  const detail = optionalNonEmptyText(request["detail"]);
  return persistTranscriptEntry(session, {
    sourceEventId: notification.eventId,
    entryId: runtimeTranscriptId("approval-requested", approvalId, notification.eventId),
    createdAt: notification.at,
    entry: {
      kind: "approval",
      title,
      ...(detail ? { detail } : {}),
      state: "waiting",
      data: compactInteractionData({
        approvalId,
        runId: notification.scope.runId,
        toolName: request["toolName"],
        command: request["command"],
        risk: request["risk"],
      }),
    },
  });
}

async function persistApprovalResolved(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  const sessionId = notification.scope.sessionId;
  const payload = isJsonRecord(notification.payload) ? notification.payload : undefined;
  const approvalId = payload && optionalNonEmptyText(payload["approvalId"]);
  const decision = payload && optionalNonEmptyText(payload["decision"]);
  if (!sessionId || !approvalId || !decision) return false;
  return persistTranscriptEntry(session, {
    sourceEventId: notification.eventId,
    entryId: runtimeTranscriptId("approval-resolved", approvalId, notification.eventId),
    createdAt: notification.at,
    entry: {
      kind: "approval",
      title: decision === "deny" ? "Approval denied" : "Approval granted",
      state: decision,
      data: compactInteractionData({ approvalId, runId: notification.scope.runId, decision }),
    },
  });
}

async function persistPromptRequested(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  const sessionId = notification.scope.sessionId;
  const payload = isJsonRecord(notification.payload) ? notification.payload : undefined;
  const promptId = payload && optionalNonEmptyText(payload["promptId"]);
  const prompt = payload && isJsonRecord(payload["prompt"]) ? payload["prompt"] : undefined;
  if (!sessionId || !promptId || !prompt) return false;
  const question = optionalNonEmptyText(prompt["question"]) ?? "Pico needs your input";
  const header = optionalNonEmptyText(prompt["header"]);
  return persistTranscriptEntry(session, {
    sourceEventId: notification.eventId,
    entryId: runtimeTranscriptId("prompt-requested", promptId, notification.eventId),
    createdAt: notification.at,
    entry: {
      kind: "prompt",
      title: header ?? question,
      ...(header ? { detail: question } : {}),
      state: "waiting",
      data: compactInteractionData({
        promptId,
        runId: notification.scope.runId,
        options: prompt["options"],
      }),
    },
  });
}

async function persistPromptResolved(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  const sessionId = notification.scope.sessionId;
  const payload = isJsonRecord(notification.payload) ? notification.payload : undefined;
  const promptId = payload && optionalNonEmptyText(payload["promptId"]);
  if (!sessionId || !promptId) return false;
  return persistTranscriptEntry(session, {
    sourceEventId: notification.eventId,
    entryId: runtimeTranscriptId("prompt-resolved", promptId, notification.eventId),
    createdAt: notification.at,
    entry: {
      kind: "prompt",
      title: "Question answered",
      state: "resolved",
      data: compactInteractionData({ promptId, runId: notification.scope.runId }),
    },
  });
}

async function persistChangesEvent(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  const sessionId = notification.scope.sessionId;
  const payload = isJsonRecord(notification.payload) ? notification.payload : undefined;
  const runId = (payload && optionalNonEmptyText(payload["runId"])) ?? notification.scope.runId;
  const fingerprint = payload && optionalNonEmptyText(payload["fingerprint"]);
  if (!sessionId || !runId || !fingerprint) return false;
  const applied = notification.topic === "changes.applied";
  return persistTranscriptEntry(session, {
    sourceEventId: notification.eventId,
    entryId: runtimeTranscriptId(
      applied ? "changes-applied" : "changes-updated",
      runId,
      notification.eventId,
    ),
    createdAt: notification.at,
    entry: {
      kind: "changes",
      title: applied ? "Changes applied" : "Changes updated",
      state: applied ? "applied" : "ready",
      data: { runId, fingerprint },
    },
  });
}

function persistTranscriptEntry(
  session: Session,
  input: {
    readonly sourceEventId: string;
    readonly entryId: string;
    readonly createdAt: number;
    readonly entry: TranscriptEntry;
  },
): Promise<boolean> {
  return persistTranscriptEvent(session, {
    sourceEventId: input.sourceEventId,
    create: (snapshot, sequence, eventId) => {
      if (
        snapshot.transcriptEvents.some(
          (event) => event.type === "entry.appended" && event.entryId === input.entryId,
        )
      ) {
        return undefined;
      }
      return {
        eventId,
        sequence,
        createdAt: input.createdAt,
        type: "entry.appended",
        entryId: input.entryId,
        entry: input.entry,
      };
    },
  });
}

async function persistTranscriptEvent(
  session: Session,
  input: {
    readonly sourceEventId: string;
    readonly create: (
      snapshot: SessionHydrationSnapshot,
      sequence: number,
      eventId: string,
    ) => TranscriptEvent | undefined;
  },
): Promise<boolean> {
  const snapshot = await session.readHydrationSnapshot();
  const eventId = `runtime:${input.sourceEventId}`;
  if (snapshot.transcriptEvents.some((event) => event.eventId === eventId)) return false;
  const sequence = (snapshot.transcriptEvents.at(-1)?.sequence ?? 0) + 1;
  const event = input.create(snapshot, sequence, eventId);
  if (!event) return false;
  // Validate the full append-only projection before committing to the RuntimeEvent ledger.
  // A malformed or out-of-order runtime event therefore fails closed.
  projectTranscriptEvents([...snapshot.transcriptEvents, event]);
  await session.recordTranscriptEvent(event, { eventId: `transcript:${input.sourceEventId}` });
  return true;
}

function runtimeTranscriptId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

function optionalNonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactInteractionData(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, JsonValue] => isJsonValue(entry[1])),
  );
}

function isPlanTimelineTool(name: string): boolean {
  return name === "todo" || name === "update_plan" || name === "exit_plan_mode";
}

function planTimelineTitle(name: string): string {
  if (name === "exit_plan_mode") return "Plan ready for approval";
  return name === "todo" ? "Plan updated" : "Plan";
}

function safePlanDetail(args: string): string | undefined {
  if (!args.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    if (isJsonRecord(parsed) && Array.isArray(parsed["plan"])) {
      const lines = parsed["plan"].flatMap((value) => {
        if (!isJsonRecord(value)) return [];
        const step = optionalNonEmptyText(value["step"]);
        if (!step) return [];
        const status = optionalNonEmptyText(value["status"]);
        return [`${status ? `[${status}] ` : ""}${step}`];
      });
      if (lines.length > 0) return lines.join("\n").slice(0, 16_000);
    }
    if (isJsonRecord(parsed)) {
      const action = optionalNonEmptyText(parsed["action"]);
      const content = optionalNonEmptyText(parsed["content"]);
      if (action || content) return [action, content].filter(Boolean).join(": ").slice(0, 16_000);
    }
  } catch {
    // Invalid model arguments are still useful as a bounded diagnostic summary.
  }
  return args.slice(0, 16_000);
}

function safeToolResultBytes(data: JsonObject): number {
  const reported = data["resultBytes"];
  if (typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0) {
    return reported;
  }
  return typeof data["result"] === "string" ? Buffer.byteLength(data["result"], "utf8") : 0;
}

function findPendingRuntimeTool(
  snapshot: SessionHydrationSnapshot,
  name: string,
  providerCallId: string | undefined,
): string | undefined {
  const projection = projectTranscriptEvents(snapshot.transcriptEvents);
  return Object.values(projection.toolCalls)
    .toReversed()
    .find(
      (tool) =>
        tool.name === name &&
        !isTerminalTranscriptToolStatus(tool.status) &&
        (providerCallId === undefined || tool.providerCallId === providerCallId),
    )?.id;
}

function isTerminalTranscriptToolStatus(status: string): boolean {
  return new Set(["success", "error", "denied", "done", "failed"]).has(status);
}

function runtimeSubagentActivity(data: JsonObject):
  | {
      readonly activityId: string;
      readonly activity: Omit<SubagentActivityEvent, "activityId">;
    }
  | undefined {
  const activityId = optionalNonEmptyText(data["activityId"]);
  const task = optionalNonEmptyText(data["task"]);
  const status = data["status"];
  if (!activityId || !task || !isSubagentActivityStatus(status)) return undefined;
  const agentName = optionalNonEmptyText(data["agentName"]);
  const currentAction = optionalNonEmptyText(data["currentAction"]);
  const summary = optionalNonEmptyText(data["summary"]);
  const requestedModelRoute = optionalNonEmptyText(data["requestedModelRoute"]);
  const resolvedModelRoute = optionalNonEmptyText(data["resolvedModelRoute"]);
  const thinkingEffort = optionalNonEmptyText(data["thinkingEffort"]);
  const activity: Omit<SubagentActivityEvent, "activityId"> = {
    task,
    status,
    ...(agentName ? { agentName } : {}),
    ...(isOneOf(data["mode"], ["explore", "worker"]) ? { mode: data["mode"] } : {}),
    ...(isOneOf(data["completionPolicy"], ["required", "optional", "detached"])
      ? { completionPolicy: data["completionPolicy"] }
      : {}),
    ...(currentAction ? { currentAction } : {}),
    ...(summary ? { summary } : {}),
    ...(requestedModelRoute ? { requestedModelRoute } : {}),
    ...(resolvedModelRoute ? { resolvedModelRoute } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
    ...(isOneOf(data["modelSelectionSource"], ["ephemeral", "profile", "parent"])
      ? { modelSelectionSource: data["modelSelectionSource"] }
      : {}),
  };
  return { activityId, activity };
}

function runtimeSubagentTrace(data: JsonObject): SubagentTraceEvent | undefined {
  const activityId = optionalNonEmptyText(data["activityId"]);
  const traceId = optionalNonEmptyText(data["traceId"]);
  const type = data["type"];
  if (!activityId || !traceId) return undefined;
  if (type === "thinking") return { activityId, traceId, type };
  if (type === "message" && typeof data["content"] === "string") {
    return { activityId, traceId, type, content: data["content"].slice(0, 12_000) };
  }
  if (
    type === "tool.started" &&
    typeof data["name"] === "string" &&
    typeof data["args"] === "string"
  ) {
    return {
      activityId,
      traceId,
      type,
      name: data["name"],
      args: data["args"].slice(0, 8_000),
    };
  }
  if (type === "tool.completed") {
    const isError = data["isError"] === true;
    const bytes = safeToolResultBytes(data);
    return {
      activityId,
      traceId,
      type,
      result: `${isError ? "Tool failed" : "Tool completed"} · ${bytes} bytes`,
      isError,
      ...(data["truncated"] === true ? { truncated: true } : {}),
    };
  }
  return undefined;
}

function isSubagentActivityStatus(value: unknown): value is SubagentActivityEvent["status"] {
  return isOneOf(value, [
    "queued",
    "running",
    "completed",
    "partial",
    "failed",
    "timed_out",
    "cancelled",
  ]);
}

function isRuntimeRunStatus(
  value: unknown,
): value is Extract<TranscriptEntry, { kind: "run-boundary" }>["status"] {
  return isOneOf(value, [
    "queued",
    "running",
    "pause_requested",
    "paused",
    "cancelling",
    "cancelled",
    "failed",
    "succeeded",
  ]);
}

function isOneOf<const Values extends readonly unknown[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return values.includes(value);
}

function isJsonRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
