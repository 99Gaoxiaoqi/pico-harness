// 资源冲突调度器单测(对标 kimi-code ToolScheduler)。
// 用耗时差反推调度策略(与 loop.test.ts 一致的测法):
//   - 并行:耗时 ≈ 单任务
//   - 串行:耗时 ≈ N × 单任务

import { describe, expect, it } from "vitest";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../src/tools/tool-access.js";
import { ToolScheduler, type ToolCallTask } from "../src/tools/tool-scheduler.js";

const DELAY = 50;

/** 造一个延迟 DELAY ms 后 resolve 的任务 */
function makeTask(accesses: ToolAccessesType, value: string): ToolCallTask<string> {
  return {
    accesses,
    start: async () => {
      await new Promise((r) => setTimeout(r, DELAY));
      return value;
    },
  };
}

describe("ToolScheduler 资源冲突调度", () => {
  it("三个不冲突任务全并行(几乎同时启动)", async () => {
    const timeline: Array<{ name: string; t: number }> = [];
    const T0 = Date.now();
    const tracked = (accesses: ToolAccessesType, name: string): ToolCallTask<string> => ({
      accesses,
      start: async () => {
        timeline.push({ name, t: Date.now() - T0 });
        await new Promise((r) => setTimeout(r, DELAY));
        return name;
      },
    });

    const scheduler = new ToolScheduler<string>();
    const results = await Promise.all([
      scheduler.add(tracked(ToolAccesses.readFile("/a"), "a")),
      scheduler.add(tracked(ToolAccesses.readFile("/b"), "b")),
      scheduler.add(tracked(ToolAccesses.readFile("/c"), "c")),
    ]);

    expect(results).toEqual(["a", "b", "c"]); // 按 add 顺序回传
    // 三个任务几乎同时启动(彼此启动间隔远小于 DELAY,说明是并行而非串行)
    const times = ["a", "b", "c"].map((n) => timeline.find((x) => x.name === n)!.t);
    const spread = Math.max(...times) - Math.min(...times);
    expect(spread).toBeLessThan(DELAY);
  });

  it("两个冲突任务串行(第二个在第一个完成后才启动)", async () => {
    const timeline: Array<{ name: string; t: number }> = [];
    const T0 = Date.now();
    const tracked = (accesses: ToolAccessesType, name: string): ToolCallTask<string> => ({
      accesses,
      start: async () => {
        timeline.push({ name, t: Date.now() - T0 });
        await new Promise((r) => setTimeout(r, DELAY));
        return name;
      },
    });

    const scheduler = new ToolScheduler<string>();
    const results = await Promise.all([
      scheduler.add(tracked(ToolAccesses.writeFile("/a"), "a")),
      scheduler.add(tracked(ToolAccesses.writeFile("/a"), "b")), // 同文件写冲突 → 串行
    ]);

    expect(results).toEqual(["a", "b"]);
    // b 的启动必须晚于 a 至少 DELAY(a 完成后 b 才启动)
    const startA = timeline.find((x) => x.name === "a")!.t;
    const startB = timeline.find((x) => x.name === "b")!.t;
    expect(startB - startA).toBeGreaterThanOrEqual(DELAY - 15);
  });

  it("混合:A、B 不冲突并行启动,C 与 A 冲突排队,A 完成后 C 才启动", async () => {
    // 用"启动时间戳"而非总耗时来验证调度 —— 更鲁棒,不受环境抖动影响。
    const timeline: Array<{ name: string; t: number }> = [];
    const T0 = Date.now();
    const recordStart = (name: string): void => {
      timeline.push({ name, t: Date.now() - T0 });
    };
    // 每个任务启动时记录时间戳,延迟 DELAY ms 后返回
    const trackedTask = (
      accesses: ToolAccessesType,
      name: string,
      delay = DELAY,
    ): ToolCallTask<string> => ({
      accesses,
      start: async () => {
        recordStart(name);
        await new Promise((r) => setTimeout(r, delay));
        return name;
      },
    });

    const scheduler = new ToolScheduler<string>();
    const results = await Promise.all([
      scheduler.add(trackedTask(ToolAccesses.writeFile("/a"), "A")),
      scheduler.add(trackedTask(ToolAccesses.writeFile("/b"), "B")), // 与 A 不冲突 → 同波启动
      scheduler.add(trackedTask(ToolAccesses.writeFile("/a"), "C")), // 与 A 冲突 → 等 A 完成后启动
    ]);

    expect(results).toEqual(["A", "B", "C"]);
    // 关键断言 1:A 和 B 几乎同时启动(同波)
    const startA = timeline.find((x) => x.name === "A")!.t;
    const startB = timeline.find((x) => x.name === "B")!.t;
    expect(Math.abs(startA - startB)).toBeLessThan(DELAY);
    // 关键断言 2:C 在 A 启动至少 DELAY 后才启动(A 完成后才轮到它)
    const startC = timeline.find((x) => x.name === "C")!.t;
    expect(startC - startA).toBeGreaterThanOrEqual(DELAY - 15);
  });

  it("all() 任务与一切冲突,必须独占执行", async () => {
    const scheduler = new ToolScheduler<string>();
    const start = Date.now();
    const results = await Promise.all([
      scheduler.add(makeTask(ToolAccesses.readFile("/a"), "A")), // 读 /a
      scheduler.add(makeTask(ToolAccesses.all(), "B")), // all → 与 A 冲突
    ]);
    const elapsed = Date.now() - start;

    expect(results).toEqual(["A", "B"]);
    expect(elapsed).toBeGreaterThanOrEqual(DELAY * 2 - 10); // 串行
  });

  it("任务异常会被 reject 且不阻塞后续任务", async () => {
    const scheduler = new ToolScheduler<string>();
    const task: ToolCallTask<string> = {
      accesses: ToolAccesses.none(),
      start: async () => {
        throw new Error("boom");
      },
    };
    const ok: ToolCallTask<string> = {
      accesses: ToolAccesses.none(),
      start: async () => "ok",
    };

    const p1 = scheduler.add(task);
    const p2 = scheduler.add(ok);

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
  });

  it("结果严格按 provider order(add 顺序)回传,即使完成顺序不同", async () => {
    const scheduler = new ToolScheduler<string>();
    // 第一个任务故意慢,验证结果顺序仍按 add 顺序
    const slow: ToolCallTask<string> = {
      accesses: ToolAccesses.readFile("/slow"),
      start: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return "slow";
      },
    };
    const fast: ToolCallTask<string> = {
      accesses: ToolAccesses.readFile("/fast"),
      start: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "fast";
      },
    };

    const results = await Promise.all([scheduler.add(slow), scheduler.add(fast)]);
    // fast 先完成,但结果数组仍按 add 顺序 [slow, fast]
    expect(results).toEqual(["slow", "fast"]);
  });
});
