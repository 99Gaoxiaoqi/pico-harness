import type { RuntimeNotification } from "@pico/protocol";
import type { JsonRecord, TimelineItem } from "./model.js";

export const MAX_RENDERER_TIMELINE_ITEMS = 2_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Applies one durable timeline event while keeping transient inference status replaceable. */
export function applyTimelineNotification(
  timeline: readonly TimelineItem[],
  event: RuntimeNotification,
): readonly TimelineItem[] {
  const payload = isRecord(event.payload) ? event.payload : {};
  const item = isRecord(payload.item) ? payload.item : {};
  const eventType = stringValue(item.eventType) || undefined;
  const runId = stringValue(event.scope.runId ?? payload.runId) || undefined;
  const id = stringValue(item.id ?? event.eventId, `timeline-${Date.now()}`);
  const next: TimelineItem = {
    id,
    kind:
      item.kind === "plan" || item.kind === "tool" || item.kind === "agent" ? item.kind : "status",
    title: stringValue(item.title ?? item.message, "运行状态已更新"),
    detail: stringValue(item.detail),
    state: item.state === "failed" ? "failed" : item.state === "done" ? "done" : "active",
    at: numberValue(event.at, Date.now()),
    sessionId: stringValue(event.scope.sessionId) || undefined,
    runId,
    eventType,
  };
  const inferenceStatus = eventType === "assistant.thinking";
  const retained = timeline.filter((candidate) =>
    inferenceStatus
      ? candidate.runId !== runId || candidate.eventType !== "assistant.thinking"
      : candidate.id !== id,
  );
  const data = isRecord(item.data) ? item.data : {};
  if (inferenceStatus && data.active === false) return retained;
  return [...retained, next].slice(-MAX_RENDERER_TIMELINE_ITEMS);
}
