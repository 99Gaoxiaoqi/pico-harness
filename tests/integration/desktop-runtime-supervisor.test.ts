import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { startRuntimeSupervisor } from "../../apps/desktop/src/main/runtime-supervisor.js";

/**
 * 3-C Runtime 连接监督器决策逻辑实盘验证（纯 DI 模块，无 Electron）：
 * 连续失败达阈值广播 unavailable（不去重）、降级后探活成功广播 recovered、
 * 从未降级的成功静默、stop 后不再广播、假死 ping（永不 settle）按超时计失败。
 */

interface Harness {
  events: string[];
  setPing(ping: () => Promise<unknown>): void;
}

function createHarness(options?: {
  intervalMs?: number;
  timeoutMs?: number;
  maxConsecutiveFailures?: number;
}): Harness & { stop(): void } {
  let currentPing: () => Promise<unknown> = async () => undefined;
  const events: string[] = [];
  const stop = startRuntimeSupervisor({
    ping: () => currentPing(),
    notify: (event) => events.push(event),
    intervalMs: options?.intervalMs ?? 15,
    timeoutMs: options?.timeoutMs ?? 200,
    maxConsecutiveFailures: options?.maxConsecutiveFailures ?? 3,
  });
  return {
    events,
    setPing: (ping) => {
      currentPing = ping;
    },
    stop,
  };
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

test("runtime supervisor: failures degrade and recovery broadcasts unavailable/recovered", async () => {
  const harness = createHarness();
  try {
    harness.setPing(async () => {
      throw new Error("daemon dead");
    });
    assert.ok(
      await waitForCondition(() => harness.events.filter((e) => e === "unavailable").length >= 3, 2000),
      "3 连败后每个失败 tick 都应广播 unavailable（不去重）",
    );

    // 降级后探活成功 → recovered（只广播一次）。
    harness.setPing(async () => undefined);
    assert.ok(
      await waitForCondition(() => harness.events.includes("recovered"), 2000),
      "降级后 ping 成功应广播 recovered",
    );
    const recoveredCount = harness.events.filter((e) => e === "recovered").length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      harness.events.filter((e) => e === "recovered").length,
      recoveredCount,
      "恢复后持续成功不应重复广播 recovered",
    );
  } finally {
    harness.stop();
  }
});

test("runtime supervisor: healthy pings stay silent and stop halts broadcasts", async () => {
  const harness = createHarness();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(harness.events, [], "从未降级的成功 ping 应保持静默");
  harness.stop();

  // stop 之后即使 ping 持续失败也不得再广播：先确定性等到降级广播出现，
  // 再 stop 并验证事件数不再增长。
  const deadHarness = createHarness();
  deadHarness.setPing(async () => {
    throw new Error("daemon dead");
  });
  try {
    assert.ok(
      await waitForCondition(() => deadHarness.events.length >= 1, 2000),
      "持续失败应广播 unavailable",
    );
  } finally {
    deadHarness.stop();
  }
  const afterStop = deadHarness.events.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(deadHarness.events.length, afterStop, "stop 后不应再广播");
});

test("runtime supervisor: sub-threshold failures reset without degrading", async () => {
  const harness = createHarness();
  try {
    // 失败配额精确控制：恰好 2 次失败（低于阈值 3）后恢复成功——
    // 无论 tick 时序如何偏移，失败次数被配额钉死，不会误触阈值。
    let failBudget = 2;
    harness.setPing(async () => {
      if (failBudget > 0) {
        failBudget -= 1;
        throw new Error("flaky");
      }
      return undefined;
    });
    assert.ok(
      await waitForCondition(() => failBudget === 0, 2000),
      "两次失败 tick 应已被消费",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(harness.events, [], "低于阈值的失败不应触发 unavailable");
  } finally {
    harness.stop();
  }
});

test("runtime supervisor: pseudo-dead ping (never settles) counts as failure via timeout", async () => {
  const harness = createHarness({ intervalMs: 15, timeoutMs: 30 });
  try {
    harness.setPing(
      () =>
        new Promise(() => {
          /* daemon 假死：pending 永不 settle */
        }),
    );
    assert.ok(
      await waitForCondition(() => harness.events.includes("unavailable"), 2000),
      "永不 settle 的 ping 应按超时计入失败并触发降级广播",
    );
  } finally {
    harness.stop();
  }
});
