import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentGraphOutputLedgerPort,
  CommittedAgentOutputSource,
} from "./agent-graph-runtime-adapter.js";
import type { GraphOperatorActivationContext } from "../tools/agent-output-tool.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  decodeRuntimeEvent,
  decodeRuntimeEventJson,
  type RuntimeAgentOutputEvent,
} from "../storage/runtime-event.js";
import {
  RuntimeEventStoreIntegrityError,
  RuntimeEventStoreOwnerFenceError,
  type RuntimeOwnerFence,
} from "../storage/runtime-event-store-contracts.js";
import {
  appendRuntimeEventWithArbitration,
  type SqliteRuntimeEventStore,
} from "../storage/sqlite/sqlite-runtime-event-store.js";

export interface AgentGraphOutputOwnerFencePort {
  /** Must return the live positive owner epoch for this exact child Session. */
  assertAgentOutputWriteAllowed(sessionId: string): Promise<RuntimeOwnerFence>;
}

export interface SqliteAgentGraphOutputLedgerOptions {
  readonly store: SqliteRuntimeEventStore;
  readonly ownerFencePort: AgentGraphOutputOwnerFencePort;
  readonly now?: () => Date;
}

export class AgentGraphOutputLedgerIntegrityError extends RuntimeEventStoreIntegrityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentGraphOutputLedgerIntegrityError";
  }
}

export class AgentGraphOutputReplayConflictError extends AgentGraphOutputLedgerIntegrityError {
  constructor(
    readonly idempotencyKey: string,
    options?: ErrorOptions,
  ) {
    super(`agent.output idempotency key is bound to another output: ${idempotencyKey}`, options);
    this.name = "AgentGraphOutputReplayConflictError";
  }
}

/**
 * Runtime-ledger implementation of the canonical Graph operator output boundary.
 *
 * The event id is derived from the activation idempotency key, so SQLite's global
 * event_id primary key is the atomic uniqueness point. A racing replay that loses
 * the insert reads back that exact row and accepts it only when the semantic
 * payload and activation identities match.
 */
export class SqliteAgentGraphOutputLedger implements AgentGraphOutputLedgerPort {
  constructor(private readonly options: SqliteAgentGraphOutputLedgerOptions) {}

  async commitAgentOutputEvent(
    input: Parameters<AgentGraphOutputLedgerPort["commitAgentOutputEvent"]>[0],
  ): Promise<CommittedAgentOutputSource> {
    assertExpectedEventId(input.eventId, input.payload.idempotencyKey);
    assertCommitEnvelope(input);
    const runStarted = await this.requireRunStarted(input.activation);
    const ownerFence = await this.requireCurrentOwnerFence(input.activation.sessionId);

    const existing = await this.readAgentOutputEvent(input.eventId);
    if (existing) return acceptReplay(existing, input, runStarted.invocationId);

    const now = (this.options.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) {
      throw new AgentGraphOutputLedgerIntegrityError("agent.output clock returned an invalid date");
    }
    const event = decodeAgentOutputEvent({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: input.eventId,
      sessionId: input.activation.sessionId,
      invocationId: runStarted.invocationId,
      runId: input.activation.runId,
      turnId: input.activation.turnId,
      at: now.toISOString(),
      partial: false,
      visibility: "internal",
      refs: { toolCallId: input.toolCallId },
      kind: "agent.output",
      data: {
        toolCallId: input.toolCallId,
        idempotencyKey: input.payload.idempotencyKey,
        fingerprint: input.payload.fingerprint,
        payload: input.payload,
      },
    });

    try {
      const result = await appendRuntimeEventWithArbitration(this.options.store, event, {
        ownerFence,
      });
      return sourceFromEvent(event, result.inserted);
    } catch (error) {
      // Cross-process replay may have won after our point read. Only the exact
      // deterministic event id can arbitrate that race; every mismatch fails closed.
      const raced = await this.readAgentOutputEvent(input.eventId).catch(() => undefined);
      if (!raced) throw error;
      return acceptReplay(raced, input, runStarted.invocationId, error);
    }
  }

  async readAgentOutputEvent(eventId: string): Promise<CommittedAgentOutputSource | undefined> {
    const rows = await this.options.store.readEventRowsByEventIds([eventId]);
    const row = rows.get(eventId);
    if (!row) return undefined;
    const event = decodeRuntimeEventJson(row.payloadJson);
    if (event.kind !== "agent.output") {
      throw new AgentGraphOutputLedgerIntegrityError(
        `Runtime event ${eventId} is not an agent.output fact`,
      );
    }
    if (event.sessionId !== row.sessionId || event.eventId !== row.eventId) {
      throw new AgentGraphOutputLedgerIntegrityError(
        `Runtime event ${eventId} point-read identity is inconsistent`,
      );
    }
    return sourceFromEvent(event, false);
  }

  async listAgentOutputEvents(
    sessionId: string,
    runId: string,
  ): Promise<readonly CommittedAgentOutputSource[]> {
    requireIdentity(sessionId, "sessionId");
    requireIdentity(runId, "runId");
    const entries = await this.options.store.readSessionEventsForRun(sessionId, runId, {
      kind: "agent.output",
    });
    return entries.map(({ event }) => {
      if (event.kind !== "agent.output") {
        throw new AgentGraphOutputLedgerIntegrityError(
          `Runtime run ${runId} returned a non-agent.output event from its kind index`,
        );
      }
      return sourceFromEvent(event, false);
    });
  }

  private async requireRunStarted(
    activation: GraphOperatorActivationContext,
  ): Promise<Extract<ReturnType<typeof decodeRuntimeEvent>, { kind: "run.started" }>> {
    const entries = await this.options.store.readSessionEventsForRun(
      activation.sessionId,
      activation.runId,
      { kind: "run.started", limit: 2 },
    );
    if (entries.length !== 1 || entries[0]!.event.kind !== "run.started") {
      throw new AgentGraphOutputLedgerIntegrityError(
        `agent.output target RuntimeRun must have exactly one run.started fact: ${activation.runId}`,
      );
    }
    const started = entries[0]!.event;
    if (
      started.sessionId !== activation.sessionId ||
      started.turnId !== activation.turnId ||
      started.runId !== activation.runId
    ) {
      throw new AgentGraphOutputLedgerIntegrityError(
        `agent.output activation does not match RuntimeRun ${activation.runId}`,
      );
    }
    return started;
  }

  private async requireCurrentOwnerFence(sessionId: string): Promise<RuntimeOwnerFence> {
    const ownerFence = await this.options.ownerFencePort.assertAgentOutputWriteAllowed(sessionId);
    if (
      ownerFence.sessionId !== sessionId ||
      !Number.isSafeInteger(ownerFence.epoch) ||
      ownerFence.epoch <= 0
    ) {
      throw new AgentGraphOutputLedgerIntegrityError(
        `agent.output owner fence does not own child Session ${sessionId}`,
      );
    }
    const current = await this.options.store.readOwnerFence(sessionId);
    if (current.epoch !== ownerFence.epoch) {
      throw new RuntimeEventStoreOwnerFenceError(sessionId, ownerFence.epoch, current.epoch);
    }
    return ownerFence;
  }
}

export function agentOutputRuntimeEventId(idempotencyKey: string): string {
  return `agent-output-event:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function acceptReplay(
  existing: CommittedAgentOutputSource,
  input: Parameters<AgentGraphOutputLedgerPort["commitAgentOutputEvent"]>[0],
  invocationId: string,
  cause?: unknown,
): CommittedAgentOutputSource {
  if (
    existing.eventId !== input.eventId ||
    existing.sessionId !== input.activation.sessionId ||
    existing.turnId !== input.activation.turnId ||
    existing.runId !== input.activation.runId ||
    existing.invocationId !== invocationId ||
    existing.payload.idempotencyKey !== input.payload.idempotencyKey ||
    existing.payload.fingerprint !== input.payload.fingerprint ||
    !isDeepStrictEqual(existing.payload, input.payload)
  ) {
    throw new AgentGraphOutputReplayConflictError(input.payload.idempotencyKey, {
      cause,
    });
  }
  return { ...existing, inserted: false };
}

function assertExpectedEventId(eventId: string, idempotencyKey: string): void {
  const expected = agentOutputRuntimeEventId(idempotencyKey);
  if (eventId !== expected) {
    throw new AgentGraphOutputLedgerIntegrityError(
      `agent.output eventId must be derived from its idempotency key: expected ${expected}`,
    );
  }
}

function assertCommitEnvelope(
  input: Parameters<AgentGraphOutputLedgerPort["commitAgentOutputEvent"]>[0],
): void {
  requireIdentity(input.toolCallId, "toolCallId");
  const activation = input.activation;
  for (const [field, value] of [
    ["graphId", activation.graphId],
    ["operatorId", activation.operatorId],
    ["activationId", activation.activationId],
    ["sessionId", activation.sessionId],
    ["turnId", activation.turnId],
    ["runId", activation.runId],
  ] as const) {
    requireIdentity(value, field);
  }
  if (!Number.isSafeInteger(activation.operatorGeneration) || activation.operatorGeneration < 1) {
    throw new AgentGraphOutputLedgerIntegrityError(
      "agent.output operatorGeneration must be a positive integer",
    );
  }
  const payload = input.payload;
  if (
    payload.graphId !== activation.graphId ||
    payload.operatorId !== activation.operatorId ||
    payload.operatorGeneration !== activation.operatorGeneration ||
    payload.activationId !== activation.activationId
  ) {
    throw new AgentGraphOutputLedgerIntegrityError(
      "agent.output payload does not match its activation identity",
    );
  }
}

function requireIdentity(value: string, field: string): void {
  if (!value.trim() || value !== value.trim() || /\p{Cc}|\s/u.test(value)) {
    throw new AgentGraphOutputLedgerIntegrityError(`agent.output ${field} is invalid`);
  }
}

function decodeAgentOutputEvent(value: RuntimeAgentOutputEvent): RuntimeAgentOutputEvent {
  const event = decodeRuntimeEvent(value);
  if (event.kind !== "agent.output") {
    throw new AgentGraphOutputLedgerIntegrityError("agent.output codec returned another kind");
  }
  return event;
}

function sourceFromEvent(
  event: RuntimeAgentOutputEvent,
  inserted: boolean,
): CommittedAgentOutputSource {
  return {
    eventId: event.eventId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    runId: event.runId,
    invocationId: event.invocationId,
    partial: false,
    committed: true,
    payload: event.data.payload,
    inserted,
  };
}
