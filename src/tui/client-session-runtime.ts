import { randomUUID } from "node:crypto";
import type {
  RuntimeMethod,
  RuntimeNotification,
  RuntimeNotificationMap,
  RuntimeParams,
  RuntimeResult,
} from "@pico/protocol";
import type { ApprovalNotice } from "../approval/manager.js";
import type { PlanApprovalControl } from "./approval-dialogs.js";
import { DaemonEventReporter } from "./daemon-event-reporter.js";
import { transcriptEventsFromRuntimeItems } from "./transcript-item-hydration.js";
import type { TuiReporter } from "./tui-reporter.js";

/**
 * TUI 客户端会话核心（3-D Phase 2，无 Ink——集成测试用 fake client 驱动）。
 *
 * 组合 LocalRuntimeClient（kernel 模式，connectOrSpawn 拉起/连上常驻 daemon）+
 * DaemonEventReporter（通知→TuiReporter）。发送走 session.send（daemon 侧决策
 * started/steered/queued）；run.live 增量经适配器直投 TuiReporter；终态由
 * session.transcriptUpdated{reload} 触发 transcript 重取对账。审批经
 * approval.requested 事件 + approval.respond / plan.respond RPC。
 *
 * v1 边界：斜杠命令本地拦截提示（Phase 3 RPC 化）；session.send 为非幂等
 * P1-2 类写——传输级失败不自动重发（idempotencyKey 供手动重试）。
 */

export interface DaemonSessionClient {
  connect?(): Promise<void>;
  request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>>;
  subscribe(
    params: RuntimeParams<"events.subscribe">,
    listener: (notification: RuntimeNotification) => void,
  ): Promise<{
    replay: RuntimeResult<"events.subscribe">;
    dispose(): void;
  }>;
}

export interface ClientSessionRuntimeOptions {
  readonly client: DaemonSessionClient;
  readonly workspacePath: string;
  readonly sessionId?: string;
  readonly reporter: TuiReporter;
  /** 审批请求到达（notice 已从 wire request 映射；对话框由宿主开）。 */
  readonly onApproval?: (notice: ApprovalNotice) => void;
  /** 审批被解析（含对端/超时解析）——宿主清理残留对话框。 */
  readonly onApprovalResolved?: (approvalId: string) => void;
  readonly onRunStateChanged?: (running: boolean) => void;
  /**
   * BYOK 旗标合并（Phase 3 首批）：--model 经 config.effective.get 解析为
   * modelRouteId（路由 id `provider/model` 或裸模型名），sessionId 确立后经
   * session.settings.update 应用一次；解析失败提示指引并放弃（不阻断）。
   */
  readonly modelOverride?: string;
  readonly thinkingOverride?: string;
}

export class ClientSessionRuntime {
  private readonly client: DaemonSessionClient;
  private readonly workspacePath: string;
  private readonly reporter: TuiReporter;
  private readonly onApproval: ClientSessionRuntimeOptions["onApproval"];
  private readonly eventReporter: DaemonEventReporter;
  private subscription: { dispose(): void } | undefined;
  private sessionId: string | undefined;
  private hydrating = false;
  private hydrateAgain = false;
  private disposed = false;
  private pendingModelRouteId: string | undefined;
  private settingsOverrideApplied = false;

  constructor(private readonly options: ClientSessionRuntimeOptions) {
    this.client = options.client;
    this.workspacePath = options.workspacePath;
    this.reporter = options.reporter;
    this.onApproval = options.onApproval;
    this.sessionId = options.sessionId;
    this.eventReporter = new DaemonEventReporter({
      reporter: this.reporter,
      onApprovalRequested: (payload) => this.handleApprovalRequested(payload),
      onRunStateChanged: options.onRunStateChanged,
    });
  }

  get activeSessionId(): string | undefined {
    return this.sessionId;
  }

  get running(): boolean {
    return this.eventReporter.running;
  }

  async start(): Promise<void> {
    await this.client.connect?.();
    await this.resolveModelOverride();
    if (this.sessionId) {
      await this.hydrate();
      await this.applyStartupOverrides();
    }
    const subscription = await this.client.subscribe(
      { workspacePath: this.workspacePath },
      (notification) => this.handleNotification(notification),
    );
    this.subscription = subscription;
    for (const event of subscription.replay.events) {
      this.handleNotification(event);
    }
  }

  /** 发送用户文本。返回 false = 本地拦截（斜杠命令 v1 不支持），未上送。 */
  async sendText(text: string): Promise<boolean> {
    if (text.trim().startsWith("/")) {
      this.reporter.pushSystemMessage(
        "客户端模式暂不支持斜杠命令（3-D Phase 3 将 RPC 化）。当前请直接输入文本。",
      );
      return false;
    }
    this.reporter.pushUserMessage(text);
    try {
      const result = await this.client.request("session.send", {
        workspacePath: this.workspacePath,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        input: { kind: "text", text },
        behavior: "auto",
        idempotencyKey: randomUUID(),
      });
      if (this.sessionId === undefined) {
        this.sessionId = result.session.sessionId;
        await this.applyStartupOverrides();
      }
      return true;
    } catch (error) {
      this.reporter.pushError(error instanceof Error ? error.message : String(error), {
        retryable: true,
        action: "session.send",
      });
      return false;
    }
  }

  /** 中断当前活跃 run（run.started 事件跟踪的 runId；无 run 时静默）。 */
  async interrupt(): Promise<void> {
    const runId = this.eventReporter.activeRunId;
    if (!runId) return;
    try {
      await this.client.request("run.cancel", {
        workspacePath: this.workspacePath,
        runId,
      });
    } catch (error) {
      this.reporter.pushError(error instanceof Error ? error.message : String(error), {
        retryable: true,
        action: "run.cancel",
      });
    }
  }

  /** 面板普通审批动作 → approval.respond RPC（注入给 approval-dialogs）。 */
  readonly resolvePlain = async (
    action: "approve" | "approve-session" | "reject",
    taskId: string,
  ): Promise<boolean> => {
    try {
      await this.client.request("approval.respond", {
        workspacePath: this.workspacePath,
        approvalId: taskId,
        decision:
          action === "approve" ? "allow_once" : action === "approve-session" ? "allow_session" : "deny",
      });
      return true;
    } catch {
      return false;
    }
  };

  /** plan 类审批控制（approval-dialogs 的 PlanApprovalControl → plan.respond RPC）。 */
  createPlanControl(): PlanApprovalControl {
    return {
      respond: async (input) =>
        this.client.request("plan.respond", {
          workspacePath: this.workspacePath,
          sessionId: input.sessionId,
          planId: input.planId,
          action: input.action,
          expectedRevision: input.expectedRevision,
          expectedSessionSequence: input.expectedSessionSequence,
          operationId: input.operationId,
          ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
        }),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.subscription?.dispose();
    this.subscription = undefined;
  }

  private handleNotification(notification: RuntimeNotification): void {
    if (this.disposed) return;
    // 会话 scope 过滤：订阅是工作区级的，同工作区其他会话（wake/cron/另一
    // 客户端）的 run/live/审批事件不得流入本会话投影；sessionId 未知时（新会话
    // 首事件先于 send 返回）仍放行，由下方 transcriptUpdated 采纳。
    const scopedSessionId = notification.scope.sessionId;
    if (
      scopedSessionId !== undefined &&
      this.sessionId !== undefined &&
      scopedSessionId !== this.sessionId
    ) {
      return;
    }
    if (notification.topic === "approval.resolved") {
      const payload = notification.payload as RuntimeNotificationMap["approval.resolved"];
      this.options.onApprovalResolved?.(payload.approvalId);
    }
    if (
      notification.topic === "session.transcriptUpdated" &&
      (notification.payload as RuntimeNotificationMap["session.transcriptUpdated"]).operation ===
        "reload"
    ) {
      // 新会话首条事件可能先于 session.send 返回到达：从事件 scope 采纳 sessionId。
      if (this.sessionId === undefined && notification.scope.sessionId) {
        this.sessionId = notification.scope.sessionId;
        void this.applyStartupOverrides();
      }
      const scoped = notification.scope.sessionId;
      if (!this.sessionId || scoped === this.sessionId) void this.scheduleHydrate();
    }
    this.eventReporter.handleNotification(notification);
  }

  /**
   * 切换会话（/resume /fork /new 后）：订阅不动（工作区级），重定向水化目标
   * 并清空上一会话的瞬时 run 跟踪。BYOK 启动覆盖不重放（startup-only 语义）。
   */
  async switchSession(sessionId: string | undefined): Promise<void> {
    this.sessionId = sessionId;
    this.eventReporter.clearTransientState();
    if (sessionId) {
      await this.hydrate().catch((error: unknown) => {
        this.reporter.pushError(error instanceof Error ? error.message : String(error), {
          retryable: true,
          action: "session.transcript",
        });
      });
    }
  }

  private async scheduleHydrate(): Promise<void> {
    if (!this.sessionId) return;
    if (this.hydrating) {
      this.hydrateAgain = true;
      return;
    }
    this.hydrating = true;
    try {
      await this.hydrate();
    } catch (error) {
      // 对账是尽力而为：失败留给下一次 reload 重试，不得变成 unhandled rejection。
      this.reporter.pushError(error instanceof Error ? error.message : String(error), {
        retryable: true,
        action: "session.transcript",
      });
    } finally {
      this.hydrating = false;
      if (this.hydrateAgain) {
        this.hydrateAgain = false;
        void this.scheduleHydrate();
      }
    }
  }

  private async hydrate(): Promise<void> {
    if (!this.sessionId) return;
    const page = await this.client.request("session.transcript", {
      workspacePath: this.workspacePath,
      sessionId: this.sessionId,
      limit: 200,
    });
    this.reporter.replaceTranscriptEvents(
      transcriptEventsFromRuntimeItems(page.items, this.sessionId),
    );
  }

  /** --model → modelRouteId（config.effective.get 枚举路由；约定 id 为 `provider/model`）。 */
  private async resolveModelOverride(): Promise<void> {
    const override = this.options.modelOverride;
    if (!override) return;
    try {
      const config = await this.client.request("config.effective.get", {
        workspacePath: this.workspacePath,
      });
      const defaultRoute =
        typeof config.defaultModelRouteId === "string" ? config.defaultModelRouteId : undefined;
      if (override === defaultRoute) {
        this.pendingModelRouteId = override;
        return;
      }
      const providers = Array.isArray(config.providers) ? config.providers : [];
      for (const provider of providers) {
        const record = provider as Record<string, unknown>;
        const providerId = typeof record["id"] === "string" ? record["id"] : undefined;
        const models = Array.isArray(record["models"]) ? record["models"] : [];
        if (!providerId) continue;
        for (const model of models) {
          if (typeof model !== "string") continue;
          if (override === `${providerId}/${model}` || override === model) {
            this.pendingModelRouteId = `${providerId}/${model}`;
            return;
          }
        }
      }
      this.reporter.pushError(
        `--model ${override} 未匹配任何已配置路由（config.effective.get）。请在 daemon 配置（.pico/config.json 或 LLM_* env）中配置后重试，或去掉 --model 使用默认路由。`,
        { retryable: false, action: "--model" },
      );
    } catch (error) {
      this.reporter.pushError(
        `解析 --model 失败：${error instanceof Error ? error.message : String(error)}（本次忽略覆盖）`,
        { retryable: true, action: "config.effective.get" },
      );
    }
  }

  /** sessionId 确立后应用一次 BYOK 覆盖（modelRouteId/thinkingEffort → session.settings.update）。 */
  private async applyStartupOverrides(): Promise<void> {
    if (this.settingsOverrideApplied || this.disposed) return;
    const routeId = this.pendingModelRouteId;
    const thinking = this.options.thinkingOverride;
    if (!routeId && !thinking) return;
    if (!this.sessionId) return;
    this.settingsOverrideApplied = true;
    try {
      await this.client.request("session.settings.update", {
        workspacePath: this.workspacePath,
        sessionId: this.sessionId,
        ...(routeId ? { modelRouteId: routeId } : {}),
        ...(thinking ? { thinkingEffort: thinking } : {}),
      });
      this.reporter.pushSystemMessage(
        `客户端覆盖已应用：${[routeId ? `模型路由 ${routeId}` : undefined, thinking ? `思考强度 ${thinking}` : undefined].filter(Boolean).join("，")}。`,
      );
    } catch (error) {
      this.reporter.pushError(
        `应用启动覆盖失败：${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, action: "session.settings.update" },
      );
    }
  }

  private handleApprovalRequested(
    payload: RuntimeNotificationMap["approval.requested"],
  ): void {
    const request = payload.request as Record<string, unknown>;
    // plan 类审批（kind:"plan"）：wire 携带 planId/expectedRevision/
    // expectedSessionSequence——approval-dialogs 的 resolvePlanApprovalAction
    // 按这些元数据走 plan.respond（Desktop renderer 同款读取方式）。
    const isPlan = request["kind"] === "plan";
    const notice = {
      taskId: payload.approvalId,
      toolName: typeof request["toolName"] === "string" ? request["toolName"] : "",
      args: typeof request["args"] === "string" ? request["args"] : "",
      // wire 无 providerCallId（Phase 3 协议补齐）：onToolAwaitingApproval 的精确
      // 工具卡匹配暂缺，对话框经 taskId 独立工作。
      providerCallId: "",
      message:
        typeof request["title"] === "string"
          ? request["title"]
          : typeof request["detail"] === "string"
            ? (request["detail"] as string)
            : "daemon 请求审批",
      ...(isPlan
        ? {
            planId: typeof request["planId"] === "string" ? request["planId"] : payload.approvalId,
            expectedRevision:
              typeof request["expectedRevision"] === "number" ? request["expectedRevision"] : 0,
            expectedSessionSequence:
              typeof request["expectedSessionSequence"] === "number"
                ? request["expectedSessionSequence"]
                : 0,
          }
        : {}),
    };
    this.onApproval?.(notice);
  }
}
