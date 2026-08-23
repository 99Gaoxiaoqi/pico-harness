import type { ChildProcess } from "node:child_process";
import {
  launchDetachedRuntimeHostCandidate,
  type CandidateLauncher,
  type DetachedCandidateProcess,
} from "../../../packages/runtime-host/src/client/launcher.js";

const GRACEFUL_EXIT_TIMEOUT_MS = 12_000;
const FORCED_EXIT_TIMEOUT_MS = 5_000;

export interface TestRuntimeHostCandidateTrackerOptions {
  readonly launchCandidate?: CandidateLauncher;
  readonly gracefulExitTimeoutMs?: number;
  readonly forcedExitTimeoutMs?: number;
}

/**
 * Owns every candidate launched by one integration test.
 *
 * Ownership is captured synchronously at launch and resolved to the exact
 * ChildProcess-backed capability. Teardown never discovers a process through a
 * registration file and never treats a reusable PID as signalling authority.
 */
export class TestRuntimeHostCandidateTracker {
  private readonly baseLauncher: CandidateLauncher;
  private readonly gracefulExitTimeoutMs: number;
  private readonly forcedExitTimeoutMs: number;
  private readonly pendingLaunches = new Set<Promise<void>>();
  private readonly processes = new Map<number, DetachedCandidateProcess>();
  private sealed = false;

  constructor(options: TestRuntimeHostCandidateTrackerOptions = {}) {
    this.baseLauncher = options.launchCandidate ?? launchDetachedRuntimeHostCandidate;
    this.gracefulExitTimeoutMs = options.gracefulExitTimeoutMs ?? GRACEFUL_EXIT_TIMEOUT_MS;
    this.forcedExitTimeoutMs = options.forcedExitTimeoutMs ?? FORCED_EXIT_TIMEOUT_MS;
  }

  readonly launcher: CandidateLauncher = (input) => {
    if (this.sealed) {
      return { spawned: Promise.reject(new Error("Test candidate tracker is already stopping")) };
    }
    const launch = this.baseLauncher(input);
    const spawned = launch.spawned.then((attempt) => {
      if (!attempt.process) {
        throw new Error(`Candidate ${attempt.pid} did not expose a stable process capability`);
      }
      this.processes.set(attempt.process.pid, attempt.process);
      return attempt;
    });
    const settlement = spawned.then(
      () => undefined,
      () => undefined,
    );
    this.pendingLaunches.add(settlement);
    void settlement.then(() => this.pendingLaunches.delete(settlement));
    return { spawned };
  };

  /** Stops an exact, tracker-owned candidate selected only for test fault injection. */
  async terminateOwned(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): Promise<void> {
    const processCapability = this.requireOwned(pid);
    if (processCapability.exited) return;
    processCapability.terminate(signal);
    const exited = await waitForClosed(processCapability, this.forcedExitTimeoutMs);
    if (!exited) throw new Error(`Owned candidate ${pid} did not exit after ${signal}`);
  }

  /** Synchronous crash injection for tests that intentionally exercise disconnect races. */
  signalOwned(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
    const processCapability = this.requireOwned(pid);
    if (!processCapability.exited) processCapability.terminate(signal);
  }

  ownedExited(pid: number): boolean {
    return this.requireOwned(pid).exited;
  }

  /** Seals future launches and waits until every launched candidate is terminal. */
  async stopAll(): Promise<void> {
    this.sealed = true;
    while (this.pendingLaunches.size > 0) {
      await Promise.all([...this.pendingLaunches]);
    }
    const failures: unknown[] = [];
    for (const processCapability of this.processes.values()) {
      try {
        await stopCandidateProcess(
          processCapability,
          this.gracefulExitTimeoutMs,
          this.forcedExitTimeoutMs,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more test-owned candidates did not exit");
    }
  }

  private requireOwned(pid: number): DetachedCandidateProcess {
    const processCapability = this.processes.get(pid);
    if (!processCapability) {
      throw new Error(`PID ${pid} is not owned by this test candidate tracker`);
    }
    return processCapability;
  }
}

/** Stops a child created directly by a test through its stable ChildProcess handle. */
export async function stopTestChildProcess(
  child: ChildProcess,
  gracefulExitTimeoutMs = GRACEFUL_EXIT_TIMEOUT_MS,
  forcedExitTimeoutMs = FORCED_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  if (await settleWithin(closed, gracefulExitTimeoutMs)) return;
  child.kill("SIGKILL");
  if (await settleWithin(closed, forcedExitTimeoutMs)) return;
  throw new Error(`Test child ${String(child.pid)} did not exit after SIGTERM and SIGKILL`);
}

async function stopCandidateProcess(
  processCapability: DetachedCandidateProcess,
  gracefulExitTimeoutMs: number,
  forcedExitTimeoutMs: number,
): Promise<void> {
  if (processCapability.exited) return;
  processCapability.terminate("SIGTERM");
  if (await waitForClosed(processCapability, gracefulExitTimeoutMs)) return;
  processCapability.terminate("SIGKILL");
  if (await waitForClosed(processCapability, forcedExitTimeoutMs)) return;
  throw new Error(`Test candidate ${processCapability.pid} did not exit after SIGTERM and SIGKILL`);
}

function waitForClosed(processCapability: DetachedCandidateProcess, timeoutMs: number) {
  if (processCapability.exited) return Promise.resolve(true);
  return settleWithin(processCapability.closed, timeoutMs);
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    operation.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
