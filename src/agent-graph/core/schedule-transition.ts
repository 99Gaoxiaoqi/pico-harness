import type {
  AgentGraph,
  AgentGraphActivationIntent,
  AgentGraphOperator,
  AgentGraphRecordRef,
  AgentGraphScheduleCommand,
  AgentGraphScheduleRevision,
  AgentGraphScheduleState,
  AgentGraphStopTarget,
} from "./contracts.js";
import { scheduleOperationFingerprint } from "./ids.js";

export class AgentGraphConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGraphConflictError";
  }
}

export interface AgentGraphTransitionResult {
  readonly state: AgentGraphScheduleState;
  readonly applied: boolean;
  readonly revision: number;
}

export interface AgentGraphTransitionContext {
  /** When present, this is the authoritative RecordRef set visible to the transition. */
  readonly knownRecords?: readonly AgentGraphRecordRef[];
}

export function createAgentGraphScheduleState(graph: AgentGraph): AgentGraphScheduleState {
  if (!graph.graphId.trim()) throw new AgentGraphConflictError("Graph id must not be empty");
  if (!graph.rootSessionId.trim()) {
    throw new AgentGraphConflictError("Graph root session id must not be empty");
  }
  if (!Number.isSafeInteger(graph.epoch) || graph.epoch < 1) {
    throw new AgentGraphConflictError("Graph epoch must be a positive safe integer");
  }
  if (graph.headRevision !== 0) {
    throw new AgentGraphConflictError("A new Graph schedule must start at revision 0");
  }
  return { graph, operators: [], intents: [], stops: [], revisions: [], operations: [] };
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new AgentGraphConflictError(`${label} must not be empty`);
}

function assertAddCommand(
  state: AgentGraphScheduleState,
  revision: AgentGraphScheduleRevision,
  command: Extract<AgentGraphScheduleCommand, { kind: "add" }>,
): void {
  if (state.graph.admissionPhase !== "open") {
    throw new AgentGraphConflictError("Graph is sealed and cannot admit new work");
  }
  const { operator, intent } = command;
  if (operator.graphId !== state.graph.graphId || intent.graphId !== state.graph.graphId) {
    throw new AgentGraphConflictError("Added Operator and Intent must belong to the Graph");
  }
  assertNonEmpty(operator.operatorId, "Operator id");
  assertNonEmpty(operator.role, "Operator role");
  if (!Number.isSafeInteger(operator.generation) || operator.generation < 1) {
    throw new AgentGraphConflictError("Operator generation must be a positive safe integer");
  }
  if (state.operators.some((item) => item.operatorId === operator.operatorId)) {
    throw new AgentGraphConflictError(`Operator already exists: ${operator.operatorId}`);
  }
  assertActivationIntent(state, revision, intent, operator);
}

function assertActivateCommand(
  state: AgentGraphScheduleState,
  revision: AgentGraphScheduleRevision,
  command: Extract<AgentGraphScheduleCommand, { kind: "activate" }>,
): void {
  if (state.graph.admissionPhase !== "open") {
    throw new AgentGraphConflictError("Graph is sealed and cannot admit new work");
  }
  const operator = state.operators.find(
    (item) =>
      item.operatorId === command.intent.operatorId &&
      item.generation === command.intent.operatorGeneration,
  );
  if (!operator) {
    throw new AgentGraphConflictError(
      `Cannot activate unknown Operator generation: ${command.intent.operatorId}@${command.intent.operatorGeneration}`,
    );
  }
  const operatorStopped = state.stops.some(
    (stop) =>
      stop.target.kind === "operator" &&
      stop.target.operatorId === operator.operatorId &&
      stop.target.generation === operator.generation,
  );
  if (operatorStopped) {
    throw new AgentGraphConflictError(
      `Cannot activate stopped Operator generation: ${operator.operatorId}@${operator.generation}`,
    );
  }
  assertActivationIntent(state, revision, command.intent, operator);
}

function assertActivationIntent(
  state: AgentGraphScheduleState,
  revision: AgentGraphScheduleRevision,
  intent: AgentGraphActivationIntent,
  operator: AgentGraphOperator,
): void {
  if (intent.graphId !== state.graph.graphId) {
    throw new AgentGraphConflictError("Activation Intent must belong to the Graph");
  }
  assertNonEmpty(intent.intentId, "Activation Intent id");
  assertNonEmpty(intent.instruction, "Activation Intent instruction");
  if (
    intent.operatorId !== operator.operatorId ||
    intent.operatorGeneration !== operator.generation
  ) {
    throw new AgentGraphConflictError("Activation Intent must target its Operator generation");
  }
  if (intent.createdAtRevision !== revision.revision) {
    throw new AgentGraphConflictError(
      "Activation Intent createdAtRevision must match its revision",
    );
  }
  if (state.intents.some((item) => item.intentId === intent.intentId)) {
    throw new AgentGraphConflictError(`Activation Intent already exists: ${intent.intentId}`);
  }
  if (new Set(intent.inputRefs.map((input) => input.recordId)).size !== intent.inputRefs.length) {
    throw new AgentGraphConflictError("Activation Intent input record ids must be unique");
  }
  for (const input of intent.inputRefs) assertNonEmpty(input.recordId, "Input record id");
}

function targetExists(state: AgentGraphScheduleState, target: AgentGraphStopTarget): boolean {
  if (target.kind === "intent") {
    return state.intents.some((intent) => intent.intentId === target.intentId);
  }
  return state.operators.some(
    (operator) =>
      operator.operatorId === target.operatorId && operator.generation === target.generation,
  );
}

function applyCommand(
  state: AgentGraphScheduleState,
  revision: AgentGraphScheduleRevision,
  command: AgentGraphScheduleCommand,
  context: AgentGraphTransitionContext,
): AgentGraphScheduleState {
  switch (command.kind) {
    case "add":
      assertAddCommand(state, revision, command);
      return {
        ...state,
        operators: [...state.operators, command.operator],
        intents: [...state.intents, command.intent],
      };
    case "activate":
      assertActivateCommand(state, revision, command);
      return { ...state, intents: [...state.intents, command.intent] };
    case "stop":
      if (!targetExists(state, command.target)) {
        throw new AgentGraphConflictError("Cannot stop an unknown Graph target");
      }
      return { ...state, stops: [...state.stops, command] };
    case "finish":
      if (state.graph.admissionPhase === "sealed") {
        throw new AgentGraphConflictError("Graph is already sealed");
      }
      for (const recordId of command.selectedRecordIds ?? []) {
        assertNonEmpty(recordId, "Selected record id");
      }
      if (
        new Set(command.selectedRecordIds ?? []).size !== (command.selectedRecordIds ?? []).length
      ) {
        throw new AgentGraphConflictError("Selected record ids must be unique");
      }
      if (context.knownRecords) {
        const recordsById = new Map(
          context.knownRecords.map((recordRef) => [recordRef.recordId, recordRef]),
        );
        for (const recordId of command.selectedRecordIds ?? []) {
          const recordRef = recordsById.get(recordId);
          if (!recordRef) {
            throw new AgentGraphConflictError(`Selected RecordRef does not exist: ${recordId}`);
          }
          if (recordRef.graphId !== state.graph.graphId) {
            throw new AgentGraphConflictError(
              `Selected RecordRef ${recordId} belongs to another Graph`,
            );
          }
        }
      }
      return {
        ...state,
        graph: {
          ...state.graph,
          admissionPhase: "sealed",
          selectedRecordIds: [...(command.selectedRecordIds ?? [])],
          sealedAt: revision.createdAt,
        },
      };
  }
}

export function applyScheduleRevision(
  state: AgentGraphScheduleState,
  revision: AgentGraphScheduleRevision,
  context: AgentGraphTransitionContext = {},
): AgentGraphTransitionResult {
  if (revision.graphId !== state.graph.graphId) {
    throw new AgentGraphConflictError("Schedule revision belongs to another Graph");
  }
  const expectedFingerprint = scheduleOperationFingerprint(revision);
  if (revision.fingerprint !== expectedFingerprint) {
    throw new AgentGraphConflictError("Schedule operation fingerprint does not match its payload");
  }

  const priorOperation = state.operations.find(
    (operation) => operation.operationId === revision.operationId,
  );
  if (priorOperation) {
    if (priorOperation.fingerprint !== revision.fingerprint) {
      throw new AgentGraphConflictError(
        `Schedule operation id was reused with a different payload: ${revision.operationId}`,
      );
    }
    return { state, applied: false, revision: priorOperation.revision };
  }

  if (revision.expectedPreviousRevision !== state.graph.headRevision) {
    throw new AgentGraphConflictError(
      `Schedule revision expected ${revision.expectedPreviousRevision}, current is ${state.graph.headRevision}`,
    );
  }
  if (revision.revision !== state.graph.headRevision + 1) {
    throw new AgentGraphConflictError(
      `Schedule revision must be ${state.graph.headRevision + 1}, received ${revision.revision}`,
    );
  }
  if (revision.commands.length === 0) {
    throw new AgentGraphConflictError("Schedule revision must contain at least one command");
  }
  const hasFinish = revision.commands.some((command) => command.kind === "finish");
  const hasFreshWork = revision.commands.some(
    (command) => command.kind === "add" || command.kind === "activate",
  );
  if (hasFinish && hasFreshWork) {
    throw new AgentGraphConflictError(
      "Schedule finish cannot be combined with add or activate commands",
    );
  }

  let next = state;
  for (const command of revision.commands) {
    next = applyCommand(next, revision, command, context);
  }
  next = {
    ...next,
    graph: { ...next.graph, headRevision: revision.revision },
    revisions: [...next.revisions, revision],
    operations: [
      ...next.operations,
      {
        operationId: revision.operationId,
        fingerprint: revision.fingerprint,
        revision: revision.revision,
      },
    ],
  };
  return { state: next, applied: true, revision: revision.revision };
}

export function isIntentStopped(
  state: AgentGraphScheduleState,
  intent: AgentGraphActivationIntent,
): boolean {
  return state.stops.some((stop) => {
    const target = stop.target;
    return target.kind === "intent"
      ? target.intentId === intent.intentId
      : target.operatorId === intent.operatorId && target.generation === intent.operatorGeneration;
  });
}

export function canAdmitIntent(
  state: AgentGraphScheduleState,
  intent: AgentGraphActivationIntent,
): boolean {
  return state.graph.admissionPhase === "open" && !isIntentStopped(state, intent);
}
