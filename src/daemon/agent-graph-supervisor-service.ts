import { createHash } from "node:crypto";

import { deterministicFingerprint, wakeIdFor } from "../agent-graph/core/ids.js";
import type {
  AgentGraphRecord,
  AgentGraphSupervisorWakeAttemptRecord,
  AgentGraphSupervisorWakeRecord,
  AgentGraphWakeCause,
  ClaimAgentGraphSupervisorWakeInput,
  ClaimAgentGraphSupervisorWakeResult,
  EnqueueAgentGraphSupervisorWakeInput,
  EnqueueAgentGraphSupervisorWakeForYieldResult,
  IdempotentStoreResult,
  SettleAgentGraphSupervisorWakeInput,
} from "../storage/sqlite/agent-graph-store-types.js";

export interface AgentGraphWakeCandidate {
  readonly dedupeKey: string;
  readonly cause: AgentGraphWakeCause;
  readonly payload: unknown;
}

export interface AgentGraphDriveResult {
  /** True when another pass may make progress without waiting for an external fact. */
  readonly needsAnotherPass?: boolean;
  /** Reconciler-native equivalent; false requests another bounded pass. */
  readonly quiescent?: boolean;
  readonly wakeCandidates?: readonly AgentGraphWakeCandidate[];
}

export interface AgentGraphYieldSnapshot {
  readonly graphId: string;
  readonly headRevision: number;
  readonly phase: "open" | "finished";
  readonly pending: number;
  readonly executing: number;
  readonly availableRecordIds: readonly string[];
}

export interface RegisterAgentGraphYieldInput {
  readonly permitId: string;
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly rootRunId: string;
}

/**
 * Application boundary implemented by the Graph reconciler/composition root.
 * registerYieldInterest must become visible before readYieldSnapshot starts.
 */
export interface AgentGraphDrivePort {
  listOpenGraphIds(): Promise<readonly string[]> | readonly string[];
  driveGraph(graphId: string): Promise<AgentGraphDriveResult | void>;
  registerYieldInterest(input: RegisterAgentGraphYieldInput): Promise<void> | void;
  readYieldSnapshot(graphId: string): Promise<AgentGraphYieldSnapshot> | AgentGraphYieldSnapshot;
}

export interface RecoverableAgentGraphSupervisorWake {
  readonly graph: AgentGraphRecord;
  readonly wake: AgentGraphSupervisorWakeRecord;
  /** Required for running/waiting_permission; absent for fresh/retryable wakes. */
  readonly attempt?: AgentGraphSupervisorWakeAttemptRecord;
}

/** SQLite adapter boundary. All mutation methods must retain their transactional CAS semantics. */
export interface AgentGraphSupervisorStorePort {
  /**
   * Returns all pending/retryable/running/waiting_permission wakes. Future
   * retryable rows are included so the service can arm their due timer.
   */
  listRecoverableSupervisorWakes(
    at: number,
  ):
    | Promise<readonly RecoverableAgentGraphSupervisorWake[]>
    | readonly RecoverableAgentGraphSupervisorWake[];
  getRecoverableSupervisorWake(
    wakeId: string,
  ):
    | Promise<RecoverableAgentGraphSupervisorWake | undefined>
    | RecoverableAgentGraphSupervisorWake
    | undefined;
  claimSupervisorWake(
    input: ClaimAgentGraphSupervisorWakeInput,
  ): Promise<ClaimAgentGraphSupervisorWakeResult> | ClaimAgentGraphSupervisorWakeResult;
  enqueueSupervisorWake(
    input: EnqueueAgentGraphSupervisorWakeInput,
  ):
    | Promise<IdempotentStoreResult<AgentGraphSupervisorWakeRecord>>
    | IdempotentStoreResult<AgentGraphSupervisorWakeRecord>;
  /** Production SQLite path: atomically consumes a registered yield permit. */
  enqueueSupervisorWakeForYield?(
    input: EnqueueAgentGraphSupervisorWakeInput,
  ):
    | Promise<EnqueueAgentGraphSupervisorWakeForYieldResult>
    | EnqueueAgentGraphSupervisorWakeForYieldResult;
  settleSupervisorWake(input: SettleAgentGraphSupervisorWakeInput): Promise<unknown> | unknown;
}

export interface RootSupervisorRunIdentity {
  readonly wakeId: string;
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
}

export type RootSupervisorRunState =
  | { readonly status: "not_started" | "running" }
  | { readonly status: "completed" }
  | { readonly status: "deferred"; readonly reason: "source_root_active" | "workspace_busy" }
  | { readonly status: "waiting_permission"; readonly error?: string }
  | {
      readonly status: "manual_intervention";
      readonly reason: "indeterminate" | "cancelled";
      readonly error: string;
      readonly blockingEventIds?: readonly string[];
    }
  | { readonly status: "failed"; readonly error: string };

/** Root Runtime adapter. startOrResume must use the supplied exact Turn/Run identities. */
export interface AgentGraphRootWakePort {
  inspect(input: RootSupervisorRunIdentity): Promise<RootSupervisorRunState>;
  startOrResume(
    input: RootSupervisorRunIdentity & { readonly payload: unknown },
  ): Promise<RootSupervisorRunState>;
}

export interface AgentGraphSupervisorServiceOptions {
  readonly store: AgentGraphSupervisorStorePort;
  readonly drivePort: AgentGraphDrivePort;
  readonly rootWakePort: AgentGraphRootWakePort;
  readonly now?: () => number;
  readonly retryDelayMs?: (attemptNumber: number) => number;
  readonly onError?: (error: unknown, context: { graphId?: string; wakeId?: string }) => void;
}

export interface AgentGraphYieldResult {
  readonly permitId: string;
  readonly snapshot: AgentGraphYieldSnapshot;
}

type LifecycleState = "idle" | "open" | "closing" | "closed";

/**
 * Workspace-owned Graph lifecycle coordinator.
 *
 * Process-local maps only collapse duplicate work. SQLite wake/attempt rows and
 * Runtime runs remain the restart authority; close never rewrites them.
 */
export class AgentGraphSupervisorService {
  private readonly now: () => number;
  private readonly retryDelayMs: (attemptNumber: number) => number;
  private state: LifecycleState = "idle";
  private closePromise?: Promise<void>;
  private readonly graphFlights = new Map<
    string,
    { rerun: boolean; readonly promise: Promise<void> }
  >();
  private readonly wakeFlights = new Map<string, Promise<void>>();
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: AgentGraphSupervisorServiceOptions) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  }

  async start(): Promise<void> {
    if (this.state === "open") return;
    if (this.state !== "idle") throw new Error("Agent Graph Supervisor 已关闭");
    this.state = "open";
    const graphIds = await this.options.drivePort.listOpenGraphIds();
    await Promise.allSettled(graphIds.map((graphId) => this.notifyGraph(graphId)));
    await this.scanRecoverableWakes();
  }

  /** Coalesces concurrent notifications while preserving one requested rerun. */
  notifyGraph(graphId: string): Promise<void> {
    requireId(graphId, "graphId");
    if (this.state !== "open") return Promise.resolve();
    const current = this.graphFlights.get(graphId);
    if (current) {
      current.rerun = true;
      return current.promise;
    }
    const flight = {
      rerun: false,
      promise: Promise.resolve(),
    };
    flight.promise = this.driveUntilQuiescent(graphId, flight)
      .finally(() => {
        if (this.graphFlights.get(graphId) === flight) this.graphFlights.delete(graphId);
      })
      .then(() => this.scanDueWakesOnly());
    this.graphFlights.set(graphId, flight);
    return flight.promise;
  }

  /**
   * Registers the yield interest first, then reconciles and snapshots. A terminal
   * fact committed before/during/after this sequence is therefore either observed
   * by this drive or by a later notification/startup scan.
   */
  async registerYield(input: RegisterAgentGraphYieldInput): Promise<AgentGraphYieldResult> {
    this.requireOpen();
    requireId(input.permitId, "permitId");
    requireId(input.graphId, "graphId");
    requireId(input.rootSessionId, "rootSessionId");
    requireId(input.rootRunId, "rootRunId");
    await this.options.drivePort.registerYieldInterest(input);
    await this.notifyGraph(input.graphId);
    return {
      permitId: input.permitId,
      snapshot: await this.options.drivePort.readYieldSnapshot(input.graphId),
    };
  }

  async scanRecoverableWakes(): Promise<void> {
    if (this.state !== "open") return;
    const candidates = await this.options.store.listRecoverableSupervisorWakes(this.now());
    await Promise.allSettled(
      candidates.map((candidate) => {
        if (
          (candidate.wake.status === "pending" || candidate.wake.status === "retryable_failed") &&
          candidate.wake.availableAt > this.now()
        ) {
          this.scheduleWake(candidate.wake.wakeId, candidate.wake.availableAt);
          return Promise.resolve();
        }
        return this.processWake(candidate, "startup");
      }),
    );
  }

  /** Called after approval state changes or an explicit user retry. */
  async resumeWaitingPermission(wakeId: string): Promise<void> {
    this.requireOpen();
    const candidate = await this.options.store.getRecoverableSupervisorWake(
      requireId(wakeId, "wakeId"),
    );
    if (!candidate || candidate.wake.status !== "waiting_permission") return;
    await this.processWake(candidate, "permission_changed");
  }

  /** Called when a root Runtime event for an in-flight wake is committed. */
  async notifyRootRunChanged(wakeId: string): Promise<void> {
    if (this.state !== "open") return;
    const candidate = await this.options.store.getRecoverableSupervisorWake(
      requireId(wakeId, "wakeId"),
    );
    if (
      !candidate ||
      (candidate.wake.status !== "running" && candidate.wake.status !== "waiting_permission")
    ) {
      return;
    }
    await this.processWake(candidate, "runtime_changed");
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.closePromise = Promise.allSettled([
      ...[...this.graphFlights.values()].map(({ promise }) => promise),
      ...this.wakeFlights.values(),
    ]).then(() => {
      this.state = "closed";
    });
    return this.closePromise;
  }

  stop(): Promise<void> {
    return this.close();
  }

  private async driveUntilQuiescent(graphId: string, flight: { rerun: boolean }): Promise<void> {
    do {
      flight.rerun = false;
      try {
        const result = await this.options.drivePort.driveGraph(graphId);
        if (this.state === "open" && result?.wakeCandidates) {
          for (const candidate of result.wakeCandidates) {
            if (this.state !== "open") break;
            const wakeFingerprint = deterministicFingerprint({ graphId, ...candidate });
            const input = {
              wakeId: wakeIdFor(graphId, candidate.dedupeKey),
              graphId,
              dedupeKey: candidate.dedupeKey,
              wakeFingerprint,
              cause: candidate.cause,
              payload: candidate.payload,
            };
            if (this.options.store.enqueueSupervisorWakeForYield) {
              await this.options.store.enqueueSupervisorWakeForYield(input);
            } else {
              await this.options.store.enqueueSupervisorWake(input);
            }
          }
        }
        if (result?.needsAnotherPass || result?.quiescent === false) flight.rerun = true;
      } catch (error) {
        this.report(error, { graphId });
      }
    } while (this.state === "open" && flight.rerun);
  }

  private async scanDueWakesOnly(): Promise<void> {
    if (this.state !== "open") return;
    const candidates = await this.options.store.listRecoverableSupervisorWakes(this.now());
    await Promise.allSettled(
      candidates
        .filter(({ wake }) => {
          if (wake.status !== "pending" && wake.status !== "retryable_failed") return false;
          if (wake.availableAt <= this.now()) return true;
          this.scheduleWake(wake.wakeId, wake.availableAt);
          return false;
        })
        .map((candidate) => this.processWake(candidate, "due")),
    );
  }

  private processWake(
    candidate: RecoverableAgentGraphSupervisorWake,
    trigger: "startup" | "due" | "permission_changed" | "runtime_changed",
  ): Promise<void> {
    if (this.state !== "open") return Promise.resolve();
    const current = this.wakeFlights.get(candidate.wake.wakeId);
    if (current) return current;
    const promise = this.processWakeOnce(candidate, trigger)
      .catch((error) =>
        this.report(error, { graphId: candidate.graph.graphId, wakeId: candidate.wake.wakeId }),
      )
      .finally(() => {
        if (this.wakeFlights.get(candidate.wake.wakeId) === promise) {
          this.wakeFlights.delete(candidate.wake.wakeId);
        }
      });
    this.wakeFlights.set(candidate.wake.wakeId, promise);
    return promise;
  }

  private async processWakeOnce(
    candidate: RecoverableAgentGraphSupervisorWake,
    trigger: "startup" | "due" | "permission_changed" | "runtime_changed",
  ): Promise<void> {
    if (this.state !== "open") return;
    const { graph, wake } = candidate;
    if (wake.status === "delivered") return;

    let claimedWake = wake;
    let attempt = candidate.attempt;
    if (wake.status === "pending" || wake.status === "retryable_failed") {
      // A finished Graph never starts a fresh root wake. Existing running attempts
      // remain recoverable below because their exact RuntimeRun is already admitted.
      if (graph.phase !== "open") return;
      if (wake.availableAt > this.now()) {
        this.scheduleWake(wake.wakeId, wake.availableAt);
        return;
      }
      this.clearWakeTimer(wake.wakeId);
      const identity = wakeAttemptIdentity(wake.wakeId, wake.attemptCount + 1);
      let claim: ClaimAgentGraphSupervisorWakeResult;
      try {
        claim = await this.options.store.claimSupervisorWake({
          wakeId: wake.wakeId,
          expectedWakeVersion: wake.version,
          attemptId: identity.attemptId,
          rootSessionId: graph.rootSessionId,
          targetTurnId: identity.targetTurnId,
          targetRunId: identity.targetRunId,
        });
      } catch (error) {
        // CAS loss is expected when another workspace service owns this wake.
        this.report(error, { graphId: graph.graphId, wakeId: wake.wakeId });
        return;
      }
      // A replay may belong to the winning peer. Only startup recovery is allowed
      // to resume an existing attempt, and due wakes never carry one.
      if (claim.replayed) return;
      claimedWake = claim.wake;
      attempt = claim.attempt;
    }

    if (!attempt) return;
    const runIdentity: RootSupervisorRunIdentity = {
      wakeId: claimedWake.wakeId,
      graphId: graph.graphId,
      rootSessionId: attempt.rootSessionId,
      targetTurnId: attempt.targetTurnId,
      targetRunId: attempt.targetRunId,
    };
    let observed = await this.options.rootWakePort.inspect(runIdentity);
    if (observed.status === "completed") {
      await this.settle(claimedWake, attempt, "delivered");
      return;
    }
    if (claimedWake.status === "waiting_permission" && trigger === "startup") return;
    if (claimedWake.status === "waiting_permission" && trigger === "runtime_changed") {
      // A runtime event may announce completion, but must not implicitly grant permission.
      return;
    }
    if (observed.status === "deferred") {
      this.scheduleWake(claimedWake.wakeId, this.now() + 100);
      return;
    }
    if (observed.status === "manual_intervention") {
      if (claimedWake.status !== "waiting_permission") {
        await this.settle(
          claimedWake,
          attempt,
          "waiting_permission",
          `manual:${observed.reason}:${observed.error}`,
        );
      }
      return;
    }
    if (observed.status === "waiting_permission") {
      if (trigger !== "permission_changed") {
        await this.settle(claimedWake, attempt, "waiting_permission", observed.error);
        return;
      }
      observed = await this.options.rootWakePort.startOrResume({
        ...runIdentity,
        payload: claimedWake.payload,
      });
    } else if (observed.status === "not_started" || observed.status === "running") {
      observed = await this.options.rootWakePort.startOrResume({
        ...runIdentity,
        payload: claimedWake.payload,
      });
    }
    if (observed.status === "deferred") {
      this.scheduleWake(claimedWake.wakeId, this.now() + 100);
      return;
    }
    if (observed.status === "manual_intervention") {
      await this.settle(
        claimedWake,
        attempt,
        "waiting_permission",
        `manual:${observed.reason}:${observed.error}`,
      );
      return;
    }
    if (observed.status === "completed") {
      await this.settle(claimedWake, attempt, "delivered");
      return;
    }
    if (observed.status === "waiting_permission") {
      await this.settle(claimedWake, attempt, "waiting_permission", observed.error);
      return;
    }
    if (observed.status === "failed") {
      const retryAt = this.now() + this.retryDelayMs(attempt.attemptNumber);
      await this.settle(claimedWake, attempt, "retryable_failed", observed.error, retryAt);
      this.scheduleWake(claimedWake.wakeId, retryAt);
    }
  }

  private scheduleWake(wakeId: string, availableAt: number): void {
    if (this.state !== "open") return;
    this.clearWakeTimer(wakeId);
    const timer = setTimeout(
      () => {
        this.wakeTimers.delete(wakeId);
        if (this.state !== "open") return;
        void Promise.resolve(this.options.store.getRecoverableSupervisorWake(wakeId)).then(
          (candidate) => {
            if (candidate) void this.processWake(candidate, "due");
          },
          (error) => this.report(error, { wakeId }),
        );
      },
      Math.max(0, availableAt - this.now()),
    );
    timer.unref?.();
    this.wakeTimers.set(wakeId, timer);
  }

  private clearWakeTimer(wakeId: string): void {
    const timer = this.wakeTimers.get(wakeId);
    if (timer) clearTimeout(timer);
    this.wakeTimers.delete(wakeId);
  }

  private async settle(
    wake: AgentGraphSupervisorWakeRecord,
    attempt: AgentGraphSupervisorWakeAttemptRecord,
    outcome: SettleAgentGraphSupervisorWakeInput["outcome"],
    error?: string,
    retryAt?: number,
  ): Promise<void> {
    if (this.state !== "open") return;
    await this.options.store.settleSupervisorWake({
      wakeId: wake.wakeId,
      attemptId: attempt.attemptId,
      expectedWakeVersion: wake.version,
      expectedAttemptVersion: attempt.version,
      outcome,
      ...(error !== undefined ? { error } : {}),
      ...(retryAt !== undefined ? { retryAt } : {}),
    });
  }

  private requireOpen(): void {
    if (this.state !== "open") throw new Error("Agent Graph Supervisor 未启动或已关闭");
  }

  private report(error: unknown, context: { graphId?: string; wakeId?: string }): void {
    this.options.onError?.(error, context);
  }
}

export function wakeAttemptIdentity(
  wakeId: string,
  attemptNumber: number,
): { readonly attemptId: string; readonly targetTurnId: string; readonly targetRunId: string } {
  requireId(wakeId, "wakeId");
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("attemptNumber 必须是正整数");
  }
  return {
    attemptId: stableId("wake_attempt", wakeId, attemptNumber),
    targetTurnId: stableId("turn", wakeId, attemptNumber),
    targetRunId: stableId("run", wakeId, attemptNumber),
  };
}

function stableId(prefix: string, wakeId: string, attemptNumber: number): string {
  const digest = createHash("sha256")
    .update(`${wakeId}\0${attemptNumber}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function defaultRetryDelayMs(attemptNumber: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(0, attemptNumber - 1), 6));
}

function requireId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不得为空`);
  return normalized;
}
