// TodoStore 单元测试
// 验证 add/update/toggle/remove/list、持久化、降级、buildTodoContext

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodoStore } from "../../src/context/todo-store.js";
import { logger } from "../../src/observability/logger.js";

// 仅在 "save 失败" 测试中激活:用 hoisted 标志位控制是否注入抛错的 writeFile。
// vi.mock 提升到文件顶部,模块路径固定,故用运行时开关避免影响其他测试。
const __saveShouldFail = vi.hoisted(() => ({ value: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (__saveShouldFail.value) {
        throw Object.assign(new Error("模拟磁盘满"), { code: "ENOSPC" });
      }
      return actual.writeFile(...args);
    },
  };
});

describe("TodoStore", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-todo-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe("add", () => {
    it("添加任务并自增 id", async () => {
      const store = new TodoStore(workDir);
      const a = await store.add("写测试", "high");
      const b = await store.add("提交");
      const c = await store.add("部署", "low");

      expect(a).toEqual({ id: 1, content: "写测试", status: "pending", priority: "high" });
      expect(b).toEqual({ id: 2, content: "提交", status: "pending", priority: "medium" });
      expect(c.id).toBe(3);
      expect(c.priority).toBe("low");
    });

    it("默认 priority 为 medium", async () => {
      const store = new TodoStore(workDir);
      const item = await store.add("任务");
      expect(item.priority).toBe("medium");
    });
  });

  describe("update", () => {
    it("更新存在的任务字段", async () => {
      const store = new TodoStore(workDir);
      const item = await store.add("原始任务", "low");

      const updated = await store.update(item.id, {
        content: "改后任务",
        priority: "high",
        status: "in_progress",
      });

      expect(updated).toEqual({
        id: item.id,
        content: "改后任务",
        priority: "high",
        status: "in_progress",
      });
    });

    it("只更新部分字段,其余保持", async () => {
      const store = new TodoStore(workDir);
      const item = await store.add("任务", "high");

      const updated = await store.update(item.id, { status: "completed" });
      expect(updated?.status).toBe("completed");
      expect(updated?.priority).toBe("high");
      expect(updated?.content).toBe("任务");
    });

    it("找不到任务返回 undefined", async () => {
      const store = new TodoStore(workDir);
      const updated = await store.update(999, { content: "不存在" });
      expect(updated).toBeUndefined();
    });
  });

  describe("toggle", () => {
    it("循环切换状态 pending→in_progress→completed→pending", async () => {
      const store = new TodoStore(workDir);
      const item = await store.add("任务");

      const s1 = await store.toggle(item.id);
      expect(s1?.status).toBe("in_progress");

      const s2 = await store.toggle(item.id);
      expect(s2?.status).toBe("completed");

      const s3 = await store.toggle(item.id);
      expect(s3?.status).toBe("pending");
    });

    it("找不到任务返回 undefined", async () => {
      const store = new TodoStore(workDir);
      const toggled = await store.toggle(999);
      expect(toggled).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("删除存在的任务返回 true", async () => {
      const store = new TodoStore(workDir);
      const item = await store.add("任务");

      const removed = await store.remove(item.id);
      expect(removed).toBe(true);

      expect(store.list()).toHaveLength(0);
    });

    it("删除不存在的任务返回 false", async () => {
      const store = new TodoStore(workDir);
      const removed = await store.remove(999);
      expect(removed).toBe(false);
    });
  });

  describe("list", () => {
    it("按优先级(高→低)再按 id 升序排序", async () => {
      const store = new TodoStore(workDir);
      await store.add("低优 1", "low");
      await store.add("高优 1", "high");
      await store.add("中优 1", "medium");
      await store.add("高优 2", "high");

      const ordered = store.list().map((it) => `${it.priority}-${it.content}`);
      expect(ordered).toEqual(["high-高优 1", "high-高优 2", "medium-中优 1", "low-低优 1"]);
    });

    it("空清单返回空数组", async () => {
      const store = new TodoStore(workDir);
      await store.load();
      expect(store.list()).toEqual([]);
    });
  });

  describe("持久化", () => {
    it("写入后重新 new TodoStore 再 load 能恢复数据", async () => {
      const store1 = new TodoStore(workDir);
      await store1.add("任务 A", "high");
      await store1.add("任务 B");
      await store1.update(2, { status: "in_progress" });

      // 模拟跨会话:新建实例从磁盘加载
      const store2 = new TodoStore(workDir);
      const state = await store2.load();

      expect(state.items).toHaveLength(2);
      expect(state.nextId).toBe(3);
      const items = store2.list();
      expect(items[0]).toMatchObject({
        id: 1,
        content: "任务 A",
        priority: "high",
        status: "pending",
      });
      expect(items[1]).toMatchObject({
        id: 2,
        content: "任务 B",
        priority: "medium",
        status: "in_progress",
      });
    });

    it("load 幂等:多次调用返回同一缓存", async () => {
      const store = new TodoStore(workDir);
      await store.add("任务");
      const a = await store.load();
      const b = await store.load();
      expect(a).toBe(b);
    });

    it("reload 强制重读磁盘,能看到其他实例的写入", async () => {
      // 实例 A(TodoTool 侧)写入
      const storeA = new TodoStore(workDir);
      await storeA.add("任务 A");

      // 实例 B(Composer 侧)首次 load,缓存被冻结
      const storeB = new TodoStore(workDir);
      await storeB.load();
      expect(storeB.list()).toHaveLength(1);

      // A 再追加一条
      await storeA.add("任务 B");

      // B 的 load 幂等,看不到新增
      await storeB.load();
      expect(storeB.list()).toHaveLength(1);

      // B 调 reload 强制重读,看到磁盘最新
      await storeB.reload();
      expect(storeB.list()).toHaveLength(2);
      expect(storeB.list().map((it) => it.content)).toEqual(["任务 A", "任务 B"]);
    });

    it("同一单例:共享实例的两个调用方互相可见(注入范式回归)", async () => {
      // 模拟 run-agent 注入范式:host 创建��一实例,工具侧与 composer 侧共享
      const shared = new TodoStore(workDir);

      // 工具侧(等同 TodoTool 内部):经 add/update 改状态
      await shared.add("写代码", "high");
      await shared.add("写测试", "medium");
      await shared.update(1, { status: "in_progress" });

      // composer 侧:同一实例 buildTodoContext,立即看到工具侧改动
      const ctx = await shared.buildTodoContext();
      expect(ctx).toContain("- [~] #1 (high) 写代码");
      expect(ctx).toContain("- [ ] #2 (medium) 写测试");
    });
  });

  describe("降级", () => {
    it("todo.json 含非法 JSON,load 返回空 state 不抛", async () => {
      const todoDir = join(workDir, ".claw");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(todoDir, { recursive: true });
      await writeFile(join(todoDir, "todo.json"), "{这不是合法JSON");

      const store = new TodoStore(workDir);
      await expect(store.load()).resolves.toEqual({ items: [], nextId: 1 });
      expect(store.list()).toHaveLength(0);
    });

    it("todo.json 结构非法(字段缺失),load 返回空 state", async () => {
      const todoDir = join(workDir, ".claw");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(todoDir, { recursive: true });
      // items 不是数组 / nextId 缺失
      await writeFile(join(todoDir, "todo.json"), JSON.stringify({ foo: "bar" }));

      const store = new TodoStore(workDir);
      const state = await store.load();
      expect(state.items).toEqual([]);
    });

    it("todo.json 含畸形条目,load 丢弃畸形项保留合法项", async () => {
      const todoDir = join(workDir, ".claw");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(todoDir, { recursive: true });
      const raw = {
        items: [
          { id: 1, content: "合法", status: "pending", priority: "low" },
          { id: "不是数字", content: "非法", status: "pending", priority: "low" },
          { id: 2, content: "也合法", status: "in_progress", priority: "high" },
          { id: 3, content: "状态非法", status: "done", priority: "low" },
        ],
        nextId: 2,
      };
      await writeFile(join(todoDir, "todo.json"), JSON.stringify(raw));

      const store = new TodoStore(workDir);
      const state = await store.load();
      // 只剩两条合法
      expect(state.items.map((it) => it.id)).toEqual([1, 2]);
      // nextId 被纠正为 maxId+1
      expect(state.nextId).toBe(3);
    });

    it("save 失败只 warn 不抛,内存缓存仍生效", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      // 开启 writeFile 强制抛 ENOSPC(模拟磁盘满)
      __saveShouldFail.value = true;
      const store = new TodoStore(workDir);

      try {
        // add 内部 await load()(读盘返回空)再 await save()(被 mock 抛 ENOSPC)
        await expect(store.add("任务")).resolves.toBeDefined();
        // 内存缓存仍生效:list 能看到刚加的项
        expect(store.list()).toHaveLength(1);
        // save 失败被降级:warn 被调用过
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        __saveShouldFail.value = false;
        warnSpy.mockRestore();
      }
    });
  });

  describe("buildTodoContext", () => {
    it("空列表返回空字符串", async () => {
      const store = new TodoStore(workDir);
      await expect(store.buildTodoContext()).resolves.toBe("");
    });

    it("有任务时返回 Markdown,状态标记正确", async () => {
      const store = new TodoStore(workDir);
      await store.add("实现 Glob 工具", "high");
      const item2 = await store.add("写测试", "medium");
      await store.update(item2.id, { status: "in_progress" });
      await store.add("提交", "low");
      await store.update(3, { status: "completed" });

      const md = await store.buildTodoContext();
      expect(md).toContain("## 📋 当前 TodoList");
      expect(md).toContain("- [ ] #1 (high) 实现 Glob 工具");
      expect(md).toContain("- [~] #2 (medium) 写测试");
      expect(md).toContain("- [x] #3 (low) 提交");
    });
  });
});
