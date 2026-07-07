// ExitPlanModeTool 单元测试(ROADMAP 3.6 Plan Review 审批)
// 验证:approve / reject / modify 三态审批、无 plan 提示、工具元数据、经 registry execute。

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanStore } from "../../src/context/plan-store.js";
import { ExitPlanModeTool } from "../../src/tools/plan-exit.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import { ApprovalManager, type ApprovalNotice } from "../../src/approval/manager.js";

/**
 * 辅助:执行 ExitPlanModeTool 并并行 resolve 审批。
 * waitForApproval 会挂起,必须在另一个微任务里 resolve 才能唤醒���
 */
async function runWithResolve(
  tool: ExitPlanModeTool,
  manager: ApprovalManager,
  noticeRef: { notice?: ApprovalNotice },
  resolveFn: (taskId: string, manager: ApprovalManager) => void,
): Promise<string> {
  const execPromise = tool.execute("{}");
  // execute 内部 waitForApproval 挂起后,noticeRef.notice 才有值;轮询等待。
  const waitForNotice = async () => {
    while (!noticeRef.notice) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return noticeRef.notice.taskId;
  };
  const taskId = await waitForNotice();
  resolveFn(taskId, manager);
  return execPromise;
}

describe("ExitPlanModeTool", () => {
  let workDir: string;
  let store: PlanStore;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-planexit-"));
    store = new PlanStore(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("name 与 definition 正确", () => {
    const tool = new ExitPlanModeTool(store, new ApprovalManager());
    expect(tool.name()).toBe("exit_plan_mode");
    const def = tool.definition();
    expect(def.name).toBe("exit_plan_mode");
    expect(def.description).toContain("PLAN.md");
    expect(def.description).toContain("approve");
    expect(def.description).toContain("modify");
  });

  it("非只读", () => {
    const tool = new ExitPlanModeTool(store, new ApprovalManager());
    expect(tool.readOnly).toBe(false);
  });

  it("accesses 返回全量互斥(all)", () => {
    const tool = new ExitPlanModeTool(store, new ApprovalManager());
    expect(tool.accesses("{}")).toEqual([{ kind: "all" }]);
  });

  it("无 PLAN.md 时提示无 plan 可提交", async () => {
    const tool = new ExitPlanModeTool(store, new ApprovalManager());
    const out = await tool.execute("{}");
    expect(out).toContain("没有 PLAN.md");
    expect(out).toContain("无 plan 可提交");
  });

  it("approve:审批通过 → 调 onExit → 返回成功", async () => {
    await store.writePlan("# 我的计划\n步骤一");
    const manager = new ApprovalManager();
    const noticeRef: { notice?: ApprovalNotice } = {};
    const tool = new ExitPlanModeTool(store, manager);
    tool.setNotify((n) => {
      noticeRef.notice = n;
    });

    let exited = false;
    let approvedPlan: string | undefined;
    tool.setExitCallback((plan) => {
      exited = true;
      approvedPlan = plan;
    });

    const out = await runWithResolve(tool, manager, noticeRef, (taskId, mgr) => {
      mgr.resolveApproval(taskId, true, "已批准");
    });

    expect(out).toContain("✅ 审批通过");
    expect(out).toContain("已退出 Plan Mode");
    expect(exited).toBe(true);
    expect(approvedPlan).toBeUndefined(); // approve 不携带内容
    // 通知的 diff 字段携带 plan 内容
    expect(noticeRef.notice?.diff).toContain("我的计划");
  });

  it("reject:审批被拒 → 不调 onExit → 返回拒绝", async () => {
    await store.writePlan("# 计划");
    const manager = new ApprovalManager();
    const noticeRef: { notice?: ApprovalNotice } = {};
    const tool = new ExitPlanModeTool(store, manager);
    tool.setNotify((n) => {
      noticeRef.notice = n;
    });

    let exited = false;
    tool.setExitCallback(() => {
      exited = true;
    });

    const out = await runWithResolve(tool, manager, noticeRef, (taskId, mgr) => {
      mgr.resolveApproval(taskId, false, "计划不完整");
    });

    expect(out).toContain("🚫 审批被拒绝");
    expect(out).toContain("继续处于 Plan Mode");
    expect(exited).toBe(false);
  });

  it("modify:写回 PLAN.md → 调 onExit(携带新内容)", async () => {
    await store.writePlan("# 原计划");
    const manager = new ApprovalManager();
    const noticeRef: { notice?: ApprovalNotice } = {};
    const tool = new ExitPlanModeTool(store, manager);
    tool.setNotify((n) => {
      noticeRef.notice = n;
    });

    let exited = false;
    let approvedPlan: string | undefined;
    tool.setExitCallback((plan) => {
      exited = true;
      approvedPlan = plan;
    });

    const out = await runWithResolve(tool, manager, noticeRef, (taskId, mgr) => {
      mgr.resolveApprovalWithModify(taskId, "修改后通过", "# 修订后的计划\n更多步骤");
    });

    expect(out).toContain("✏️ plan 已修改");
    expect(out).toContain("已写回 PLAN.md");
    expect(exited).toBe(true);
    expect(approvedPlan).toBe("# 修订后的计划\n更多步骤");

    // PLAN.md 被覆写为新内容
    const written = await readFile(join(workDir, "PLAN.md"), "utf8");
    expect(written).toContain("修订后的计划");
  });

  it("未注入 onExit 时 approve 返回提示但流程完成", async () => {
    await store.writePlan("# 计划");
    const manager = new ApprovalManager();
    const noticeRef: { notice?: ApprovalNotice } = {};
    const tool = new ExitPlanModeTool(store, manager);
    tool.setNotify((n) => {
      noticeRef.notice = n;
    });
    // 故意不调 setExitCallback

    const out = await runWithResolve(tool, manager, noticeRef, (taskId, mgr) => {
      mgr.resolveApproval(taskId, true, "已批准");
    });

    expect(out).toContain("未配置退出回调");
  });

  describe("经 ToolRegistry execute", () => {
    it("通过 registry 注册并执行(无 plan → 提示)", async () => {
      const registry = new ToolRegistry();
      registry.register(new ExitPlanModeTool(store, new ApprovalManager()));

      const names = registry.getAvailableTools().map((t) => t.name);
      expect(names).toContain("exit_plan_mode");
      expect(registry.isReadOnlyTool("exit_plan_mode")).toBe(false);

      const result = await registry.execute({
        id: "call_1",
        name: "exit_plan_mode",
        arguments: "{}",
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("没有 PLAN.md");
    });

    it("registry 可经 getTool 取到实例并注入回调", async () => {
      const manager = new ApprovalManager();
      const registry = new ToolRegistry();
      registry.register(new ExitPlanModeTool(store, manager));
      await store.writePlan("# 计划");

      const instance = registry.getTool("exit_plan_mode");
      expect(instance).toBeInstanceOf(ExitPlanModeTool);
    });
  });
});
