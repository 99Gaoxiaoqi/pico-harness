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

describe("ToolScheduler 执行器韧性(maxConcurrency + signal)", () => {
  it("并发上限触发:超出的任务排队,名额释放后依次启动", async () => {
    // 6 个互不冲突(none)任务,上限 2 → 应分 3 波,每波 2 个
    const timeline: Array<{ name: string; t: number }> = [];
    const T0 = Date.now();
    const wave = (name: string): ToolCallTask<string> => ({
      accesses: ToolAccesses.none(),
      start: async () => {
        timeline.push({ name, t: Date.now() - T0 });
        await new Promise((r) => setTimeout(r, DELAY));
        return name;
      },
    });

    const scheduler = new ToolScheduler<string>({ maxConcurrency: 2 });
    const promises = ["t1", "t2", "t3", "t4", "t5", "t6"].map((n) => scheduler.add(wave(n)));
    const results = await Promise.all(promises);

    expect(results).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    // t1、t2 第一波(几乎同时),t3、t4 第二波(晚 ~DELAY),t5、t6 第三波(晚 ~2*DELAY)
    const t3 = timeline.find((x) => x.name === "t3")!.t;
    const t1 = timeline.find((x) => x.name === "t1")!.t;
    expect(t3 - t1).toBeGreaterThanOrEqual(DELAY - 15); // t3 必须在 t1 完成后才启动
  });

  it("中断信号:排队的任务被 reject,不永久 pending", async () => {
    // 上限 1,第一个任务占住名额,第二个排队;触发 abort → 第二个应 reject
    const ctrl = new AbortController();
    const scheduler = new ToolScheduler<string>({ maxConcurrency: 1, signal: ctrl.signal });
    const longRunning: ToolCallTask<string> = {
      accesses: ToolAccesses.none(),
      start: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return "slow";
      },
    };
    const queued: ToolCallTask<string> = {
      accesses: ToolAccesses.none(),
      start: async () => "queued",
    };

    const p1 = scheduler.add(longRunning);
    const p2 = scheduler.add(queued);
    // 触发中断:排队的 p2 必须被 reject(否则 await 会永久卡住)
    ctrl.abort();

    await expect(p2).rejects.toThrow(); // 中止错误,具体文案不绑死
    // 正在跑的 p1 也会被 reject 外部句柄,让 Promise.all 能快速收口
    await expect(p1).rejects.toThrow();
  });

  it("已 abort 的信号传入:所有任务立即 reject", async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // 传入前就已是 aborted 态
    const scheduler = new ToolScheduler<string>({ signal: ctrl.signal });
    const task: ToolCallTask<string> = {
      accesses: ToolAccesses.none(),
      start: async () => "should-not-run",
    };

    // add 时短路 reject,任务根本不会 start
    await expect(scheduler.add(task)).rejects.toThrow();
    // 中止后续 add 也直接 reject
    await expect(scheduler.add(task)).rejects.toThrow();
  });

  it("无参构造向后兼容:maxConcurrency 默认 Infinity,全并行", async () => {
    const timeline: Array<{ name: string; t: number }> = [];
    const T0 = Date.now();
    const wave = (name: string): ToolCallTask<string> => ({
      accesses: ToolAccesses.none(),
      start: async () => {
        timeline.push({ name, t: Date.now() - T0 });
        await new Promise((r) => setTimeout(r, DELAY));
        return name;
      },
    });

    const scheduler = new ToolScheduler<string>(); // 无参
    const promises = ["a", "b", "c", "d", "e"].map((n) => scheduler.add(wave(n)));
    const results = await Promise.all(promises);

    expect(results).toEqual(["a", "b", "c", "d", "e"]);
    const times = ["a", "b", "c", "d", "e"].map((n) => timeline.find((x) => x.name === n)!.t);
    const spread = Math.max(...times) - Math.min(...times);
    expect(spread).toBeLessThan(DELAY); // 无上限 → 全部同时启动
  });
});
