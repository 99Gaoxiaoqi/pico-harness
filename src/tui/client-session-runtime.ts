import { randomUUID } from "node:crypto";
import {
  isActiveRunStatus,
  parseApprovalRequestedPayload,
  type RuntimeMethod,
  type RuntimeInputAttachment,
  type RuntimeNotification,
  type RuntimeNotificationMap,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeConversationItem,
  type RuntimeUserInput,
} from "@pico/protocol";
import type { ApprovalNotice } from "../approval/manager.js";
import type { AskUserOption } from "../tools/ask-user.js";
import type { PlanApprovalControl } from "./approval-dialogs.js";
import { DaemonEventReporter } from "./daemon-event-reporter.js";
import { transcriptEventsFromRuntimeItems } from "./transcript-item-hydration.js";
import type { TuiReporter } from "./tui-reporter.js";
import type { RuntimeTranscriptCursor } from "../../packages/protocol/src/runtime.js";

/**
 * 客户端侧 ask-user 请求（wire prompt 的结构化投影——AskUserRequest 的
 * 纯数据子集，requestId 复用 wire promptId）。
 */
export interface ClientPromptRequest {
  readonly requestId: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly AskUserOption[];
  readonly freeText?: boolean;
}

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
  /** ask-user 问题到达（已从 wire prompt 映射为 AskUserRequest 形状；宿主开对话框）。 */
  readonly onPrompt?: (request: ClientPromptRequest) => void;
  /** 问题被解析（含对端取消/answered）——宿主清理残留对话框。 */
  readonly onPromptResolved?: (promptId: string) => void;
  readonly onRunStateChanged?: (running: boolean) => void;
  /** 会话设置快照（启动/切换/settingsUpdated 后推送——宿主喂状态栏）。 */
  readonly onSettingsSnapshot?: (
    settings: Partial<
      Record<
        | "modelRouteId"
        | "thinkingEffort"
        | "collaborationMode"
        | "permissionMode"
        | "orchestrationMode",
        string
      >
    >,
  ) => void;
  /**
   * BYOK 旗标合并（Phase 3 首批）：--model 经 config.effective.get 解析为
   * modelRouteId（路由 id `provider/model` 或裸模型名），sessionId 确立后经
   * session.settings.update 应用一次；解析失败提示指引并放弃（不阻断）。
   */
  readonly modelOverride?: string;
  readonly thinkingOverride?: string;
  /** --graph 启动覆盖（Phase 4）：sessionId 确立后 orchestrationMode=graph 一次。 */
  readonly orchestrationModeOverride?: "graph";
}

export interface RuntimeTranscriptPagingState {
  readonly items: readonly RuntimeConversationItem[];
  readonly revision?: string;
  readonly nextCursor?: RuntimeTranscriptCursor;
  readonly nextBefore?: string;
}

type RuntimeTranscriptPage = RuntimeResult<"session.transcript"> & {
  readonly nextCursor?: RuntimeTranscriptCursor;
};

/** Pure page reducer shared by TUI hydration tests and the request loop below. */
export function advanceRuntimeTranscriptPagingState(
  state: RuntimeTranscriptPagingState,
  page: RuntimeTranscriptPage,
): RuntimeTranscriptPagingState {
  if (state.revision !== undefined && page.revision !== state.revision) {
    throw new Error(
      `Session transcript revision changed during hydration (${state.revision} -> ${page.revision})`,
    );
  }
  if (page.nextCursor && page.nextCursor.revision !== page.revision) {
    throw new Error("Session transcript cursor revision does not match its page");
  }
  if (
    state.nextCursor &&
    page.nextCursor &&
    state.nextCursor.throughTranscriptSequence !== page.nextCursor.throughTranscriptSequence
  ) {
    throw new Error("Session transcript high-watermark changed during hydration");
  }

  const known = new Set(state.items.map((item) => item.id));
  const older = page.items.filter((item) => !known.has(item.id));
  return {
    items: [...older, ...state.items],
    revision: state.revision ?? page.revision,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(!page.nextCursor && page.nextBefore ? { nextBefore: page.nextBefore } : {}),
  };
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
  private hydrateChain: Promise<void> | undefined;
  private disposed = false;
  private pendingModelRouteId: string | undefined;
  private settingsOverrideApplied = false;
  private settingsOverrideInFlight = false;

  constructor(private readonly options: ClientSessionRuntimeOptions) {
    this.client = options.client;
    this.workspacePath = options.workspacePath;
    this.reporter = options.reporter;
    this.onApproval = options.onApproval;
    this.sessionId = options.sessionId;
    this.eventReporter = new DaemonEventReporter({
      reporter: this.reporter,
      onApprovalRequested: (payload) => this.handleApprovalRequested(payload),
      onPromptRequested: (payload) => this.handlePromptRequested(payload),
      onRunStateChanged: (running) => {
        // 回合终态重试启动覆盖（真机实测逮到的竞态）：sendText 返回后 run 注册
        // 存在窗口，update 的 idle 校验间歇 CONFLICT；回合结束=必然 idle，是
        // 覆盖应用的最可靠触发点（applied 单次闩防重复）。
        if (!running) void this.applyStartupOverrides();
        this.options.onRunStateChanged?.(running);
      },
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

  /** 发送用户文本。behavior 供 /steer /queue /replace 映射；attachments 为
   * 图片附件（3-D 漏账补齐：仅 idle 发送，running 态由宿主本地拒绝）。 */
  async sendText(
    text: string,
    behavior: "auto" | "steer" | "queue" | "replace" = "auto",
    attachments?: readonly RuntimeInputAttachment[],
  ): Promise<boolean> {
    // 斜杠分派归 processClientInput（对抗评审 P2：核心层不再自带命令语法知识，
    // 且 process-user-input 保证 prompt 永不以 "/" 开头，此守卫本就不可达）。
    return this.sendInput(
      {
        kind: "text",
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
      behavior,
    );
  }

  /** 按 RuntimeUserInput 类型上送（text/skill/agent）；idempotencyKey 每次新生成。 */
  async sendInput(
    input: RuntimeUserInput,
    behavior: "auto" | "steer" | "queue" | "replace" = "auto",
  ): Promise<boolean> {
    if (input.kind === "text") this.reporter.pushUserMessage(input.text);
    try {
      const result = await this.client.request("session.send", {
        workspacePath: this.workspacePath,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        input,
        behavior,
        idempotencyKey: randomUUID(),
      });
      if (this.sessionId === undefined) {
        this.sessionId = result.session.sessionId;
        await this.applyStartupOverrides();
      } else {
        // BYOK 覆盖若曾失败（applied 尚未置位），此后每次成功发送都是廉价重试
        // 触发点（对抗评审二轮 P1：否则 -S 启动失败一次即永久丢失 --model）。
        void this.applyStartupOverrides();
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

  /** RPC 透传（客户端命令注册表的查询/设置类命令使用）。 */
  request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>> {
    return this.client.request(method, params);
  }

  /** 清空本地投影（/new）。 */
  clearTranscript(): void {
    this.reporter.clear();
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
          action === "approve"
            ? "allow_once"
            : action === "approve-session"
              ? "allow_session"
              : "deny",
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
    // 审批解析（含外会话/超时解析）先行清理残留对话框：不受 scope 过滤影响
    // （对抗评审 P1——过滤在先会让跨会话采纳窗口打开的对话框永远悬空）。
    // prompt 解析同款前置（对端回答/取消后本端对话框必须收口）。
    if (notification.topic === "approval.resolved") {
      const payload = notification.payload as RuntimeNotificationMap["approval.resolved"];
      this.options.onApprovalResolved?.(payload.approvalId);
    }
    if (notification.topic === "prompt.resolved") {
      const payload = notification.payload as RuntimeNotificationMap["prompt.resolved"];
      this.options.onPromptResolved?.(payload.promptId);
    }
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
    if (
      notification.topic === "session.transcriptUpdated" &&
      (notification.payload as RuntimeNotificationMap["session.transcriptUpdated"]).operation ===
        "reload"
    ) {
      // 新会话首条事件可能先于 session.send 返回到达：从事件 scope 采纳 sessionId。
      if (this.sessionId === undefined && notification.scope.sessionId) {
        this.sessionId = notification.scope.sessionId;
        void this.applyStartupOverrides();
        void this.refreshSettingsSnapshot();
      }
      const scoped = notification.scope.sessionId;
      if (!this.sessionId || scoped === this.sessionId) void this.hydrateSerial();
    }
    if (notification.topic === "session.settingsUpdated") {
      void this.refreshSettingsSnapshot();
    }
    this.eventReporter.handleNotification(notification);
  }

  /**
   * 切换会话（/resume /fork /new 后）：订阅不动（工作区级），重定向水化目标
   * 并清空上一会话的瞬时 run 跟踪（水化会按 transcript.activeRun 恢复运行态）。
   * BYOK 启动覆盖不重放（startup-only 语义）。
   */
  async switchSession(sessionId: string | undefined): Promise<void> {
    this.sessionId = sessionId;
    this.eventReporter.clearTransientState();
    if (sessionId) {
      // 与 reload 对账共用串行化（对抗评审 P2：直连 hydrate 会与在途 reload
      // 竞态出乱序替换）。
      await this.hydrateSerial();
      await this.refreshSettingsSnapshot();
    }
  }

  /** 串行水化：in-flight 防重入 + 尾随合并（reload 对账与切换共用），返回本次完成。 */
  private hydrateSerial(): Promise<void> {
    if (!this.sessionId) return Promise.resolve();
    if (this.hydrating) {
      this.hydrateAgain = true;
      return this.hydrateChain ?? Promise.resolve();
    }
    this.hydrating = true;
    const run = (async () => {
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
          await this.hydrateSerial();
        }
      }
    })();
    this.hydrateChain = run;
    return run;
  }

  private async hydrate(): Promise<void> {
    if (!this.sessionId) return;
    // 跨切换竞态防护（对抗评审二轮 P1）：捕获发起时的 sessionId，响应落地时
    // 若已切换（/new 清空或 /resume 换目标）则丢弃——陈旧页不得复活旧 transcript
    // 或重亮已死的 run。
    const sessionId = this.sessionId;
    let state: RuntimeTranscriptPagingState = { items: [] };
    let page = await this.client.request("session.transcript", {
      workspacePath: this.workspacePath,
      sessionId,
      limit: 200,
    });
    const activeRun = page.activeRun as { runId?: unknown; status?: unknown } | undefined;
    const seenBoundaries = new Set<string>();
    while (true) {
      state = advanceRuntimeTranscriptPagingState(state, page);
      const boundary = state.nextCursor ?? state.nextBefore;
      if (!boundary) break;
      const boundaryKey =
        typeof boundary === "string" ? `legacy:${boundary}` : `cursor:${JSON.stringify(boundary)}`;
      if (seenBoundaries.has(boundaryKey)) {
        throw new Error("Session transcript pagination cursor did not advance");
      }
      seenBoundaries.add(boundaryKey);
      page = await this.client.request("session.transcript", {
        workspacePath: this.workspacePath,
        sessionId,
        ...(state.nextCursor
          ? { cursor: state.nextCursor }
          : { before: state.nextBefore, expectedRevision: state.revision }),
        limit: 200,
      });
    }
    if (this.sessionId !== sessionId) return;
    this.reporter.replaceTranscriptEvents(transcriptEventsFromRuntimeItems(state.items, sessionId));
    // 恢复活跃 run 相位（对抗评审 P1：/resume 进运行中会话须点亮 running、
    // /interrupt 才有目标）——双向对账：无活跃 run 时清掉误亮的相位。活跃口径
    // 经 isActiveRunStatus（水化对账口径，含 paused/cancelling）。
    const activeRunLive =
      activeRun !== undefined &&
      typeof activeRun.runId === "string" &&
      isActiveRunStatus(typeof activeRun.status === "string" ? activeRun.status : "");
    if (activeRunLive && typeof activeRun.runId === "string") {
      this.eventReporter.seedActiveRun(activeRun.runId);
    } else if (this.eventReporter.running) {
      // transcript 已无活跃 run：终态事件早于本次水化到达时按权威快照收口。
      this.eventReporter.clearTransientState();
      this.options.onRunStateChanged?.(false);
    }
  }

  /** 拉取会话设置并推送快照（启动/切换/settingsUpdated 后调用）。 */
  private async refreshSettingsSnapshot(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const { settings } = await this.client.request("session.settings.get", {
        workspacePath: this.workspacePath,
        sessionId: this.sessionId,
      });
      this.options.onSettingsSnapshot?.({
        ...(typeof settings.modelRouteId === "string"
          ? { modelRouteId: settings.modelRouteId }
          : {}),
        ...(typeof settings.thinkingEffort === "string"
          ? { thinkingEffort: settings.thinkingEffort }
          : {}),
        ...(typeof settings.collaborationMode === "string"
          ? { collaborationMode: settings.collaborationMode }
          : {}),
        ...(typeof settings.permissionMode === "string"
          ? { permissionMode: settings.permissionMode }
          : {}),
        ...(typeof settings.orchestrationMode === "string"
          ? { orchestrationMode: settings.orchestrationMode }
          : {}),
      });
    } catch {
      // 设置快照尽力而为：失败不影响主流程，下一次事件再补。
    }
  }

  /** --model → modelRouteId（config.effective.get 枚举路由；约定 id 为 `provider/model`）。 */
  private async resolveModelOverride(): Promise<void> {
    const override = this.options.modelOverride;
    if (!override) return;
    try {
      // wire 形状：result.config 才是 RuntimeEffectiveConfig（对抗评审 P0 修复）。
      const { config } = await this.client.request("config.effective.get", {
        workspacePath: this.workspacePath,
      });
      if (override === config.defaultModelRouteId) {
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

  /** sessionId 确立后应用一次 BYOK 覆盖（modelRouteId/thinkingEffort/orchestrationMode → session.settings.update）。 */
  private async applyStartupOverrides(): Promise<void> {
    if (this.settingsOverrideApplied || this.settingsOverrideInFlight || this.disposed) return;
    const routeId = this.pendingModelRouteId;
    const thinking = this.options.thinkingOverride;
    const graph = this.options.orchestrationModeOverride;
    if (!routeId && !thinking && !graph) return;
    if (!this.sessionId) return;
    // in-flight 同步置位防并发双发；applied 只在成功后置（对抗评审 P2：失败
    // 前置会让一次瞬时错误永久吞掉 --model），失败留给下一入口自然重试。
    this.settingsOverrideInFlight = true;
    try {
      await this.client.request("session.settings.update", {
        workspacePath: this.workspacePath,
        sessionId: this.sessionId,
        ...(routeId ? { modelRouteId: routeId } : {}),
        ...(thinking ? { thinkingEffort: thinking } : {}),
        ...(graph ? { orchestrationMode: graph } : {}),
      });
      this.settingsOverrideApplied = true;
      this.reporter.pushSystemMessage(
        `客户端覆盖已应用：${[routeId ? `模型路由 ${routeId}` : undefined, thinking ? `思考强度 ${thinking}` : undefined, graph ? "Graph Mode" : undefined].filter(Boolean).join("，")}。`,
      );
    } catch (error) {
      this.reporter.pushError(
        `应用启动覆盖失败：${error instanceof Error ? error.message : String(error)}（将在下次触发点重试）`,
        { retryable: true, action: "session.settings.update" },
      );
    } finally {
      this.settingsOverrideInFlight = false;
    }
  }

  private handleApprovalRequested(payload: RuntimeNotificationMap["approval.requested"]): void {
    // wire 语义读取经 @pico/protocol parseApprovalRequestedPayload（与 Desktop
    // renderer 同源：planId 不回退 approvalId 的兜底语义一处收口）。
    const approval = parseApprovalRequestedPayload(payload);
    if (!approval) return;
    const notice = {
      taskId: approval.approvalId,
      toolName: approval.toolName ?? "",
      args: approval.args ?? "",
      providerCallId: approval.providerCallId ?? "",
      message: approval.title ?? approval.detail ?? "daemon 请求审批",
      ...(approval.diff ? { diff: approval.diff } : {}),
      ...(approval.sessionScope ? { sessionScope: approval.sessionScope } : {}),
      ...(approval.kind === "plan"
        ? {
            planId: approval.planId,
            expectedRevision: approval.expectedRevision ?? 0,
            expectedSessionSequence: approval.expectedSessionSequence ?? 0,
          }
        : {}),
    };
    this.onApproval?.(notice);
  }

  /** ask-user 对话框动作 → prompt.respond RPC（幂等键新生成；answer=optionId/label/自由文本）。 */
  readonly respondPrompt = async (promptId: string, answer: string): Promise<boolean> => {
    try {
      await this.client.request("prompt.respond", {
        workspacePath: this.workspacePath,
        promptId,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        answer,
        idempotencyKey: randomUUID(),
      });
      return true;
    } catch {
      return false;
    }
  };

  private handlePromptRequested(payload: RuntimeNotificationMap["prompt.requested"]): void {
    const prompt =
      typeof payload.prompt === "object" && payload.prompt !== null
        ? (payload.prompt as Record<string, unknown>)
        : {};
    const question = typeof prompt["question"] === "string" ? prompt["question"] : "";
    const rawOptions = Array.isArray(prompt["options"]) ? prompt["options"] : [];
    const options: AskUserOption[] = [];
    for (const raw of rawOptions) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry["optionId"] !== "string" || typeof entry["label"] !== "string") continue;
      options.push({
        optionId: entry["optionId"],
        label: entry["label"],
        ...(typeof entry["description"] === "string" ? { description: entry["description"] } : {}),
      });
    }
    if (!question) return;
    this.options.onPrompt?.({
      requestId: payload.promptId,
      question,
      ...(typeof prompt["header"] === "string" ? { header: prompt["header"] } : {}),
      options,
      ...(prompt["freeText"] === true ? { freeText: true } : {}),
    });
  }
}
