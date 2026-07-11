// ExitPlanModeTool:退出 Plan Mode 的审批网关。
//
// 对应 ROADMAP 3.6 Plan Review 审批。把"退出 Plan Mode"做成一个普通工具,
// 走 registry.execute → 自动挂审批 middleware,天然契合"触发审批流"。
// 参考 SkillViewTool / TodoTool 的跨文件工具模式:独立文件实现 BaseTool。
//
// 流程:
//   1. 模型在 Plan Mode 规划完毕后调用 exit_plan_mode
//   2. 工具读 PLAN.md 当前内容 → 调 globalApprovalManager.waitForApproval 提交审批
//   3. 用户 approve / reject / modify:
//      - approve:调 onExit 回调通知 engine 退出 Plan Mode
//      - reject:保持 Plan Mode
//      - modify:写回修改后的 PLAN.md → 调 onExit 退出
//   4. 返回中文结果给模型
//
// 解耦:工具不直接操作 engine.planMode(私有状态),而是持有由 host(run-agent.ts)
// 注入的 onExit 回调。default-registry 构造时回调为空,host 构造 engine 后调
// setExitCallback 注入,使工具与 engine 彻底解耦。

import { randomUUID } from "node:crypto";
import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import { PlanStore } from "../context/plan-store.js";
import {
  ApprovalManager,
  globalApprovalManager,
  type ApprovalNotice,
} from "../approval/manager.js";

/**
 * 退出 Plan Mode 时由 host 注入的回���。
 *
 * approvedPlan 在 modify 场景下携带写回后的最终 plan 内容,供 host/监听者使用;
 * approve 场景为 undefined(原 PLAN.md 不变)。
 */
export type PlanExitCallback = (approvedPlan?: string) => void;

export class ExitPlanModeTool implements BaseTool {
  /** 非只读:审批通过会切换 engine 的 planMode 状态(状态变更) */
  readonly readOnly = false;
  /** modify 分支最多写回唯一的 PLAN.md。 */
  readonly fileSideEffects = { kind: "exact", paths: ["PLAN.md"] } as const;

  /** host 注入的退出回调,注入前为空(审批通过也无处可退,工具返回提示) */
  private onExit?: PlanExitCallback;

  /**
   * 审批通知回调:host 注入后,审批请求会通过它展示给用户(终端打印/飞书发卡)。
   * 默认终端打印。测试可不注入。
   */
  private notify: (notice: ApprovalNotice) => void = defaultTerminalNotify;

  /** host 注入的本轮中止信号,用于取消内部审批等待。 */
  private abortSignal: AbortSignal | undefined;

  constructor(
    private readonly store: PlanStore,
    /** 审批管理器,默认用全局单例;测试时可注入隔离实例 */
    private readonly approval: ApprovalManager = globalApprovalManager,
  ) {}

  /** host(run-agent.ts)构造 engine 后注入退出回调 */
  setExitCallback(cb: PlanExitCallback): void {
    this.onExit = cb;
  }

  /** host 注入审批通知回调(终端/飞书卡片) */
  setNotify(notify: (notice: ApprovalNotice) => void): void {
    this.notify = notify;
  }

  /** host(run-agent.ts)注入本轮运行的中止信号 */
  setAbortSignal(signal: AbortSignal | undefined): void {
    this.abortSignal = signal;
  }

  name(): string {
    return "exit_plan_mode";
  }

  definition(): ToolDefinition {
    return {
      name: "exit_plan_mode",
      description:
        "退出 Plan Mode,提交当前 PLAN.md 给用户审批。用户可选 approve(通过并退出 Plan Mode)/ reject(拒绝,继续 Plan Mode)/ modify(修改 plan 后通过)。无参数,提交前请确保 PLAN.md 已写好完整计划。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };
  }

  /**
   * 状态变更工具,与同批次任何工具均冲突 → 保守声明 all,退化为串行执行。
   */
  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.all();
  }

  async execute(args: string): Promise<string> {
    // 参数无业务用途,但延迟解析以防模型误传;非法 JSON 直接忽略(无参工具容错)
    if (args.trim() !== "") {
      try {
        JSON.parse(args);
      } catch {
        // 无参工具:忽略畸形参数,不阻断退出流程
      }
    }

    // 1. 读取当前 PLAN.md
    const plan = await this.store.readPlan();
    if (plan === null) {
      return "⚠ 当前没有 PLAN.md,无 plan 可提交审批。请先用 write_file 写好 PLAN.md,再调用 exit_plan_mode。";
    }

    // 2. 提交审批:plan 内容作为 diff 展示给用户(用户据此决定 approve/reject/modify)
    const taskId = `exit_plan_${Date.now().toString(36)}_${randomUUID()}`;
    const result = await this.approval.waitForApproval(
      taskId,
      "exit_plan_mode",
      "退出 Plan Mode",
      this.notify,
      plan,
      this.abortSignal,
    );
    this.abortSignal?.throwIfAborted();

    // 3. 分支处理
    if (!result.allowed) {
      // reject:保持 Plan Mode,提示模型继续规划
      return `🚫 审批被拒绝:${result.reason}\n继续处于 Plan Mode。请根据反馈修订 PLAN.md 后重新提交。`;
    }

    // modify:把用户修改后的内容写回 PLAN.md
    if (result.modifiedContent !== undefined) {
      this.abortSignal?.throwIfAborted();
      await this.store.writePlan(result.modifiedContent);
      this.abortSignal?.throwIfAborted();
      if (this.onExit) {
        this.onExit(result.modifiedContent);
      }
      return "✏️ plan 已修改并通过审批,已写回 PLAN.md,已退出 Plan Mode。现在可以开始执行计划了。";
    }

    // approve:回调通知 engine 退出 Plan Mode
    this.abortSignal?.throwIfAborted();
    if (this.onExit) {
      this.onExit();
      return "✅ 审批通过,已退出 Plan Mode。现在可以开始执行计划了。";
    }

    // 回调未注入:host 未接通,提示用户但已完成审批
    return "✅ 审批通过,但未配置退出回调(无法自动退出 Plan Mode)。";
  }
}

/** 默认终端通知:打印 plan 审批请求与内容,提示用户 approve/reject/modify 口令 */
function defaultTerminalNotify(notice: ApprovalNotice): void {
  console.warn(`\n\x1b[35m[Plan 审批 TaskID: ${notice.taskId}]\x1b[0m ${notice.message}`);
  if (notice.diff) {
    console.warn(`\x1b[33m${notice.diff}\x1b[0m`);
  }
  console.warn(
    `\x1b[2m回复:approve ${notice.taskId} 通过 / reject ${notice.taskId} 拒绝 / modify ${notice.taskId} <新plan内容> 修改后通过\x1b[0m\n`,
  );
}
