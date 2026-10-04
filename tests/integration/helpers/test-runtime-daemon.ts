import type { ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import {
  launchDetachedRuntimeHostCandidate,
  type CandidateLauncher,
  type DetachedCandidateProcess,
  type DetachedCandidateProcessExit,
} from "../../../packages/runtime-host/src/client/launcher.js";

const GRACEFUL_EXIT_TIMEOUT_MS = 12_000;
const FORCED_EXIT_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_LOG_TAIL_BYTES = 8_192;
const DIAGNOSTIC_LOG_COUNT = 8;

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
  private readonly candidateLogs = new Map<number, string>();
  private readonly candidateExits = new Map<number, DetachedCandidateProcessExit>();
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
      const candidate = attempt.process;
      this.processes.set(candidate.pid, candidate);
      if (attempt.logFile) this.candidateLogs.set(candidate.pid, attempt.logFile);
      void candidate.closed.then(
        (exit) => this.candidateExits.set(candidate.pid, exit),
        () => undefined,
      );
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

  /** Reports this fixture's exact children before teardown without probing or signalling them. */
  async diagnoseFailure(
    t: { diagnostic(message: string): void },
    label: string,
    error: unknown,
  ): Promise<void> {
    try {
      const logs = [...this.candidateLogs];
      const selectedLogs = new Map([...logs.slice(0, 1), ...logs.slice(1 - DIAGNOSTIC_LOG_COUNT)]);
      t.diagnostic(
        JSON.stringify({
          kind: "runtime-host-fixture-failure",
          label,
          error: describeFailure(error),
          candidates: [...this.processes.values()].map((candidate) => ({
            pid: candidate.pid,
            exited: candidate.exited,
            exit: this.candidateExits.get(candidate.pid),
          })),
          omittedCandidateLogs: this.candidateLogs.size - selectedLogs.size,
        }),
      );
      // Only paths returned by this fixture's owned launches are read. Keep the
      // first candidate and recent logs, since production prunes older paths.
      for (const [pid, logFile] of selectedLogs) {
        const log = await readCandidateLogTail(logFile);
        t.diagnostic(
          JSON.stringify({
            kind: "runtime-host-candidate-log",
            label,
            pid,
            exited: this.requireOwned(pid).exited,
            exit: this.candidateExits.get(pid),
            logFile,
            ...log,
          }),
        );
      }
    } catch {
      // Diagnostics must never replace the original fixture failure.
    }
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

function describeFailure(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error).slice(0, 4_096);
  return {
    name: error.name,
    code: "code" in error ? String(error.code).slice(0, 256) : undefined,
    message: error.message.slice(0, 4_096),
    stack: error.stack?.slice(0, 8_192),
    cause:
      depth < 4 && error.cause !== undefined ? describeFailure(error.cause, depth + 1) : undefined,
  };
}

async function readCandidateLogTail(logFile: string): Promise<object> {
  try {
    const handle = await open(logFile, "r");
    try {
      const { size } = await handle.stat();
      const bytes = Buffer.alloc(Math.min(size, DIAGNOSTIC_LOG_TAIL_BYTES));
      const { bytesRead } = await handle.read(
        bytes,
        0,
        bytes.length,
        Math.max(0, size - bytes.length),
      );
      return { size, tail: bytes.subarray(0, bytesRead).toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { readError: describeFailure(error) };
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
