import { createHash } from "node:crypto";
import type { Message } from "../schema/message.js";
import {
  RUNTIME_TOOL_OPERATION_SCHEMA_VERSION,
  type RuntimeToolOutcomeStatus,
  type RuntimeToolRecoveryMode,
} from "../storage/runtime-event.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";

export type RuntimeToolRecoveryDisposition = "not_dispatched" | "indeterminate" | "settled";

export interface RuntimeToolRecoveryState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsHash: string;
  readonly disposition: RuntimeToolRecoveryDisposition;
  readonly callEventId?: string;
  readonly operationId?: string;
  readonly recoveryMode?: RuntimeToolRecoveryMode;
  readonly dispatchEventId?: string;
  readonly outcomeEventId?: string;
  readonly resultEventId?: string;
}

interface MutableRuntimeToolRecoveryState {
  toolCallId: string;
  toolName: string;
  argumentsHash: string;
  callEventId?: string;
  operationId?: string;
  recoveryMode?: RuntimeToolRecoveryMode;
  dispatchEvent?: RuntimeEventStoreEntry;
  outcomeEvent?: RuntimeEventStoreEntry;
  resultEvent?: RuntimeEventStoreEntry;
  legacyDispatch: boolean;
}

export function canonicalRuntimeToolArgumentsHash(argumentsJson: string): string {
  try {
    return sha256(
      canonicalJson(["runtime-tool-arguments-v1", "json", JSON.parse(argumentsJson) as unknown]),
    );
  } catch {
    return sha256(canonicalJson(["runtime-tool-arguments-v1", "raw", argumentsJson]));
  }
}

export function canonicalRuntimeToolResultHash(message: Message): string {
  return sha256(canonicalJson(["runtime-tool-result-v1", message]));
}

export function runtimeToolOutcomeStatus(message: Message): RuntimeToolOutcomeStatus {
  if (message.providerData?.["picoKind"] !== "synthetic_tool_result") return "completed";
  return message.providerData["picoToolResultStatus"] === "cancelled" ? "cancelled" : "failed";
}

/**
 * Projects the three recovery states from one canonical RuntimeEvent prefix.
 *
 * A protocol-v1 dispatch is settled only by a valid outcome/result pair. Legacy
 * tool.started facts retain their historical result-based behavior.
 */
export function inspectRuntimeToolRecoveryStates(
  entries: readonly RuntimeEventStoreEntry[],
): RuntimeToolRecoveryState[] {
  const states: MutableRuntimeToolRecoveryState[] = [];
  const statesByToolCallId = new Map<string, MutableRuntimeToolRecoveryState[]>();
  const statesByOperationId = new Map<string, MutableRuntimeToolRecoveryState>();
  const entryByEventId = new Map(entries.map((entry) => [entry.event.eventId, entry]));

  const addState = (state: MutableRuntimeToolRecoveryState): void => {
    states.push(state);
    const matches = statesByToolCallId.get(state.toolCallId) ?? [];
    matches.push(state);
    statesByToolCallId.set(state.toolCallId, matches);
  };

  for (const entry of entries) {
    const event = entry.event;
    if (event.kind === "message.committed") {
      const message = event.data.message;
      if (message.role === "assistant") {
        for (const toolCall of message.toolCalls ?? []) {
          addState({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            argumentsHash: canonicalRuntimeToolArgumentsHash(toolCall.arguments),
            callEventId: event.eventId,
            legacyDispatch: false,
          });
        }
      } else if (message.role === "user" && message.toolCallId) {
        const state = statesByToolCallId
          .get(message.toolCallId)
          ?.find((candidate) => candidate.resultEvent === undefined);
        if (state) state.resultEvent = entry;
      }
      continue;
    }

    if (event.kind === "tool.started") {
      const toolCallId = requiredToolCallId(entry);
      const candidates = statesByToolCallId.get(toolCallId) ?? [];
      if (event.data.protocolVersion === RUNTIME_TOOL_OPERATION_SCHEMA_VERSION) {
        const state = candidates.find(
          (candidate) =>
            candidate.dispatchEvent === undefined &&
            candidate.resultEvent === undefined &&
            candidate.toolName === event.data.toolName &&
            candidate.argumentsHash === event.data.argumentsHash,
        );
        if (!state) {
          throw new Error(
            `Runtime tool dispatch ${event.eventId} has no matching canonical tool call`,
          );
        }
        if (statesByOperationId.has(event.data.operationId)) {
          throw new Error(
            `Runtime tool operation ${event.data.operationId} has multiple dispatch facts`,
          );
        }
        state.operationId = event.data.operationId;
        state.recoveryMode = event.data.recoveryMode;
        state.dispatchEvent = entry;
        statesByOperationId.set(event.data.operationId, state);
        continue;
      }

      let state = candidates.find(
        (candidate) => candidate.dispatchEvent === undefined && candidate.resultEvent === undefined,
      );
      if (!state) {
        state = {
          toolCallId,
          toolName: event.data.toolName,
          argumentsHash: event.data.argumentsHash,
          legacyDispatch: true,
        };
        addState(state);
      }
      state.legacyDispatch = true;
      state.dispatchEvent = entry;
      continue;
    }

    if (event.kind === "tool.outcome.recorded") {
      const state = statesByOperationId.get(event.data.operationId);
      if (!state?.dispatchEvent) {
        throw new Error(`Runtime tool outcome ${event.eventId} has no matching dispatch fact`);
      }
      if (state.outcomeEvent) {
        throw new Error(
          `Runtime tool operation ${event.data.operationId} has multiple outcome facts`,
        );
      }
      if (requiredToolCallId(entry) !== state.toolCallId) {
        throw new Error(`Runtime tool outcome ${event.eventId} changed its toolCallId`);
      }
      state.outcomeEvent = entry;
    }
  }

  return states.map((state): RuntimeToolRecoveryState => {
    let disposition: RuntimeToolRecoveryDisposition;
    let resultEventId = state.resultEvent?.event.eventId;
    if (!state.dispatchEvent) {
      disposition = "not_dispatched";
    } else if (state.legacyDispatch) {
      disposition =
        state.resultEvent &&
        state.resultEvent.event.kind === "message.committed" &&
        state.resultEvent.event.data.message.providerData?.["picoKind"] !== "synthetic_tool_result"
          ? "settled"
          : "indeterminate";
    } else if (!state.outcomeEvent) {
      disposition = "indeterminate";
    } else {
      const outcome = state.outcomeEvent.event;
      if (outcome.kind !== "tool.outcome.recorded") {
        throw new Error("Runtime tool outcome projection is internally inconsistent");
      }
      const dispatch = state.dispatchEvent.event;
      if (
        dispatch.kind !== "tool.started" ||
        dispatch.sessionId !== outcome.sessionId ||
        dispatch.runId !== outcome.runId ||
        dispatch.turnId !== outcome.turnId
      ) {
        throw new Error(`Runtime tool outcome ${outcome.eventId} changed its dispatch identity`);
      }
      const resultEntry = entryByEventId.get(outcome.data.resultEventId);
      if (!resultEntry || resultEntry.event.kind !== "message.committed") {
        throw new Error(`Runtime tool outcome ${outcome.eventId} references a missing result`);
      }
      if (
        resultEntry.sequence !== state.outcomeEvent.sequence + 1 ||
        resultEntry.event.sessionId !== outcome.sessionId ||
        resultEntry.event.runId !== outcome.runId ||
        resultEntry.event.turnId !== outcome.turnId ||
        resultEntry.event.at !== outcome.at
      ) {
        throw new Error(
          `Runtime tool outcome ${outcome.eventId} is not adjacent to its atomic result`,
        );
      }
      const result = resultEntry.event.data.message;
      if (
        result.role !== "user" ||
        result.toolCallId !== state.toolCallId ||
        resultEntry.event.refs?.toolCallId !== state.toolCallId ||
        canonicalRuntimeToolResultHash(result) !== outcome.data.resultHash ||
        runtimeToolOutcomeStatus(result) !== outcome.data.status
      ) {
        throw new Error(
          `Runtime tool outcome ${outcome.eventId} does not match its canonical result`,
        );
      }
      if (state.resultEvent?.event.eventId !== resultEntry.event.eventId) {
        throw new Error(
          `Runtime tool outcome ${outcome.eventId} is bound to a different tool-call occurrence`,
        );
      }
      resultEventId = resultEntry.event.eventId;
      disposition = "settled";
    }

    return {
      toolCallId: state.toolCallId,
      toolName: state.toolName,
      argumentsHash: state.argumentsHash,
      disposition,
      ...(state.callEventId ? { callEventId: state.callEventId } : {}),
      ...(state.operationId ? { operationId: state.operationId } : {}),
      ...(state.recoveryMode ? { recoveryMode: state.recoveryMode } : {}),
      ...(state.dispatchEvent ? { dispatchEventId: state.dispatchEvent.event.eventId } : {}),
      ...(state.outcomeEvent ? { outcomeEventId: state.outcomeEvent.event.eventId } : {}),
      ...(resultEventId ? { resultEventId } : {}),
    };
  });
}

function requiredToolCallId(entry: RuntimeEventStoreEntry): string {
  const toolCallId = entry.event.refs?.toolCallId;
  if (typeof toolCallId !== "string" || !toolCallId.trim()) {
    throw new Error(`Runtime ${entry.event.kind} ${entry.event.eventId} has no stable toolCallId`);
  }
  return toolCallId;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value !== "object") {
    throw new Error(`Canonical JSON does not support ${typeof value}`);
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
