// 飞书机器人集成层。
// 对应课程第 09 讲 internal/feishu/bot.go。
//
// 两件事:
// 1. 监听飞书事件流 (用 WSClient 长连接,无需公网回调地址,本地开发友好)
// 2. FeishuReporter:把引擎状态通过飞书消息 API 发回用户/群
//
// 关键工程点:
// - 收到消息后绝不阻塞事件回调,为每个请求开独立任务 (void engine.run)
// - 工具结果汇报截断到 200 字符 (防飞书消息超长)
// - 每条状态都发回触发消息的会话 (chatId)

import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import type { AgentEngine } from "../engine/loop.js";
import { globalSessionManager } from "../engine/session.js";
import type { Session } from "../engine/session.js";
import type { Reporter } from "../engine/reporter.js";
import { SteerQueue } from "../engine/steer-queue.js";
import {
  globalApprovalManager,
  globalApprovalPolicy,
  isAgentOpsDangerousCommand,
  type ApprovalNotice,
} from "../approval/manager.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import { computeApprovalDiff } from "../approval/diff.js";

/** 飞书机器人配置 */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** 事件订阅加密 key (可选,在飞书后台设置) */
  encryptKey?: string;
  /** 事件订阅验证 token (可选) */
  verifyToken?: string;
}

/** 加载飞书配置 (从环境变量) */
export function loadFeishuConfig(): FeishuConfig {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("缺少环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET");
  }
  return {
    appId,
    appSecret,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,
    verifyToken: process.env.FEISHU_VERIFY_TOKEN || undefined,
  };
}

/** 卡片按钮点击回调事件 (card.action.trigger) 的载荷 */
interface CardActionPayload {
  action?: {
    value?: unknown;
    tag?: string;
  };
  operator?: { openId?: string; name?: string };
}

/** 工具结果汇报截断长度 (防飞书消息超长) */
const REPORT_MAX_LEN = 200;

export interface FeishuAgentRunContext {
  chatId: string;
  prompt: string;
  session: Session;
  reporter: FeishuReporter;
  workDir: string;
}

export type FeishuAgentEngineFactory = (context: FeishuAgentRunContext) => AgentEngine;

/**
 * FeishuBot:封装飞书机器人的配置与核心业务流。
 * 持有引擎工厂,收到消息后为当前 chat 动态组装 Agent,通过 FeishuReporter 回写状态。
 * 每个 chatId 对应独立 Session,实现多群物理隔离(第 11 讲)。
 */
export class FeishuBot {
  private readonly client: Client;
  private readonly engineFactory: FeishuAgentEngineFactory;
  private readonly config: FeishuConfig;
  private readonly workDir: string;
  /**
   * Steer 队列映射(ROADMAP 3.2):chatId → 当前运行中 session 的 SteerQueue。
   * runAgentAndReport 创建队列存这里并把同一实例传给 engine;run 结束后删除。
   * 运行中收到该 chat 的新消息时,push 进队列,engine 下一轮 drain 给模型。
   */
  private readonly steerQueues = new Map<string, SteerQueue>();

  constructor(
    engineFactory: FeishuAgentEngineFactory,
    config: FeishuConfig,
    workDir: string,
    client?: Client,
  ) {
    this.engineFactory = engineFactory;
    this.config = config;
    this.workDir = workDir;
    this.client =
      client ??
      new Client({
        appId: config.appId,
        appSecret: config.appSecret,
      });
  }

  /** 启动 WSClient 长连接,接收飞书事件 (无需公网回调地址) */
  start(): void {
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        try {
          // SDK 事件类型较复杂,这里宽松取值
          await this.handleMessage(data as unknown as MessageEvent);
        } catch (err) {
          console.error("[Feishu] 处理消息失败:", err);
        }
      },
      // 第 16 讲:卡片按钮回调 (card.action.trigger)。
      // 用户点击审批卡片的"同意"/"拒绝"按钮时触发,value 携带 {taskId, action}。
      // 前提:飞书后台「事件与回调」需开启卡片回调通过长连接接收。
      "card.action.trigger": async (data: unknown) => {
        try {
          await this.handleCardAction(data as CardActionPayload);
        } catch (err) {
          console.error("[Feishu] 处理卡片回调失败:", err);
        }
      },
    });

    const wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
    wsClient.start({
      eventDispatcher: dispatcher,
    });
    console.log("[Feishu] WSClient 长连接已启动,等待群里 @机器人 消息...");
  }

  /** 处理一条飞书消息:提取文本 → 跑 Agent → 状态回写 */
  private async handleMessage(data: MessageEvent): Promise<void> {
    // 飞书 SDK 2.0 schema:message/sender 直接挂在 data 顶层
    const chatId = data?.message?.chat_id;
    const contentStr = data?.message?.content;
    if (!chatId || !contentStr) {
      console.warn("[Feishu] 消息缺少 chat_id 或 content,跳过");
      return;
    }

    // 飞书消息体是 JSON,如 {"text":"@_user_1 你好"},提取 text
    let text: string;
    try {
      const parsed = JSON.parse(contentStr) as { text?: string };
      text = parsed.text ?? "";
    } catch {
      text = contentStr;
    }
    // 去掉 @机器人 的占位符
    text = text.replace(/@_user_\d+\s*/g, "").trim();
    if (!text) return;

    console.log(`[Feishu] 收到会话 ${chatId} 消息: ${text}`);

    // 第 16 讲:拦截人工审批特殊口令 approve/reject
    const approveMatch = text.match(/^approve\s+(\S+)/i);
    if (approveMatch) {
      const taskId = approveMatch[1]!;
      const ok = globalApprovalManager.resolveApproval(taskId, true, "人类管理员已批准操作");
      console.log(`[Feishu] 会话 ${chatId}: ${ok ? "✅" : "⚠"} approve ${taskId}`);
      return;
    }
    const rejectMatch = text.match(/^reject\s+(\S+)/i);
    if (rejectMatch) {
      const taskId = rejectMatch[1]!;
      const ok = globalApprovalManager.resolveApproval(
        taskId,
        false,
        "人类管理员认为该操作过于危险,已拒绝",
      );
      console.log(`[Feishu] 会话 ${chatId}: ${ok ? "🚫" : "⚠"} reject ${taskId}`);
      return;
    }
    // 3.6 Plan Review:modify 口令——"modify <taskId> <新plan内容>" 修改后通过。
    // 把后续整段文本作为修改后的 PLAN.md 写回,allowed=true 放行退出 Plan Mode。
    const modifyMatch = text.match(/^modify\s+(\S+)\s+([\s\S]+)/i);
    if (modifyMatch) {
      const taskId = modifyMatch[1]!;
      const newPlan = modifyMatch[2]!.trim();
      const ok = globalApprovalManager.resolveApprovalWithModify(
        taskId,
        "人类管理员修改了 plan 内容,修改后通过",
        newPlan,
      );
      console.log(`[Feishu] 会话 ${chatId}: ${ok ? "✏️" : "⚠"} modify ${taskId}`);
      return;
    }

    // 第 22 讲:意图拦截过滤器 (Intent Filter)。
    // 群员聊无关天("今天中午吃什么")不应触发昂贵的 Main Loop。
    // 只有明确需要 Agent 介入意图才唤醒:命令前缀 / 自然语言请求关键词。
    if (!shouldWakeAgent(text)) {
      console.log(`[Feishu] 会话 ${chatId}: 非 Agent 意图,忽略: "${text.slice(0, 50)}"`);
      return;
    }

    // 【Steer 运行时注入】(ROADMAP 3.2):若该 chat 当前有运行中的 Agent
    // (steerQueues 命中),把消息 push 进队列作为引导,而非起一条新 run。
    // engine 下一轮 A 点 peek 本轮可见、C 点 drain 落 session 永久浮现。
    const steerQueue = this.steerQueues.get(chatId);
    if (steerQueue) {
      steerQueue.push(text);
      console.log(
        `[Feishu] 会话 ${chatId}: 🎯 运行中注入 steer(已排队,下一轮浮现): "${text.slice(0, 50)}"`,
      );
      return;
    }

    // 驾驭并发:绝不阻塞事件回调,为每个请求开独立任务
    // (这里用 void 放后台跑,飞书会持续接收新消息)
    void this.runAgentAndReport(chatId, text);
  }

  /** 跑 Agent,用 FeishuReporter 把状态发回指定会话 */
  private async runAgentAndReport(chatId: string, prompt: string): Promise<void> {
    const reporter = new FeishuReporter(this.client, chatId);
    try {
      // 第 11 讲:每个 chatId 对应独立 Session,实现多群物理隔离。
      // 同一群的连续消息复用同一 Session,跨群互不干扰。
      const session = await globalSessionManager.getOrCreate(`feishu:${chatId}`, this.workDir);
      session.append({ role: "user", content: prompt });
      const engine = this.engineFactory({
        chatId,
        prompt,
        session,
        reporter,
        workDir: this.workDir,
      });
      // Steer(ROADMAP 3.2):创建队列挂到 engine 并登记到 map。
      // 运行中该 chat 收到的新消息(handleMessage 检测到 steerQueues 命中)
      // 会 push 进来,engine 下一轮 drain 给模型。run 结束后注销。
      const steerQueue = new SteerQueue();
      engine.setSteerQueue?.(steerQueue);
      this.steerQueues.set(chatId, steerQueue);
      // P0:per-session 串行队列,防止并发读写 history 竞态
      await session.serialize(() => engine.run(session, reporter));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Feishu] 会话 ${chatId} 任务失败:`, errMsg);
      await reporter.onMessage(`❌ 任务执行失败: ${errMsg}`);
    } finally {
      // run 结束(无论成败)注销队列:此后该 chat 的新消息走正常 run 路径
      this.steerQueues.delete(chatId);
    }
  }

  /**
   * 处理审批卡片的按钮点击回调。
   * 卡片按钮 value = { taskId: string; action: "approve" | "reject" }
   */
  private async handleCardAction(data: CardActionPayload): Promise<void> {
    const value = data?.action?.value as { taskId?: string; action?: string } | undefined;
    if (!value?.taskId || !value.action) {
      console.warn("[Feishu] 卡片回调缺少 taskId/action:", value);
      return;
    }
    const { taskId, action } = value;
    if (action === "approve") {
      const ok = globalApprovalManager.resolveApproval(
        taskId,
        true,
        "人类管理员已批准操作(点击卡片按钮)",
      );
      console.log(`[Feishu] 卡片回调: ${ok ? "✅" : "⚠"} approve ${taskId}`);
    } else if (action === "reject") {
      const ok = globalApprovalManager.resolveApproval(
        taskId,
        false,
        "人类管理员认为该操作过于危险,已拒绝(点击卡片按钮)",
      );
      console.log(`[Feishu] 卡片回调: ${ok ? "🚫" : "⚠"} reject ${taskId}`);
    }
  }
}

/**
 * FeishuReporter:把引擎状态通过飞书消息 API 发回指定会话。
 * 实现 Reporter 接口。
 */
export class FeishuReporter implements Reporter {
  constructor(
    private readonly client: Client,
    private readonly chatId: string,
  ) {}

  onStart(workDir: string, enableThinking: boolean): void {
    void this.send(`🚀 引擎启动\n工作区: ${workDir}\n慢思考: ${enableThinking}`);
  }

  onTurnStart(_turn: number): void {
    // 每轮开始不发消息,避免刷屏
  }

  onThinking(): void {
    void this.send("🧠 慢思考中...");
  }

  onToolCall(toolName: string, args: string): void {
    const display =
      args.length > REPORT_MAX_LEN ? args.slice(0, REPORT_MAX_LEN) + "...(已截断)" : args;
    void this.send(`🛠️ 调用工具: ${toolName}\n参数: ${display}`);
  }

  onToolResult(toolName: string, result: string, isError: boolean): void {
    const display =
      result.length > REPORT_MAX_LEN ? result.slice(0, REPORT_MAX_LEN) + "...(已截断)" : result;
    const icon = isError ? "❌" : "✅";
    void this.send(`${icon} 工具 ${toolName} 结果:\n${display}`);
  }

  onMessage(content: string): void {
    void this.send(`🤖 ${content}`);
  }

  onFinish(): void {
    void this.send("✅ 任务完成。");
  }

  /**
   * 发送交互式审批卡片(带"同意"/"拒绝"按钮)。
   * 按钮点击触发 card.action.trigger 回调,value 携带 {taskId, action}。
   * 用户也可直接回复 "approve <taskId>" / "reject <taskId>" 口令。
   */
  async sendApprovalCard(notice: ApprovalNotice): Promise<void> {
    // exit_plan_mode 是 Plan 审批,改用中性色调与标题;其余为高危操作审批(红色)。
    const isPlanReview = notice.toolName === "exit_plan_mode";
    const headerTitle = isPlanReview ? "📋 Plan 审批请求" : "⚠ 高危操作审批请求";
    const headerTemplate = isPlanReview ? "blue" : "red";
    const diffLabel = isPlanReview ? "PLAN.md 内容" : "变更预览";
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: headerTitle },
        template: headerTemplate,
      },
      elements: [
        {
          tag: "div",
          fields: [
            { is_short: true, text: { tag: "lark_md", content: `**工具**\n${notice.toolName}` } },
            { is_short: true, text: { tag: "lark_md", content: `**任务 ID**\n${notice.taskId}` } },
          ],
        },
        {
          tag: "div",
          text: { tag: "lark_md", content: `**参数**\n\`${notice.args}\`` },
        },
        // diff 预览:放在参数之后、按钮之前,用代码块包裹便于阅读。
        // 复用 generateSimpleDiff 内置截断(DIFF_MAX_LINES=30),此处不重复截断。
        ...(notice.diff
          ? [
              { tag: "hr" },
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: `**${diffLabel}**\n\`\`\`\n${notice.diff}\n\`\`\``,
                },
              },
            ]
          : []),
        { tag: "hr" },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "✅ 同意执行" },
              type: "primary",
              value: { taskId: notice.taskId, action: "approve" },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "🚫 拒绝执行" },
              type: "danger",
              value: { taskId: notice.taskId, action: "reject" },
            },
          ],
        },
        {
          tag: "note",
          elements: [
            {
              tag: "plain_text",
              content: isPlanReview
                ? "也可回复文字指令:approve/reject/modify + 任务ID(modify 后附上新 plan 内容)"
                : "也可回复 approve/reject + 任务ID 文字指令",
            },
          ],
        },
      ],
    };
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: this.chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
    } catch (err) {
      console.error("[Feishu] 发送审批卡片失败,回退到文本:", err);
      await this.send(notice.message);
    }
  }

  /** 调用飞书消息 API 发送文本到指定会话 */
  private async send(text: string): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: this.chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      console.error("[Feishu] 发送消息失败:", err);
    }
  }
}

/** 飞书消息事件数据 (SDK 2.0 schema,message/sender 在顶层) */
interface MessageEvent {
  event_type?: string;
  message?: {
    chat_id?: string;
    chat_type?: string;
    content?: string;
    message_id?: string;
    message_type?: string;
  };
  sender?: {
    sender_id?: { open_id?: string };
    sender_type?: string;
  };
}

/** 构建 AgentOps 审批中间件:命中高危命令 → 当前 chat 的飞书 Reporter 发卡片 → 挂起等待审批 */
export function createFeishuApprovalMiddleware(reporter: FeishuReporter, workDir: string): MiddlewareFunc {
  return async (call) => {
    return globalApprovalPolicy.decide(
      "feishu",
      call,
      async () => {
        // 拦截时计算 before/after diff,失败返回 undefined 不阻断审批
        const diff = await computeApprovalDiff(call.name, call.arguments, workDir);
        return globalApprovalManager.waitForApproval(call.id, call.name, call.arguments, (notice) => {
          void reporter.sendApprovalCard(notice);
        }, diff);
      },
      isAgentOpsDangerousCommand,
    );
  };
}

/**
 * 意图拦截过滤器 (Intent Filter):判断用户消息是否需要唤醒 Main Loop。
 * 避免群员闲聊("今天中午吃什么")触发昂贵的大模型调用。
 *
 * 唤醒条件(满足任一):
 * - 命令前缀:/agent、/help、/usage、/task
 * - 包含明确的行动意图关键词:帮、请、执行、修复、检查、查找、分析、
 *   重构、部署、删除、创建、运行、读取、修改、总结、解释
 * - 包含代码/技术相关词:bug、error、报错、文件、代码、配置、日志、
 *   测试、部署、编译、端口、服务
 */
const WAKE_KEYWORDS = [
  // 行动意图
  "帮", "请", "执行", "修复", "检查", "查找", "分析", "重构", "部署",
  "删除", "创建", "运行", "读取", "修改", "总结", "解释", "排查",
  // 技术词
  "bug", "error", "报错", "文件", "代码", "配置", "日志", "测试",
  "编译", "端口", "服务", "函数", "变量", "接口", "数据库", "git",
];

export function shouldWakeAgent(text: string): boolean {
  const lower = text.toLowerCase();
  // 命令前缀直接唤醒
  if (/^(\/agent|\/help|\/usage|\/task)\b/i.test(lower)) return true;
  // 关键词匹配
  return WAKE_KEYWORDS.some((kw) => lower.includes(kw));
}
