// GoalManager 单元测试(ROADMAP 3.5 Goal Mode)
// 验证:create/get/update/list/setActive/remove、状态机流转、buildGoalContext、budget 配置

import { describe, expect, it } from "vitest";
import { GoalManager } from "../../src/engine/goal-manager.js";

describe("GoalManager", () => {
  describe("create", () => {
    it("创建目标并自动设为 active,id 自增", () => {
      const mgr = new GoalManager();
      const g1 = mgr.create("实现功能 A", "完成 A 模块的全部开发与测试");
      expect(g1.id).toBe("goal-1");
      expect(g1.status).toBe("active");
      expect(g1.title).toBe("实现功能 A");
      expect(g1.description).toBe("完成 A 模块的全部开发与测试");
      expect(g1.createdAt).toBeGreaterThan(0);
      expect(g1.budgetConfig).toBeUndefined();

      const g2 = mgr.create("实现功能 B", "...");
      expect(g2.id).toBe("goal-2");
    });

    it("创建带 budget 配置的目标", () => {
      const mgr = new GoalManager();
      const g = mgr.create("目标", "描述", {
        maxTurns: 10,
        maxTokens: 5000,
        maxWallClockMs: 60000,
      });
      expect(g.budgetConfig).toEqual({
        maxTurns: 10,
        maxTokens: 5000,
        maxWallClockMs: 60000,
      });
    });

    it("新建目标会自动把旧 active 降级为 paused", () => {
      const mgr = new GoalManager();
      const g1 = mgr.create("目标 1", "描述");
      expect(g1.status).toBe("active");

      const g2 = mgr.create("目标 2", "描述");
      expect(g2.status).toBe("active");
      // g1 被降级为 paused
      expect(mgr.get("goal-1")?.status).toBe("paused");
      expect(mgr.getActive()?.id).toBe("goal-2");
    });
  });

  describe("get / getActive", () => {
    it("按 id 取目标,不存在返回 undefined", () => {
      const mgr = new GoalManager();
      expect(mgr.get("goal-999")).toBeUndefined();
      const g = mgr.create("目标", "描述");
      expect(mgr.get(g.id)?.title).toBe("目标");
    });

    it("getActive 返回当前激活目标,无激活返回 undefined", () => {
      const mgr = new GoalManager();
      expect(mgr.getActive()).toBeUndefined();
      const g = mgr.create("目标", "描述");
      expect(mgr.getActive()?.id).toBe(g.id);
    });
  });

  describe("update", () => {
    it("更新单个字段,其余保持", () => {
      const mgr = new GoalManager();
      const g = mgr.create("原标题", "原描述");
      const updated = mgr.update(g.id, { progress: "已完成 50%" });
      expect(updated?.progress).toBe("已完成 50%");
      expect(updated?.title).toBe("原标题");
    });

    it("更新多个字段", () => {
      const mgr = new GoalManager();
      const g = mgr.create("标题", "描述");
      const updated = mgr.update(g.id, {
        title: "新标题",
        description: "新描述",
        progress: "进行中",
      });
      expect(updated?.title).toBe("新标题");
      expect(updated?.description).toBe("新描述");
      expect(updated?.progress).toBe("进行中");
    });

    it("更新 budget 配置", () => {
      const mgr = new GoalManager();
      const g = mgr.create("标题", "描述");
      const updated = mgr.update(g.id, { budgetConfig: { maxTurns: 5 } });
      expect(updated?.budgetConfig).toEqual({ maxTurns: 5 });
    });

    it("更新 blockedReason", () => {
      const mgr = new GoalManager();
      const g = mgr.create("标题", "描述");
      const updated = mgr.update(g.id, {
        status: "blocked",
        blockedReason: "缺少 API key",
      });
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockedReason).toBe("缺少 API key");
    });

    it("找不到目标返回 undefined", () => {
      const mgr = new GoalManager();
      expect(mgr.update("goal-999", { title: "x" })).toBeUndefined();
    });

    it("非法 status 抛错", () => {
      const mgr = new GoalManager();
      const g = mgr.create("标题", "描述");
      expect(() => mgr.update(g.id, { status: "invalid" as never })).toThrow(/非法 goal 状态/);
    });
  });

  describe("状态机流转", () => {
    it("active → paused → active → complete", () => {
      const mgr = new GoalManager();
      const g = mgr.create("目标", "描述");

      // active → paused
      mgr.update(g.id, { status: "paused" });
      expect(mgr.get(g.id)?.status).toBe("paused");
      expect(mgr.getActive()).toBeUndefined();

      // paused → active(重新激活)
      mgr.update(g.id, { status: "active" });
      expect(mgr.get(g.id)?.status).toBe("active");
      expect(mgr.getActive()?.id).toBe(g.id);

      // active → complete
      mgr.update(g.id, { status: "complete", progress: "全部完成" });
      expect(mgr.get(g.id)?.status).toBe("complete");
      expect(mgr.getActive()).toBeUndefined();
    });

    it("把 B 置为 active 会把当前 active 的 A 降级为 paused", () => {
      const mgr = new GoalManager();
      const a = mgr.create("目标 A", "描述");
      const b = mgr.create("目标 B", "描述");
      // 此时 B 是 active,A 是 paused(create 时自动降级)
      expect(mgr.getActive()?.id).toBe(b.id);
      expect(mgr.get(a.id)?.status).toBe("paused");

      // 重新激活 A:B 应被降级为 paused
      mgr.update(a.id, { status: "active" });
      expect(mgr.getActive()?.id).toBe(a.id);
      expect(mgr.get(b.id)?.status).toBe("paused");
    });

    it("blocked 状态保留 blockedReason", () => {
      const mgr = new GoalManager();
      const g = mgr.create("目标", "描述");
      mgr.update(g.id, { status: "blocked", blockedReason: "等待依赖" });
      expect(mgr.get(g.id)?.status).toBe("blocked");
      expect(mgr.getActive()).toBeUndefined();
    });
  });

  describe("setActive", () => {
    it("显式激活目标,原 active 降级", () => {
      const mgr = new GoalManager();
      const a = mgr.create("A", "描述");
      const b = mgr.create("B", "描述");
      // 激活 A(B 应降级)
      mgr.setActive(a.id);
      expect(mgr.getActive()?.id).toBe(a.id);
      expect(mgr.get(b.id)?.status).toBe("paused");
    });

    it("激活不存在的目标抛错", () => {
      const mgr = new GoalManager();
      expect(() => mgr.setActive("goal-999")).toThrow(/未找到目标/);
    });

    it("激活已 complete 的目标抛错", () => {
      const mgr = new GoalManager();
      const g = mgr.create("目标", "描述");
      mgr.update(g.id, { status: "complete" });
      expect(() => mgr.setActive(g.id)).toThrow(/已完成,无法重新激活/);
    });
  });

  describe("list / remove", () => {
    it("list 按创建顺序返回全部目标", () => {
      const mgr = new GoalManager();
      mgr.create("A", "描述");
      mgr.create("B", "描述");
      mgr.create("C", "描述");
      const titles = mgr.list().map((g) => g.title);
      expect(titles).toEqual(["A", "B", "C"]);
    });

    it("remove 删除目标返回 true,不存在返回 false", () => {
      const mgr = new GoalManager();
      const g = mgr.create("目标", "描述");
      expect(mgr.remove(g.id)).toBe(true);
      expect(mgr.list()).toHaveLength(0);
      expect(mgr.remove(g.id)).toBe(false);
    });

    it("删除当前 active 目标后 getActive 返回 undefined", () => {
      const mgr = new GoalManager();
      const g = mgr.create("目标", "描述");
      expect(mgr.getActive()?.id).toBe(g.id);
      mgr.remove(g.id);
      expect(mgr.getActive()).toBeUndefined();
    });
  });

  describe("buildGoalContext", () => {
    it("无 active goal 返回空串", () => {
      const mgr = new GoalManager();
      expect(mgr.buildGoalContext()).toBe("");
    });

    it("有 active goal 返回含标题/状态/描述/进度的 Markdown", () => {
      const mgr = new GoalManager();
      mgr.create("实现 Goal Mode", "完成状态机 + 工具 + context 注入");
      mgr.update("goal-1", { progress: "已写完状态机" });

      const ctx = mgr.buildGoalContext();
      expect(ctx).toContain("## 🎯 当前 Goal");
      expect(ctx).toContain("实现 Goal Mode");
      expect(ctx).toContain("🟢"); // active 状态的 emoji 标记
      expect(ctx).toContain("状态机 + 工具 + context 注入");
      expect(ctx).toContain("已写完状态机");
    });

    it("budget 配置被渲染进 context", () => {
      const mgr = new GoalManager();
      mgr.create("目标", "描述", { maxTurns: 10, maxTokens: 5000 });
      const ctx = mgr.buildGoalContext();
      expect(ctx).toContain("10 轮");
      expect(ctx).toContain("5000 tokens");
    });

    it("active goal 被 paused 后 context 返回空", () => {
      const mgr = new GoalManager();
      const g = mgr.create("目标", "描述");
      mgr.update(g.id, { status: "paused" });
      expect(mgr.buildGoalContext()).toBe("");
    });
  });
});
