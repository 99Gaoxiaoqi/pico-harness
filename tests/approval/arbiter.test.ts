import { afterEach, describe, expect, it, vi } from "vitest";
import { racePermissionSources } from "../../src/approval/arbiter.js";
import { ApprovalManager, createLocalApprovalSource } from "../../src/approval/manager.js";
import type { ApprovalResult } from "../../src/approval/manager.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("racePermissionSources", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the first resolved decision and cleans up loser sources", async () => {
    const slow = deferred<ApprovalResult>();
    const fast = deferred<ApprovalResult>();
    const slowCleanup = vi.fn();
    const fastCleanup = vi.fn();

    const resultPromise = racePermissionSources({
      sources: [
        { name: "slow", promise: slow.promise, cleanup: slowCleanup },
        { name: "fast", promise: fast.promise, cleanup: fastCleanup },
      ],
    });

    fast.resolve({ allowed: true, reason: "fast approval" });

    await expect(resultPromise).resolves.toEqual({
      allowed: true,
      reason: "fast approval",
    });
    expect(slowCleanup).toHaveBeenCalledTimes(1);
    expect(fastCleanup).not.toHaveBeenCalled();
  });

  it("rejects on abort and cleans up every source", async () => {
    const controller = new AbortController();
    const pending = deferred<ApprovalResult>();
    const cleanup = vi.fn();

    const resultPromise = racePermissionSources({
      sources: [{ name: "local", promise: pending.promise, cleanup }],
      signal: controller.signal,
    });

    controller.abort();

    await expect(resultPromise).rejects.toThrow("Permission race aborted");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects on timeout and cleans up every source", async () => {
    vi.useFakeTimers();
    const pending = deferred<ApprovalResult>();
    const cleanup = vi.fn();

    const resultPromise = racePermissionSources({
      sources: [{ name: "local", promise: pending.promise, cleanup }],
      timeoutMs: 50,
    });
    const rejection = expect(resultPromise).rejects.toThrow("Permission race timed out");

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans ApprovalManager pending tasks when the local source loses to timeout", async () => {
    vi.useFakeTimers();
    const manager = new ApprovalManager(60_000);
    const source = createLocalApprovalSource({
      manager,
      taskId: "task-1",
      toolName: "bash",
      args: "rm file.txt",
      notify: vi.fn(),
    });

    const resultPromise = racePermissionSources({
      sources: [source],
      timeoutMs: 50,
    });

    expect(manager.pendingCount).toBe(1);
    const rejection = expect(resultPromise).rejects.toThrow("Permission race timed out");
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(manager.pendingCount).toBe(0);
  });
});
