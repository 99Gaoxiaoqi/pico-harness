// PlanStore 单元测试:PLAN.md / TODO.md 读写 API + Plan Mode 唤醒嗅探。
//
// 用 mkdtemp 隔离每个用例的工作区,避免相互污染。
// 对应课程第 13 讲:Plan Mode 状态外部化的物理文件持久化层。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanStore } from "../src/context/plan-store.js";

describe("PlanStore", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-plan-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe("readPlan / readTodo", () => {
    it("文件不存在时返回 null", async () => {
      const store = new PlanStore(workDir);
      expect(await store.readPlan()).toBeNull();
      expect(await store.readTodo()).toBeNull();
    });

    it("文件存在时返回完整内容", async () => {
      await writeFile(join(workDir, "PLAN.md"), "# 架构\n采用 TS");
      await writeFile(join(workDir, "TODO.md"), "- [ ] 步骤一");
      const store = new PlanStore(workDir);
      expect(await store.readPlan()).toBe("# 架构\n采用 TS");
      expect(await store.readTodo()).toBe("- [ ] 步骤一");
    });
  });

  describe("writePlan / writeTodo", () => {
    it("写入后能读回原内容", async () => {
      const store = new PlanStore(workDir);
      await store.writePlan("# PLAN\n设计 A");
      await store.writeTodo("- [ ] todo1\n- [ ] todo2");
      expect(await store.readPlan()).toBe("# PLAN\n设计 A");
      expect(await store.readTodo()).toBe("- [ ] todo1\n- [ ] todo2");
    });

    it("覆盖写入会替换旧内容", async () => {
      const store = new PlanStore(workDir);
      await store.writePlan("v1");
      await store.writePlan("v2-overwrite");
      expect(await store.readPlan()).toBe("v2-overwrite");
    });

    it("写入的文件落盘到 workDir 根目录,路径正确", async () => {
      const store = new PlanStore(workDir);
      await store.writePlan("plan-content");
      await store.writeTodo("todo-content");
      // 直接用 fs 验证落盘路径,确保是 <workDir>/PLAN.md 与 <workDir>/TODO.md
      expect(await readFile(join(workDir, "PLAN.md"), "utf8")).toBe("plan-content");
      expect(await readFile(join(workDir, "TODO.md"), "utf8")).toBe("todo-content");
    });

    it("写入空字符串也能正常读回", async () => {
      const store = new PlanStore(workDir);
      await store.writePlan("");
      expect(await store.readPlan()).toBe("");
    });
  });

  describe("exists", () => {
    it("两个文件都不存在时返回 { plan: false, todo: false }", async () => {
      const store = new PlanStore(workDir);
      expect(await store.exists()).toEqual({ plan: false, todo: false });
    });

    it("只有 PLAN.md 时返回 { plan: true, todo: false }", async () => {
      await writeFile(join(workDir, "PLAN.md"), "plan");
      const store = new PlanStore(workDir);
      expect(await store.exists()).toEqual({ plan: true, todo: false });
    });

    it("只有 TODO.md 时返回 { plan: false, todo: true }", async () => {
      await writeFile(join(workDir, "TODO.md"), "todo");
      const store = new PlanStore(workDir);
      expect(await store.exists()).toEqual({ plan: false, todo: true });
    });

    it("两个文件都存在时返回 { plan: true, todo: true }", async () => {
      await writeFile(join(workDir, "PLAN.md"), "plan");
      await writeFile(join(workDir, "TODO.md"), "todo");
      const store = new PlanStore(workDir);
      expect(await store.exists()).toEqual({ plan: true, todo: true });
    });
  });

  describe("buildPlanContext - 全新任务分支", () => {
    it("两个文件都不存在时注入全新任务提示", async () => {
      const store = new PlanStore(workDir);
      const ctx = await store.buildPlanContext();
      expect(ctx).toContain("Plan Mode: ON");
      expect(ctx).toContain("全新任务");
      expect(ctx).toContain("write_file 创建 PLAN.md");
      expect(ctx).toContain("write_file 创建 TODO.md");
      expect(ctx).toContain("edit_file 把 TODO.md 对应条目改成 [x]");
    });

    it("全新任务提示不应包含断点续传专属文案", async () => {
      const store = new PlanStore(workDir);
      const ctx = await store.buildPlanContext();
      expect(ctx).not.toContain("断点续传");
      expect(ctx).not.toContain("绝对不要覆盖");
    });
  });

  describe("buildPlanContext - 断点续传分支", () => {
    it("两个文件都存在时注入内容并标记断点续传", async () => {
      await writeFile(join(workDir, "PLAN.md"), "# 架构设计\n采用 TypeScript");
      await writeFile(join(workDir, "TODO.md"), "- [ ] 步骤一\n- [x] 步骤二");
      const store = new PlanStore(workDir);
      const ctx = await store.buildPlanContext();
      // 断点续传标识
      expect(ctx).toContain("Plan Mode: ON");
      expect(ctx).toContain("断点续传");
      expect(ctx).toContain("检测到已存在 PLAN.md 和 TODO.md");
      // 注入了文件实际内容
      expect(ctx).toContain("采用 TypeScript");
      expect(ctx).toContain("- [ ] 步骤一");
      expect(ctx).toContain("- [x] 步骤二");
      // 强制约束:不覆盖 + edit_file 打勾
      expect(ctx).toContain("绝对不要覆盖 PLAN.md / TODO.md");
      expect(ctx).toContain("edit_file");
      // 不应出现全新任务文案
      expect(ctx).not.toContain("全新任务");
    });

    it("只有 PLAN.md 时仍走断点续传分支,TODO.md 显示文件不存在", async () => {
      await writeFile(join(workDir, "PLAN.md"), "# 架构\n设计 A");
      const store = new PlanStore(workDir);
      const ctx = await store.buildPlanContext();
      expect(ctx).toContain("断点续传");
      expect(ctx).toContain("检测到已存在 PLAN.md");
      // 文案只列实际存在的文件
      expect(ctx).not.toContain("PLAN.md 和 TODO.md");
      // TODO.md 缺失占位
      expect(ctx).toContain("(文件不存在)");
      expect(ctx).toContain("设计 A");
    });

    it("只有 TODO.md 时仍走断点续传分支,PLAN.md 显示文件不存在", async () => {
      await writeFile(join(workDir, "TODO.md"), "- [ ] 步骤");
      const store = new PlanStore(workDir);
      const ctx = await store.buildPlanContext();
      expect(ctx).toContain("断点续传");
      expect(ctx).toContain("检测到已存在 TODO.md");
      expect(ctx).not.toContain("PLAN.md 和 TODO.md");
      expect(ctx).toContain("- [ ] 步骤");
      // PLAN.md 缺失占位
      expect(ctx).toContain("(文件不存在)");
    });

    it("注入的内容包裹在 markdown 代码块中,避免与外层 prompt 冲突", async () => {
      await writeFile(join(workDir, "PLAN.md"), "PLAN_BODY");
      await writeFile(join(workDir, "TODO.md"), "TODO_BODY");
      const store = new PlanStore(workDir);
      const ctx = await store.buildPlanContext();
      expect(ctx).toContain("```markdown\nPLAN_BODY\n```");
      expect(ctx).toContain("```markdown\nTODO_BODY\n```");
    });
  });

  describe("路径绑定", () => {
    it("构造时绑定 workDir,读写都发生在该目录下(无路径穿越风险)", async () => {
      const store = new PlanStore(workDir);
      await store.writePlan("in-workdir");
      // 确认文件确实落在 workDir/PLAN.md,不会逃逸到别处
      expect(await readFile(join(workDir, "PLAN.md"), "utf8")).toBe("in-workdir");
      // 不存在其他 PLAN.md 路径被创建
      const store2 = new PlanStore(join(workDir, "subdir-not-exists"));
      // 读另一个 workDir 的 PlanStore 应返回 null,互不干扰
      expect(await store2.readPlan()).toBeNull();
      expect(await store.readPlan()).toBe("in-workdir");
    });
  });
});
