import { createHash } from "node:crypto";
import type { SubagentActivityEvent } from "../engine/reporter.js";
import type { Session } from "../engine/session.js";
import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import {
  projectTranscriptEvents,
  type DurableTranscriptEvent,
  type TranscriptEntryData,
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

export function isDesktopRunBoundaryNotification(topic: string): boolean {
  return RUN_BOUNDARY_TOPICS.has(topic);
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
    // AgentEngine persisted this structured start atomically before emitting the
    // live timeline callback. Desktop must not create a second durable projection.
    if (isJsonRecord(data["canonicalTranscriptStart"])) return false;
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
    if (!providerCallId) return false;
    return persistTranscriptEvent(session, {
      sourceEventId: notification.eventId,
      create: (_snapshot, sequence, eventId) => ({
        eventId,
        sequence,
        createdAt: notification.at,
        type: "tool.started",
        entryId: runtimeTranscriptId("tool-entry", runId, notification.eventId),
        toolCallId: runtimeTranscriptId("tool-call", runId, notification.eventId),
        providerCallId,
        name,
        args,
      }),
    });
  }

  // Completion is a live presentation event. The durable transcript stores only
  // tool.started; hydration joins it with canonical tool.result.recorded.
  if (eventType === "tool.completed") return false;

  // Raw stdout/stderr stays out of the durable renderer projection. The bounded
  // ToolResult envelope above contains only projection text and an opaque Evidence ref.
  if (eventType === "tool.output") return false;

  if (eventType === "subagent.activity") {
    const activity = runtimeSubagentActivity(data);
    if (!activity || !isTerminalSubagentActivityStatus(activity.activity.status)) return false;
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

  // Subagent trace/claim events are live presentation state. The durable
  // transcript retains only terminal activity snapshots.
  return false;
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
        kind: request["kind"],
        planId: request["planId"],
        expectedRevision: request["expectedRevision"],
        expectedSessionSequence: request["expectedSessionSequence"],
        plan: request["plan"],
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
    readonly entry: TranscriptEntryData;
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
    ) => DurableTranscriptEvent | undefined;
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
  return (
    name === "todo" ||
    name === "submit_plan" ||
    name === "update_plan" ||
    name === "cancel_plan" ||
    name === "exit_plan_mode"
  );
}

function planTimelineTitle(name: string): string {
  if (name === "exit_plan_mode" || name === "submit_plan") return "Plan ready for approval";
  if (name === "cancel_plan") return "Plan cancelled";
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

function runtimeSubagentActivity(data: JsonObject):
  | {
      readonly activityId: string;
      readonly activity: Omit<SubagentActivityEvent, "activityId">;
    }
  | undefined {
  const activityId = optionalNonEmptyText(data["activityId"]);
  const task = optionalNonEmptyText(data["task"]);
  const status = data["status"];
  const mode = data["mode"];
  const completionPolicy = data["completionPolicy"];
  if (
    !activityId ||
    !task ||
    !isSubagentActivityStatus(status) ||
    !isOneOf(mode, ["explore", "worker"]) ||
    !isOneOf(completionPolicy, ["required", "optional", "detached"])
  ) {
    return undefined;
  }
  const agentName = optionalNonEmptyText(data["agentName"]);
  const currentAction = optionalNonEmptyText(data["currentAction"]);
  const summary = optionalNonEmptyText(data["summary"]);
  const requestedModelRoute = optionalNonEmptyText(data["requestedModelRoute"]);
  const resolvedModelRoute = optionalNonEmptyText(data["resolvedModelRoute"]);
  const thinkingEffort = optionalNonEmptyText(data["thinkingEffort"]);
  const activity: Omit<SubagentActivityEvent, "activityId"> = {
    task,
    status,
    mode,
    completionPolicy,
    ...(agentName ? { agentName } : {}),
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

function isTerminalSubagentActivityStatus(value: SubagentActivityEvent["status"]): boolean {
  return (
    value === "completed" ||
    value === "partial" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "cancelled"
  );
}

function isRuntimeRunStatus(
  value: unknown,
): value is Extract<TranscriptEntryData, { kind: "run-boundary" }>["status"] {
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
