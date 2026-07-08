// QueryGuard 单元测试:验证三态状态机转换 + generation 防陈旧(对标 Claude Code)。

import { describe, expect, it, vi } from "vitest";
import { QueryGuard } from "../../src/tui/query-guard.js";

describe("QueryGuard", () => {
  it("初始状态 idle,getSnapshot 返回 'idle'", () => {
    const g = new QueryGuard();
    expect(g.isActive).toBe(false);
    expect(g.getSnapshot()).toBe("idle");
  });

  it("reserve: idle → dispatching", () => {
    const g = new QueryGuard();
    expect(g.reserve()).toBe(true);
    expect(g.isActive).toBe(true);
    expect(g.getSnapshot()).toBe("dispatching");
  });

  it("reserve 非 idle 时返回 false", () => {
    const g = new QueryGuard();
    g.reserve();
    expect(g.reserve()).toBe(false); // dispatching 时不能再次 reserve
  });

  it("cancelReservation: dispatching → idle", () => {
    const g = new QueryGuard();
    g.reserve();
    g.cancelReservation();
    expect(g.getSnapshot()).toBe("idle");
    expect(g.isActive).toBe(false);
  });

  it("tryStart: → running,返回 generation 号", () => {
    const g = new QueryGuard();
    const gen = g.tryStart();
    expect(gen).toBe(1);
    expect(g.getSnapshot()).toBe("running");
    expect(g.isActive).toBe(true);
  });

  it("tryStart 已 running 时返回 null(并发防护)", () => {
    const g = new QueryGuard();
    g.tryStart();
    expect(g.tryStart()).toBeNull();
  });

  it("tryStart 从 dispatching 也能进入 running", () => {
    const g = new QueryGuard();
    g.reserve();
    const gen = g.tryStart();
    expect(gen).toBe(1);
    expect(g.getSnapshot()).toBe("running");
  });

  it("end: running → idle,generation 匹配返回 true", () => {
    const g = new QueryGuard();
    const gen = g.tryStart()!;
    expect(g.end(gen)).toBe(true);
    expect(g.getSnapshot()).toBe("idle");
  });

  it("end generation 不匹配返回 false(防陈旧 cleanup)", () => {
    const g = new QueryGuard();
    const gen1 = g.tryStart()!;
    g.forceEnd(); // 取消,generation 自增
    const gen2 = g.tryStart()!; // 新查询
    expect(gen2).toBe(gen1 + 2); // forceEnd +1, tryStart +1
    // 旧查询的 finally 用 gen1 调 end → 不匹配 → false(跳过 cleanup)
    expect(g.end(gen1)).toBe(false);
    expect(g.getSnapshot()).toBe("running"); // 新查询仍在运行
  });

  it("forceEnd: 任意状态 → idle,generation 自增", () => {
    const g = new QueryGuard();
    g.tryStart();
    g.forceEnd();
    expect(g.getSnapshot()).toBe("idle");
    expect(g.generation).toBe(2);
  });

  it("subscribe/getSnapshot:useSyncExternalStore 兼容", () => {
    const g = new QueryGuard();
    const listener = vi.fn();
    const unsub = g.subscribe(listener);
    g.tryStart();
    expect(listener).toHaveBeenCalled();
    expect(g.getSnapshot()).toBe("running");
    unsub();
    listener.mockClear();
    g.end(1);
    expect(listener).not.toHaveBeenCalled(); // 已取消订阅
  });

  it("完整生命周期:idle → reserve → running → idle", () => {
    const g = new QueryGuard();
    expect(g.reserve()).toBe(true);
    const gen = g.tryStart();
    expect(gen).toBe(1);
    expect(g.end(gen!)).toBe(true);
    expect(g.isActive).toBe(false);
  });
});
