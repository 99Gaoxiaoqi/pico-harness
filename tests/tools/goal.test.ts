// Goal 工具单元测试(ROADMAP 3.5 Goal Mode)
// 验证:CreateGoal / GetGoal / UpdateGoal 三个工具的 execute、元数据 readOnly/accesses、经 ToolRegistry execute

import { describe, expect, it } from "vitest";
import { GoalManager } from "../../src/engine/goal-manager.js";
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from "../../src/tools/goal.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

describe("Goal 工具", () => {
  describe("CreateGoalTool", () => {
    it("name 与 definition 正确", () => {
      const tool = new CreateGoalTool(new GoalManager());
      expect(tool.name()).toBe("create_goal");
      const def = tool.definition();
      expect(def.name).toBe("create_goal");
      expect(def.description).toContain("目标");
      expect((def.inputSchema as { required: string[] }).required).toEqual([
        "title",
        "description",
      ]);
    });

    it("非只读,accesses 返回 all()", () => {
      const tool = new CreateGoalTool(new GoalManager());
      expect(tool.readOnly).toBe(false);
      expect(tool.accesses("{}")).toEqual([{ kind: "all" }]);
    });

    it("创建目标并自动激活,返回成功描述", async () => {
      const mgr = new GoalManager();
      const tool = new CreateGoalTool(mgr);
      const out = await tool.execute(
        JSON.stringify({ title: "实现 Goal Mode", description: "状态机+工具+注入" }),
      );
      expect(out).toContain("已创建并激活目标");
      expect(out).toContain("实现 Goal Mode");
      expect(out).toContain("goal-1");
      expect(mgr.getActive()?.title).toBe("实现 Goal Mode");
    });

    it("带 budget 创建", async () => {
      const mgr = new GoalManager();
      const tool = new CreateGoalTool(mgr);
      const out = await tool.execute(
        JSON.stringify({
          title: "目标",
          description: "描述",
          budget: { maxTurns: 5, maxTokens: 1000 },
        }),
      );
      expect(out).toContain("5 轮");
      expect(out).toContain("1000 tokens");
      expect(mgr.getActive()?.budgetConfig).toEqual({ maxTurns: 5, maxTokens: 1000 });
    });

    it("缺少 title 抛错", async () => {
      const tool = new CreateGoalTool(new GoalManager());
      await expect(tool.execute(JSON.stringify({ description: "x" }))).rejects.toThrow(/title/);
    });

    it("缺少 description 抛错", async () => {
      const tool = new CreateGoalTool(new GoalManager());
      await expect(tool.execute(JSON.stringify({ title: "x" }))).rejects.toThrow(/description/);
    });

    it("非法 budget 抛错", async () => {
      const tool = new CreateGoalTool(new GoalManager());
      await expect(
        tool.execute(JSON.stringify({ title: "x", description: "y", budget: "notobj" })),
      ).rejects.toThrow(/budget/);
    });

    it("非法 JSON 抛错", async () => {
      const tool = new CreateGoalTool(new GoalManager());
      await expect(tool.execute("不是json")).rejects.toThrow(/参数解析失败/);
    });
  });

  describe("GetGoalTool", () => {
    it("name 与 definition 正确,只读,accesses none", () => {
      const tool = new GetGoalTool(new GoalManager());
      expect(tool.name()).toBe("get_goal");
      expect(tool.readOnly).toBe(true);
      expect(tool.accesses("{}")).toEqual([]);
    });

    it("无目标时返回提示", async () => {
      const tool = new GetGoalTool(new GoalManager());
      const out = await tool.execute("{}");
      expect(out).toContain("无任何目标");
    });

    it("传 id 返回单个目标详情", async () => {
      const mgr = new GoalManager();
      const tool = new GetGoalTool(mgr);
      mgr.create("标题", "描述");
      const out = await tool.execute(JSON.stringify({ id: "goal-1" }));
      expect(out).toContain("标题");
      expect(out).toContain("goal-1");
    });

    it("无 id 时优先返回 active goal", async () => {
      const mgr = new GoalManager();
      mgr.create("目标 A", "描述 A");
      mgr.create("目标 B", "描述 B");
      const tool = new GetGoalTool(mgr);
      const out = await tool.execute("{}");
      expect(out).toContain("当前激活目标");
      expect(out).toContain("目标 B");
    });

    it("无 active goal 时返回全部目标", async () => {
      const mgr = new GoalManager();
      mgr.create("目标 A", "描述 A");
      mgr.update("goal-1", { status: "complete" });
      const tool = new GetGoalTool(mgr);
      const out = await tool.execute("{}");
      expect(out).toContain("全部目标");
      expect(out).toContain("目标 A");
    });

    it("不存在的 id 抛错", async () => {
      const tool = new GetGoalTool(new GoalManager());
      await expect(tool.execute(JSON.stringify({ id: "goal-999" }))).rejects.toThrow(/未找到目标/);
    });
  });

  describe("UpdateGoalTool", () => {
    it("name 与 definition 正确,非只读,accesses all", () => {
      const tool = new UpdateGoalTool(new GoalManager());
      expect(tool.name()).toBe("update_goal");
      expect(tool.readOnly).toBe(false);
      expect(tool.accesses("{}")).toEqual([{ kind: "all" }]);
    });

    it("更新 progress", async () => {
      const mgr = new GoalManager();
      mgr.create("目标", "描述");
      const tool = new UpdateGoalTool(mgr);
      const out = await tool.execute(JSON.stringify({ id: "goal-1", progress: "完成 30%" }));
      expect(out).toContain("已更新目标");
      expect(out).toContain("完成 30%");
      expect(mgr.get("goal-1")?.progress).toBe("完成 30%");
    });

    it("更新 status 到 complete", async () => {
      const mgr = new GoalManager();
      mgr.create("目标", "描述");
      const tool = new UpdateGoalTool(mgr);
      const out = await tool.execute(JSON.stringify({ id: "goal-1", status: "complete" }));
      expect(out).toContain("已更新目标");
      expect(mgr.get("goal-1")?.status).toBe("complete");
      expect(mgr.getActive()).toBeUndefined();
    });

    it("更新 title/description", async () => {
      const mgr = new GoalManager();
      mgr.create("原标题", "原描述");
      const tool = new UpdateGoalTool(mgr);
      await tool.execute(JSON.stringify({ id: "goal-1", title: "新标题", description: "新描述" }));
      expect(mgr.get("goal-1")?.title).toBe("新标题");
      expect(mgr.get("goal-1")?.description).toBe("新描述");
    });

    it("更新 budget", async () => {
      const mgr = new GoalManager();
      mgr.create("目标", "描述");
      const tool = new UpdateGoalTool(mgr);
      await tool.execute(JSON.stringify({ id: "goal-1", budget: { maxTurns: 8 } }));
      expect(mgr.get("goal-1")?.budgetConfig).toEqual({ maxTurns: 8 });
    });

    it("缺少 id 抛错", async () => {
      const tool = new UpdateGoalTool(new GoalManager());
      await expect(tool.execute(JSON.stringify({ progress: "x" }))).rejects.toThrow(/id/);
    });

    it("无任何可更新字段抛错", async () => {
      const mgr = new GoalManager();
      mgr.create("目标", "描述");
      const tool = new UpdateGoalTool(mgr);
      await expect(tool.execute(JSON.stringify({ id: "goal-1" }))).rejects.toThrow(/至少/);
    });

    it("不存在的 id 抛错", async () => {
      const tool = new UpdateGoalTool(new GoalManager());
      await expect(tool.execute(JSON.stringify({ id: "goal-999", progress: "x" }))).rejects.toThrow(
        /未找到目标/,
      );
    });

    it("非法 status 抛错", async () => {
      const mgr = new GoalManager();
      mgr.create("目标", "描述");
      const tool = new UpdateGoalTool(mgr);
      await expect(tool.execute(JSON.stringify({ id: "goal-1", status: "done" }))).rejects.toThrow(
        /status/,
      );
    });

    it("非法 JSON 抛错", async () => {
      const tool = new UpdateGoalTool(new GoalManager());
      await expect(tool.execute("不是json")).rejects.toThrow(/参数解析失败/);
    });
  });

  describe("单例共享(关键架构约束)", () => {
    it("三个工具共享同一 GoalManager 实例:工具改的状态 manager 立即可见", async () => {
      const mgr = new GoalManager();
      const createTool = new CreateGoalTool(mgr);
      const getTool = new GetGoalTool(mgr);
      const updateTool = new UpdateGoalTool(mgr);

      await createTool.execute(JSON.stringify({ title: "共享目标", description: "x" }));
      await updateTool.execute(JSON.stringify({ id: "goal-1", progress: "一半" }));

      const out = await getTool.execute(JSON.stringify({ id: "goal-1" }));
      expect(out).toContain("共享目标");
      expect(out).toContain("一半");
      expect(mgr.getActive()?.progress).toBe("一半");
    });
  });

  describe("经 ToolRegistry execute", () => {
    it("三个工具注册并经 registry 路由执行", async () => {
      const mgr = new GoalManager();
      const registry = new ToolRegistry();
      registry.register(new CreateGoalTool(mgr));
      registry.register(new GetGoalTool(mgr));
      registry.register(new UpdateGoalTool(mgr));

      const names = registry.getAvailableTools().map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["create_goal", "get_goal", "update_goal"]));

      // create_goal 非只读;get_goal 只读;update_goal 非只读
      expect(registry.isReadOnlyTool("create_goal")).toBe(false);
      expect(registry.isReadOnlyTool("get_goal")).toBe(true);
      expect(registry.isReadOnlyTool("update_goal")).toBe(false);

      // create
      const r1 = await registry.execute({
        id: "c1",
        name: "create_goal",
        arguments: JSON.stringify({ title: "经 registry", description: "测试" }),
      });
      expect(r1.isError).toBe(false);
      expect(r1.output).toContain("已创建并激活目标");

      // update
      const r2 = await registry.execute({
        id: "u1",
        name: "update_goal",
        arguments: JSON.stringify({ id: "goal-1", status: "complete" }),
      });
      expect(r2.isError).toBe(false);

      // get
      const r3 = await registry.execute({
        id: "g1",
        name: "get_goal",
        arguments: JSON.stringify({ id: "goal-1" }),
      });
      expect(r3.isError).toBe(false);
      expect(r3.output).toContain("经 registry");
    });

    it("registry 对非法参数返回 isError", async () => {
      const mgr = new GoalManager();
      const registry = new ToolRegistry();
      registry.register(new CreateGoalTool(mgr));

      const result = await registry.execute({
        id: "bad",
        name: "create_goal",
        arguments: JSON.stringify({ description: "缺 title" }),
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("title");
    });

    it("registry 对不存在的工具返回 isError", async () => {
      const registry = new ToolRegistry();
      const result = await registry.execute({
        id: "ghost",
        name: "create_goal",
        arguments: "{}",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("不存在");
    });
  });
});
