import { isMessageHiddenFromTranscript } from "@pico/core";
import { createHash } from "node:crypto";
import type {
  RuntimeEvent,
  RuntimeToolResultRecordedEvent,
  RuntimeToolResultProjectionRecordedEvent,
} from "@pico/core";
import { archiveRuntimeToolResult } from "./tool-result-archive.js";
import {
  planActiveToolResultSupersession,
  type ActiveToolResultObservation,
} from "./active-tool-result-working-set.js";
import type { RuntimeHistoryProjectionEntry } from "./session-runtime-read-model.js";

type Projection = RuntimeToolResultRecordedEvent["data"]["projection"];
export function toolResultProjectionSha256(projection: Projection): string {
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

/** Replay transitions chronologically; the immutable original body is never changed. */
export function applyToolResultProjectionTransition(
  sources: Map<string, RuntimeToolResultRecordedEvent>,
  transition: RuntimeToolResultProjectionRecordedEvent,
): RuntimeToolResultRecordedEvent {
  const source = sources.get(transition.data.sourceEventId);
  if (
    !source ||
    source.sessionId !== transition.sessionId ||
    source.refs.toolCallId !== transition.refs.toolCallId ||
    source.visibility !== "model" ||
    source.partial ||
    toolResultProjectionSha256(source.data.projection) !== transition.data.sourceProjectionSha256
  ) {
    throw new Error(`Tool result projection ${transition.eventId} has an invalid source or digest`);
  }
  const updated = { ...source, data: { ...source.data, projection: transition.data.projection } };
  sources.set(source.eventId, updated);
  return updated;
}

export function effectiveRuntimeToolResults(
  events: readonly RuntimeEvent[],
): Map<string, RuntimeToolResultRecordedEvent> {
  const results = new Map<string, RuntimeToolResultRecordedEvent>();
  for (const event of events) {
    if (event.kind === "tool.result.recorded") results.set(event.eventId, event);
    else if (event.kind === "tool.result.projection.recorded")
      applyToolResultProjectionTransition(results, event);
  }
  return results;
}

export interface ToolResultProjectionPlan {
  readonly source: RuntimeToolResultRecordedEvent;
  readonly projection: Projection;
  readonly reason: RuntimeToolResultProjectionRecordedEvent["data"]["reason"];
  readonly supersededByToolCallId?: string;
}

/** Maka 5846521 thresholds and working-set decisions, adapted to Pico tool inputs. */
export function planToolResultProjections(
  events: readonly RuntimeEvent[],
  entries: readonly RuntimeHistoryProjectionEntry[],
  runId: string,
  stepNumber: number,
): ToolResultProjectionPlan[] {
  const effective = effectiveRuntimeToolResults(events);
  const current = entries.flatMap((entry) => {
    const result = effective.get(entry.eventId);
    return result ? [result] : [];
  });
  // Pico turnId is an assistant step. User messages are the stable send boundary.
  const turns = new Map<string, number>();
  let turn = 0;
  for (const entry of entries) {
    if (
      entry.message.role === "user" &&
      !entry.message.toolCallId &&
      !isMessageHiddenFromTranscript(entry.message)
    )
      turn++;
    turns.set(entry.eventId, turn);
  }
  const calls = new Map<string, { input: unknown; stepNumber: number }>();
  const steps = new Map<string, number>();
  const ambiguousCalls = new Set<string>();
  for (const event of events) {
    if (
      event.runId !== runId ||
      event.kind !== "message.committed" ||
      !event.data.message.toolCalls?.length
    )
      continue;
    const stepKey = event.refs?.stepId ?? event.turnId;
    if (!steps.has(stepKey)) steps.set(stepKey, steps.size);
    for (const call of event.data.message.toolCalls) {
      if (calls.has(call.id)) ambiguousCalls.add(call.id);
      let input: unknown;
      try {
        input = JSON.parse(call.arguments);
      } catch {
        input = call.arguments;
      }
      calls.set(call.id, { input, stepNumber: steps.get(stepKey)! });
    }
  }
  const observations: ActiveToolResultObservation[] = current.flatMap((source) => {
    const call = calls.get(source.refs.toolCallId);
    if (
      source.runId !== runId ||
      !call ||
      ambiguousCalls.has(source.refs.toolCallId) ||
      source.data.projection.strategy === "durable-tool-result-archive-v1"
    )
      return [];
    return [
      {
        ...call,
        toolCallId: source.refs.toolCallId,
        toolName: source.data.toolName,
        bodySha256: createHash("sha256")
          .update(JSON.stringify(source.data.projection.text))
          .digest("hex"),
        isError: source.data.status !== "succeeded",
        eligible: true,
      },
    ];
  });
  const supersessions = planActiveToolResultSupersession(observations);
  const plans: ToolResultProjectionPlan[] = [];
  for (const source of current) {
    if (source.data.projection.strategy === "durable-tool-result-archive-v1") continue;
    const estimatedTokens = Math.ceil(JSON.stringify(source.data.projection.text).length / 4);
    let reason: ToolResultProjectionPlan["reason"] | undefined;
    const supersession =
      source.runId === runId ? supersessions.get(source.refs.toolCallId) : undefined;
    if (source.runId === runId && stepNumber >= 1) {
      if (supersession ? estimatedTokens >= 256 : estimatedTokens > 2048)
        reason = supersession?.reason ?? "active_large";
    } else if ((turns.get(source.eventId) ?? turn) <= turn - 2 && estimatedTokens > 2048) {
      reason = "stale";
    }
    if (!reason) continue;
    const archived = archiveRuntimeToolResult(source, {
      force: true,
      reason,
      ...(supersession ? { supersededByToolCallId: supersession.supersededByToolCallId } : {}),
    });
    if (archived === source) continue;
    plans.push({
      source,
      projection: archived.data.projection,
      reason,
      ...(supersession ? { supersededByToolCallId: supersession.supersededByToolCallId } : {}),
    });
  }
  return plans;
}
