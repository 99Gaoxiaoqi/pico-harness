import type {
  AgentGraphActivationClaim,
  AgentGraphActivationIntent,
  AgentGraphOperator,
  AgentGraphOperatorProvision,
  AgentGraphReadiness,
  AgentGraphRecordRef,
} from "./core/index.js";
import {
  canAdmitIntent,
  claimIdFor,
  deterministicFingerprint,
  isIntentStopped,
  provisionIdFor,
  recordIdFor,
  resolveIntentReadiness,
} from "./core/index.js";
import type { AgentGraphControlStore } from "./control-store.js";
import type {
  AgentGraphActivationIdentity,
  AgentGraphIdentityFactory,
  AgentGraphProvisionIdentity,
  AgentGraphRuntimePort,
  AgentGraphRuntimeProjection,
  AgentGraphRuntimeRecordCandidate,
} from "./runtime-port.js";

export type AgentGraphReconcilePhase =
  | "load"
  | "stop"
  | "provision"
  | "resolve-inputs"
  | "claim"
  | "begin-executing"
  | "project-record";

export interface AgentGraphReconcileError {
  readonly phase: AgentGraphReconcilePhase;
  readonly subjectId: string;
  readonly message: string;
}

export interface AgentGraphWakeCandidate {
  readonly dedupeKey: string;
  readonly cause: "runtime_terminal";
  readonly payload: {
    readonly graphId: string;
    readonly claimId: string;
    readonly runId: string;
    readonly status: AgentGraphRuntimeProjection["status"];
    readonly terminalEventId?: string;
  };
}

export interface AgentGraphReconcileResult {
  readonly graphId: string;
  readonly headRevision: number;
  readonly passes: number;
  readonly quiescent: boolean;
  readonly progressCount: number;
  readonly wakeCandidates: readonly AgentGraphWakeCandidate[];
  readonly errors: readonly AgentGraphReconcileError[];
}

export interface AgentGraphReconcilerOptions {
  readonly store: AgentGraphControlStore;
  readonly runtime: AgentGraphRuntimePort;
  readonly identities?: AgentGraphIdentityFactory;
  readonly now?: () => number;
  readonly maxPasses?: number;
}

interface MutablePassResult {
  progress: number;
  readonly errors: AgentGraphReconcileError[];
  readonly wakes: AgentGraphWakeCandidate[];
}

interface ResolvedIntent {
  readonly intent: AgentGraphActivationIntent;
  readonly operator: AgentGraphOperator;
  readonly provision: AgentGraphOperatorProvision;
  readonly readiness: AgentGraphReadiness;
}

/**
 * Advances one Graph until no additional durable control-plane fact can be
 * committed. Runtime callbacks are idempotent observers/actuators; their
 * failures are reported but never roll back or rewrite committed authority.
 */
export class AgentGraphReconciler {
  private readonly store: AgentGraphControlStore;
  private readonly runtime: AgentGraphRuntimePort;
  private readonly identities: AgentGraphIdentityFactory;
  private readonly now: () => number;
  private readonly maxPasses: number;

  constructor(options: AgentGraphReconcilerOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.identities = options.identities ?? deterministicAgentGraphIdentities;
    this.now = options.now ?? Date.now;
    this.maxPasses = options.maxPasses ?? 64;
    if (!Number.isSafeInteger(this.maxPasses) || this.maxPasses < 1) {
      throw new Error("AgentGraph reconciler maxPasses must be a positive safe integer");
    }
  }

  async reconcile(graphId: string): Promise<AgentGraphReconcileResult> {
    if (!graphId.trim()) throw new Error("Graph id must not be empty");
    const errors: AgentGraphReconcileError[] = [];
    const wakes = new Map<string, AgentGraphWakeCandidate>();
    let progressCount = 0;
    let passes = 0;
    let quiescent = false;

    for (; passes < this.maxPasses; passes += 1) {
      const pass: MutablePassResult = { progress: 0, errors, wakes: [] };
      try {
        await this.drivePass(graphId, pass);
      } catch (error) {
        errors.push(reconcileError("load", graphId, error));
        break;
      }
      progressCount += pass.progress;
      for (const wake of pass.wakes) wakes.set(wake.dedupeKey, wake);
      if (pass.progress === 0) {
        quiescent = true;
        passes += 1;
        break;
      }
    }

    const state = this.store.getScheduleState(graphId);
    return {
      graphId,
      headRevision: state.graph.headRevision,
      passes,
      quiescent,
      progressCount,
      wakeCandidates: [...wakes.values()],
      errors,
    };
  }

  private async drivePass(graphId: string, pass: MutablePassResult): Promise<void> {
    const state = this.store.getScheduleState(graphId);
    let claims = [...this.store.listActivationClaims(graphId)];
    let provisions = [...this.store.listOperatorProvisions(graphId)];
    const records = [...this.store.listRecordRefs(graphId)];
    const intentsById = new Map(state.intents.map((intent) => [intent.intentId, intent]));
    const operatorsByKey = new Map(
      state.operators.map((operator) => [
        operatorKey(operator.operatorId, operator.generation),
        operator,
      ]),
    );

    await this.applyStops(state, claims, provisions, intentsById, pass);
    claims = [...this.store.listActivationClaims(graphId)];
    provisions = [...this.store.listOperatorProvisions(graphId)];

    const ensuredOperators = await this.ensureOperators(
      state,
      claims,
      provisions,
      operatorsByKey,
      pass,
    );
    provisions = [...this.store.listOperatorProvisions(graphId)];

    const resolved = await this.resolveInputs(
      state,
      claims,
      provisions,
      records,
      operatorsByKey,
      ensuredOperators,
      pass,
    );

    await this.claimReadyIntents(state, claims, records, resolved, pass);
    claims = [...this.store.listActivationClaims(graphId)];

    const projections = await this.beginAndObserveActivations(
      state,
      claims,
      records,
      intentsById,
      operatorsByKey,
      ensuredOperators,
      pass,
    );

    this.projectRecords(graphId, claims, projections, pass);
    const latestRevision = this.store.getScheduleState(graphId).graph.headRevision;
    if (latestRevision !== state.graph.headRevision) pass.progress += 1;
  }

  private async applyStops(
    state: ReturnType<AgentGraphControlStore["getScheduleState"]>,
    claims: readonly AgentGraphActivationClaim[],
    provisions: readonly AgentGraphOperatorProvision[],
    intentsById: ReadonlyMap<string, AgentGraphActivationIntent>,
    pass: MutablePassResult,
  ): Promise<void> {
    await Promise.all(
      claims.map(async (claim) => {
        if (claim.state === "cancelled") return;
        const intent = intentsById.get(claim.intentId);
        if (!intent || !isIntentStopped(state, intent)) return;
        const stop = [...state.stops]
          .reverse()
          .find((candidate) =>
            candidate.target.kind === "intent"
              ? candidate.target.intentId === intent.intentId
              : candidate.target.operatorId === intent.operatorId &&
                candidate.target.generation === intent.operatorGeneration,
          );
        const reason = stop?.reason ?? "Stopped by Graph schedule";
        try {
          if (claim.state === "executing") {
            await this.runtime.stopActivation({ claim, reason });
          }
          const result = this.store.transitionActivationClaim({
            claimId: claim.claimId,
            from: claim.state,
            to: "cancelled",
            cancellationReason: reason,
          });
          if (!result.replayed) pass.progress += 1;
        } catch (error) {
          pass.errors.push(reconcileError("stop", claim.claimId, error));
        }
      }),
    );

    const currentClaims = this.store.listActivationClaims(state.graph.graphId);
    for (const provision of provisions) {
      if (provision.state === "stopped") continue;
      const stopped = state.stops.some(
        (stop) =>
          stop.target.kind === "operator" &&
          stop.target.operatorId === provision.operatorId &&
          stop.target.generation === provision.operatorGeneration,
      );
      if (!stopped) continue;
      const hasActiveClaim = currentClaims.some(
        (claim) =>
          claim.operatorId === provision.operatorId &&
          claim.operatorGeneration === provision.operatorGeneration &&
          claim.state !== "cancelled",
      );
      if (hasActiveClaim) continue;
      try {
        let current = provision;
        if (current.state === "provisioned") {
          const stopping = this.store.transitionOperatorProvision({
            provisionId: current.provisionId,
            expectedVersion: current.version,
            from: "provisioned",
            to: "stopping",
          });
          current = stopping.record;
          if (!stopping.replayed) pass.progress += 1;
        }
        if (current.state === "requested" || current.state === "stopping") {
          const stoppedResult = this.store.transitionOperatorProvision({
            provisionId: current.provisionId,
            expectedVersion: current.version,
            from: current.state,
            to: "stopped",
          });
          if (!stoppedResult.replayed) pass.progress += 1;
        }
      } catch (error) {
        pass.errors.push(reconcileError("stop", provision.provisionId, error));
      }
    }
  }

  private async ensureOperators(
    state: ReturnType<AgentGraphControlStore["getScheduleState"]>,
    claims: readonly AgentGraphActivationClaim[],
    provisions: readonly AgentGraphOperatorProvision[],
    operatorsByKey: ReadonlyMap<string, AgentGraphOperator>,
    pass: MutablePassResult,
  ): Promise<ReadonlySet<string>> {
    const provisionsByKey = new Map(
      provisions.map((provision) => [
        operatorKey(provision.operatorId, provision.operatorGeneration),
        provision,
      ]),
    );
    const claimsByIntent = new Map(claims.map((claim) => [claim.intentId, claim]));
    const needed = new Map<
      string,
      { operator: AgentGraphOperator; provision: AgentGraphOperatorProvision }
    >();

    for (const intent of state.intents) {
      const key = operatorKey(intent.operatorId, intent.operatorGeneration);
      const operator = operatorsByKey.get(key);
      if (!operator) continue;
      const claim = claimsByIntent.get(intent.intentId);
      if (!claim && (!canAdmitIntent(state, intent) || state.graph.admissionPhase !== "open")) {
        continue;
      }
      let provision = provisionsByKey.get(key);
      if (!provision) {
        const identity = this.identities.provision(operator);
        const candidate = createProvision(operator, identity, this.now());
        try {
          const result = this.store.ensureOperatorProvision({
            provision: candidate,
            scheduleRevision: intent.createdAtRevision,
            provisionFingerprint: deterministicFingerprint({
              operator,
              childSessionId: identity.childSessionId,
            }),
          });
          provision = result.record;
          provisionsByKey.set(key, provision);
          if (!result.replayed) pass.progress += 1;
        } catch (error) {
          pass.errors.push(reconcileError("provision", intent.intentId, error));
          continue;
        }
      }
      needed.set(key, { operator, provision });
    }

    const ensured = new Set<string>();
    await Promise.all(
      [...needed].map(async ([key, item]) => {
        try {
          if (item.provision.state === "stopping" || item.provision.state === "stopped") return;
          await this.runtime.ensureOperator(item);
          if (item.provision.state === "requested") {
            const transitioned = this.store.transitionOperatorProvision({
              provisionId: item.provision.provisionId,
              expectedVersion: item.provision.version,
              from: "requested",
              to: "provisioned",
            });
            if (!transitioned.replayed) pass.progress += 1;
            if (transitioned.record.state !== "provisioned") return;
          }
          ensured.add(key);
        } catch (error) {
          pass.errors.push(reconcileError("provision", item.operator.operatorId, error));
        }
      }),
    );
    return ensured;
  }

  private async resolveInputs(
    state: ReturnType<AgentGraphControlStore["getScheduleState"]>,
    claims: readonly AgentGraphActivationClaim[],
    provisions: readonly AgentGraphOperatorProvision[],
    records: readonly AgentGraphRecordRef[],
    operatorsByKey: ReadonlyMap<string, AgentGraphOperator>,
    ensuredOperators: ReadonlySet<string>,
    pass: MutablePassResult,
  ): Promise<readonly ResolvedIntent[]> {
    const claimedIntentIds = new Set(claims.map((claim) => claim.intentId));
    const provisionsByKey = new Map(
      provisions.map((provision) => [
        operatorKey(provision.operatorId, provision.operatorGeneration),
        provision,
      ]),
    );
    const candidates = state.intents.filter((intent) => {
      const key = operatorKey(intent.operatorId, intent.operatorGeneration);
      return (
        !claimedIntentIds.has(intent.intentId) &&
        canAdmitIntent(state, intent) &&
        ensuredOperators.has(key) &&
        provisionsByKey.get(key)?.state === "provisioned"
      );
    });
    const results = await Promise.all(
      candidates.map(async (intent): Promise<ResolvedIntent | undefined> => {
        const key = operatorKey(intent.operatorId, intent.operatorGeneration);
        const operator = operatorsByKey.get(key);
        const provision = provisionsByKey.get(key);
        if (!operator || !provision) return undefined;
        try {
          const observedFacts = await this.runtime.resolveInputFacts({
            intent,
            knownRecords: records,
            claims,
          });
          const facts = {
            ...observedFacts,
            records: mergeRecords(records, observedFacts.records),
          };
          return {
            intent,
            operator,
            provision,
            readiness: resolveIntentReadiness(intent, facts),
          };
        } catch (error) {
          pass.errors.push(reconcileError("resolve-inputs", intent.intentId, error));
          return undefined;
        }
      }),
    );
    return results.filter((result): result is ResolvedIntent => result !== undefined);
  }

  private async claimReadyIntents(
    state: ReturnType<AgentGraphControlStore["getScheduleState"]>,
    claims: readonly AgentGraphActivationClaim[],
    records: readonly AgentGraphRecordRef[],
    resolved: readonly ResolvedIntent[],
    pass: MutablePassResult,
  ): Promise<void> {
    const occupiedOperators = new Set(
      claims
        .filter(
          (claim) =>
            claim.state !== "cancelled" &&
            !records.some((record) => record.activationClaimId === claim.claimId),
        )
        .map((claim) => operatorKey(claim.operatorId, claim.operatorGeneration)),
    );
    for (const item of resolved) {
      if (item.readiness.status !== "resolved") continue;
      const key = operatorKey(item.intent.operatorId, item.intent.operatorGeneration);
      if (occupiedOperators.has(key)) continue;
      const identity = this.identities.activation(item.intent);
      const candidate = createClaim(
        item.intent,
        item.provision,
        identity,
        state.graph.headRevision,
        item.readiness.fingerprint,
        this.now(),
      );
      try {
        const result = this.store.claimActivation({
          claim: candidate,
          expectedGraphRevision: state.graph.headRevision,
        });
        occupiedOperators.add(key);
        if (!result.replayed) pass.progress += 1;
      } catch (error) {
        // A concurrent stop/finish/revision wins through the store CAS. The
        // next fixed-point pass rebuilds schedule before attempting again.
        const latest = this.store.getScheduleState(state.graph.graphId);
        if (latest.graph.headRevision !== state.graph.headRevision) {
          pass.progress += 1;
        } else {
          pass.errors.push(reconcileError("claim", item.intent.intentId, error));
        }
      }
    }
  }

  private async beginAndObserveActivations(
    state: ReturnType<AgentGraphControlStore["getScheduleState"]>,
    claims: readonly AgentGraphActivationClaim[],
    records: readonly AgentGraphRecordRef[],
    intentsById: ReadonlyMap<string, AgentGraphActivationIntent>,
    operatorsByKey: ReadonlyMap<string, AgentGraphOperator>,
    ensuredOperators: ReadonlySet<string>,
    pass: MutablePassResult,
  ): Promise<ReadonlyMap<string, AgentGraphRuntimeProjection>> {
    const projections = new Map<string, AgentGraphRuntimeProjection>();
    const groups = new Map<string, AgentGraphActivationClaim[]>();
    for (const claim of claims) {
      if (claim.state === "cancelled") continue;
      const intent = intentsById.get(claim.intentId);
      if (!intent || isIntentStopped(state, intent)) continue;
      const key = operatorKey(claim.operatorId, claim.operatorGeneration);
      if (!ensuredOperators.has(key)) continue;
      const group = groups.get(key) ?? [];
      group.push(claim);
      groups.set(key, group);
    }

    await Promise.all(
      [...groups].map(async ([key, group]) => {
        const operator = operatorsByKey.get(key);
        if (!operator) return;
        group.sort(
          (left, right) =>
            left.claimedAt - right.claimedAt || left.claimId.localeCompare(right.claimId),
        );
        for (const originalClaim of group) {
          const intent = intentsById.get(originalClaim.intentId);
          if (!intent) continue;
          let claim = originalClaim;
          try {
            if (claim.state === "claimed") {
              const transitioned = this.store.transitionActivationClaim({
                claimId: claim.claimId,
                from: "claimed",
                to: "executing",
              });
              claim = transitioned.record;
              if (!transitioned.replayed) pass.progress += 1;
            }
            const projection = await this.runtime.startOrObserveActivation({
              operator,
              intent,
              claim,
              inputRecords: intent.inputRefs
                .map((input) => records.find((record) => record.recordId === input.recordId))
                .filter((record): record is AgentGraphRecordRef => record !== undefined),
            });
            projections.set(claim.claimId, projection);
            if (!isTerminalRuntimeStatus(projection.status)) break;
          } catch (error) {
            pass.errors.push(reconcileError("begin-executing", claim.claimId, error));
            break;
          }
        }
      }),
    );
    return projections;
  }

  private projectRecords(
    graphId: string,
    claims: readonly AgentGraphActivationClaim[],
    projections: ReadonlyMap<string, AgentGraphRuntimeProjection>,
    pass: MutablePassResult,
  ): void {
    const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
    for (const [claimId, projection] of projections) {
      const claim = claimsById.get(claimId);
      if (!claim) continue;
      for (const candidate of projection.records) {
        if (!candidate.committed || candidate.partial) continue;
        try {
          assertCandidateMatchesClaim(candidate, claim);
          const record: AgentGraphRecordRef = {
            recordId: recordIdFor(claim.claimId, candidate.sourceEventId),
            graphId,
            operatorId: claim.operatorId,
            operatorGeneration: claim.operatorGeneration,
            activationClaimId: claim.claimId,
            sourceSessionId: candidate.sourceSessionId,
            sourceTurnId: candidate.sourceTurnId,
            sourceRunId: candidate.sourceRunId,
            sourceEventId: candidate.sourceEventId,
            kind: candidate.kind,
          };
          const result = this.store.putRecordRef({
            record,
            recordFingerprint: deterministicFingerprint(record),
          });
          if (!result.replayed) pass.progress += 1;
        } catch (error) {
          pass.errors.push(reconcileError("project-record", claim.claimId, error));
        }
      }
      if (isTerminalRuntimeStatus(projection.status)) {
        const terminalKey = projection.terminalEventId ?? projection.status;
        pass.wakes.push({
          dedupeKey: `runtime-terminal:${claim.targetRunId}:${terminalKey}`,
          cause: "runtime_terminal",
          payload: {
            graphId,
            claimId,
            runId: claim.targetRunId,
            status: projection.status,
            ...(projection.terminalEventId === undefined
              ? {}
              : { terminalEventId: projection.terminalEventId }),
          },
        });
      }
    }
  }
}

export const deterministicAgentGraphIdentities: AgentGraphIdentityFactory = {
  provision(operator): AgentGraphProvisionIdentity {
    const key = [operator.graphId, operator.operatorId, operator.generation] as const;
    return {
      provisionId: provisionIdFor(...key),
      childSessionId: deterministicId("graph-session", key),
    };
  },
  activation(intent): AgentGraphActivationIdentity {
    const claimId = claimIdFor(intent.graphId, intent.intentId);
    return {
      claimId,
      targetTurnId: deterministicId("graph-turn", [claimId]),
      targetRunId: deterministicId("graph-run", [claimId]),
      targetInvocationId: deterministicId("graph-invocation", [claimId]),
      runStartedEventId: deterministicId("graph-run-started", [claimId]),
    };
  },
};

function createProvision(
  operator: AgentGraphOperator,
  identity: AgentGraphProvisionIdentity,
  now: number,
): AgentGraphOperatorProvision {
  return {
    provisionId: identity.provisionId,
    graphId: operator.graphId,
    operatorId: operator.operatorId,
    operatorGeneration: operator.generation,
    childSessionId: identity.childSessionId,
    state: "requested",
    version: 1,
    profileSnapshot: operator.profileSnapshot,
    workspaceBinding:
      operator.workspacePolicy.kind === "shared"
        ? { kind: "shared" }
        : {
            kind: "isolated-worktree",
            ...(operator.workspacePolicy.baseRef === undefined
              ? {}
              : { baseRef: operator.workspacePolicy.baseRef }),
          },
    createdAt: now,
  };
}

function createClaim(
  intent: AgentGraphActivationIntent,
  provision: AgentGraphOperatorProvision,
  identity: AgentGraphActivationIdentity,
  scheduleRevision: number,
  readinessFingerprint: string,
  now: number,
): AgentGraphActivationClaim {
  return {
    claimId: identity.claimId,
    graphId: intent.graphId,
    intentId: intent.intentId,
    operatorId: intent.operatorId,
    operatorGeneration: intent.operatorGeneration,
    scheduleRevision,
    intentFingerprint: deterministicFingerprint(intent),
    readinessFingerprint,
    state: "claimed",
    targetSessionId: provision.childSessionId,
    targetTurnId: identity.targetTurnId,
    targetRunId: identity.targetRunId,
    targetInvocationId: identity.targetInvocationId,
    runStartedEventId: identity.runStartedEventId,
    claimedAt: now,
  };
}

function assertCandidateMatchesClaim(
  candidate: AgentGraphRuntimeRecordCandidate,
  claim: AgentGraphActivationClaim,
): void {
  if (
    candidate.sourceSessionId !== claim.targetSessionId ||
    candidate.sourceTurnId !== claim.targetTurnId ||
    candidate.sourceRunId !== claim.targetRunId
  ) {
    throw new Error(`Runtime record source identity does not match claim ${claim.claimId}`);
  }
}

function mergeRecords(
  left: readonly AgentGraphRecordRef[],
  right: readonly AgentGraphRecordRef[],
): readonly AgentGraphRecordRef[] {
  const records = new Map<string, AgentGraphRecordRef>();
  for (const record of [...left, ...right]) records.set(record.recordId, record);
  return [...records.values()];
}

function operatorKey(operatorId: string, generation: number): string {
  return `${operatorId}@${generation}`;
}

function isTerminalRuntimeStatus(status: AgentGraphRuntimeProjection["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function deterministicId(prefix: string, parts: readonly (number | string)[]): string {
  return `${prefix}_${deterministicFingerprint(parts).slice("sha256:".length, 39)}`;
}

function reconcileError(
  phase: AgentGraphReconcilePhase,
  subjectId: string,
  error: unknown,
): AgentGraphReconcileError {
  return {
    phase,
    subjectId,
    message: error instanceof Error ? error.message : String(error),
  };
}
