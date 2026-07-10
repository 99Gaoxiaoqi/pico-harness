// TodoTool 单元测试
// 验证各 action 的 execute、非法 action 报错、经 ToolRegistry execute

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TodoStore } from "../../src/context/todo-store.js";
import { TodoTool } from "../../src/tools/todo.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

describe("TodoTool", () => {
  let workDir: string;
  let store: TodoStore;
  let tool: TodoTool;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-todotool-"));
    store = new TodoStore(workDir);
    tool = new TodoTool(store);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("name 与 definition 正确", () => {
    expect(tool.name()).toBe("todo");
    const def = tool.definition();
    expect(def.name).toBe("todo");
    expect(def.description).toContain("todo.json");
    expect((def.inputSchema as { required: string[] }).required).toEqual(["action"]);
  });

  it("非只读", () => {
    expect(tool.readOnly).toBe(false);
  });

  it("accesses 返回全量互斥(all)", () => {
    const accesses = tool.accesses("{}");
    expect(accesses).toEqual([{ kind: "all" }]);
  });

  describe("add", () => {
    it("添加任务返回成功描述", async () => {
      const out = await tool.execute(
        JSON.stringify({ action: "add", content: "实现工具", priority: "high" }),
      );
      expect(out).toContain("✅ 已添加任务 #1");
      expect(out).toContain("实现工具");
      expect(out).toContain("(high)");
    });

    it("缺少 content 抛错", async () => {
      await expect(tool.execute(JSON.stringify({ action: "add" }))).rejects.toThrow(/content/);
    });

    it("非法 priority 抛错", async () => {
      await expect(
        tool.execute(JSON.stringify({ action: "add", content: "x", priority: "urgent" })),
      ).rejects.toThrow(/priority/);
    });
  });

  describe("update", () => {
    it("更新任务字段", async () => {
      await tool.execute(JSON.stringify({ action: "add", content: "原任务" }));
      const out = await tool.execute(
        JSON.stringify({ action: "update", id: 1, content: "新任务", status: "in_progress" }),
      );
      expect(out).toContain("✅ 已更新任务 #1");
      expect(out).toContain("新任务");
      expect(out).toContain("[~]");
    });

    it("不存在的 id 抛错", async () => {
      await expect(
        tool.execute(JSON.stringify({ action: "update", id: 999, content: "x" })),
      ).rejects.toThrow(/未找到任务 #999/);
    });

    it("无任何可更新字段抛错", async () => {
      await tool.execute(JSON.stringify({ action: "add", content: "x" }));
      await expect(tool.execute(JSON.stringify({ action: "update", id: 1 }))).rejects.toThrow(
        /至少/,
      );
    });

    it("非法 status 抛错", async () => {
      await tool.execute(JSON.stringify({ action: "add", content: "x" }));
      await expect(
        tool.execute(JSON.stringify({ action: "update", id: 1, status: "done" })),
      ).rejects.toThrow(/status/);
    });
  });

  describe("toggle", () => {
    it("循环推进状态", async () => {
      await tool.execute(JSON.stringify({ action: "add", content: "任务" }));
      const o1 = await tool.execute(JSON.stringify({ action: "toggle", id: 1 }));
      expect(o1).toContain("[~]");
      const o2 = await tool.execute(JSON.stringify({ action: "toggle", id: 1 }));
      expect(o2).toContain("[x]");
    });

    it("不存在的 id 抛错", async () => {
      await expect(tool.execute(JSON.stringify({ action: "toggle", id: 5 }))).rejects.toThrow(
        /未找到/,
      );
    });
  });

  describe("remove", () => {
    it("删除任务返回描述", async () => {
      await tool.execute(JSON.stringify({ action: "add", content: "任务" }));
      const out = await tool.execute(JSON.stringify({ action: "remove", id: 1 }));
      expect(out).toContain("🗑️ 已删除任务 #1");

      // 删除后 list 应为空
      const list = await tool.execute(JSON.stringify({ action: "list" }));
      expect(list).toContain("清单为空");
    });

    it("不存在的 id 抛错", async () => {
      await expect(tool.execute(JSON.stringify({ action: "remove", id: 7 }))).rejects.toThrow(
        /未找到/,
      );
    });
  });

  describe("list", () => {
    it("空清单返回提示", async () => {
      const out = await tool.execute(JSON.stringify({ action: "list" }));
      expect(out).toContain("清单为空");
    });

    it("有任务返回渲染列表", async () => {
      await tool.execute(JSON.stringify({ action: "add", content: "任务 A", priority: "high" }));
      await tool.execute(JSON.stringify({ action: "add", content: "任务 B" }));
      const out = await tool.execute(JSON.stringify({ action: "list" }));
      expect(out).toContain("当前清单");
      expect(out).toContain("任务 A");
      expect(out).toContain("任务 B");
      expect(out).toContain("2 项");
    });
  });

  describe("错误处理", () => {
    it("非法 action 抛错", async () => {
      await expect(tool.execute(JSON.stringify({ action: "unknown" }))).rejects.toThrow(
        /非法 action/,
      );
    });

    it("缺少 action 抛错", async () => {
      await expect(tool.execute(JSON.stringify({}))).rejects.toThrow(/非法 action/);
    });

    it("非法 JSON 参数抛错", async () => {
      await expect(tool.execute("不是json")).rejects.toThrow(/参数解析失败/);
    });

    it("id 接受数字字符串", async () => {
      await tool.execute(JSON.stringify({ action: "add", content: "任务" }));
      const out = await tool.execute(JSON.stringify({ action: "toggle", id: "1" }));
      expect(out).toContain("[~]");
    });

    it("非法 id 类型抛错", async () => {
      await expect(tool.execute(JSON.stringify({ action: "toggle", id: "abc" }))).rejects.toThrow(
        /id/,
      );
    });
  });

  describe("经 ToolRegistry execute", () => {
    it("通过 registry 注册并执行 todo 工具", async () => {
      const registry = new ToolRegistry();
      registry.register(new TodoTool(new TodoStore(workDir)));

      // 工具应出现在可用清单
      const names = registry.getAvailableTools().map((t) => t.name);
      expect(names).toContain("todo");

      // todo 非只读
      expect(registry.isReadOnlyTool("todo")).toBe(false);

      // 经 registry.execute 走完完整路由
      const result = await registry.execute({
        id: "call_1",
        name: "todo",
        arguments: JSON.stringify({ action: "add", content: "经 registry 添加", priority: "low" }),
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("✅ 已添加任务 #1");
      expect(result.output).toContain("经 registry 添加");
    });

    it("registry 对非法 action 返回 isError", async () => {
      const registry = new ToolRegistry();
      registry.register(new TodoTool(new TodoStore(workDir)));

      const result = await registry.execute({
        id: "call_2",
        name: "todo",
        arguments: JSON.stringify({ action: "bogus" }),
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("非法 action");
    });
  });
});
