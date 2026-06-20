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
import type { Reporter } from "../engine/reporter.js";
import {
  globalApprovalManager,
  isDangerousCommand,
  type ApprovalNotifier,
} from "../approval/manager.js";
import type { Registry, MiddlewareFunc } from "../tools/registry.js";

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

/** 工具结果汇报截断长度 (防飞书消息超长) */
const REPORT_MAX_LEN = 200;

/**
 * FeishuBot:封装飞书机器人的配置与核心业务流。
 * 持有引擎引用,收到消息后跑 Agent,通过 FeishuReporter 回写状态。
 * 每个 chatId 对应独立 Session,实现多群物理隔离(第 11 讲)。
 */
export class FeishuBot {
  private readonly client: Client;
  private readonly engine: AgentEngine;
  private readonly config: FeishuConfig;
  private readonly workDir: string;
  /** 当前正在跑 Agent 的会话(审批通知发到这里);同一 bot 同时只处理一个活跃会话 */
  private activeChatId: string | null = null;

  constructor(
    engine: AgentEngine,
    config: FeishuConfig,
    workDir: string,
    registry?: Registry,
  ) {
    this.engine = engine;
    this.config = config;
    this.workDir = workDir;
    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    // 第 16 讲:挂载高危命令审批中间件。
    // 通知通过当前活跃会话的 FeishuReporter 发送。
    if (registry) {
      registry.use(this.buildApprovalMiddleware());
    }
  }

  /** 构建审批中间件:命中高危命令 → 发飞书审批请求 → 挂起等待 approve/reject */
  private buildApprovalMiddleware(): MiddlewareFunc {
    const notify: ApprovalNotifier = (notice) => {
      // 审批请求发到当前活跃会话
      if (this.activeChatId) {
        const reporter = new FeishuReporter(this.client, this.activeChatId);
        void reporter.onMessage(notice.message);
      } else {
        console.warn(notice.message);
      }
    };
    return async (call) => {
      if (!isDangerousCommand(call.name, call.arguments)) {
        return { allowed: true, reason: "" };
      }
      const { allowed, reason } = await globalApprovalManager.waitForApproval(
        call.id,
        call.name,
        call.arguments,
        notify,
      );
      return { allowed, reason };
    };
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
    let text = "";
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

    // 驾驭并发:绝不阻塞事件回调,为每个请求开独立任务
    // (这里用 void 放后台跑,飞书会持续接收新消息)
    void this.runAgentAndReport(chatId, text);
  }

  /** 跑 Agent,用 FeishuReporter 把状态发回指定会话 */
  private async runAgentAndReport(chatId: string, prompt: string): Promise<void> {
    const reporter = new FeishuReporter(this.client, chatId);
    // 记录当前活跃会话,供审批中间件发通知
    this.activeChatId = chatId;
    try {
      // 第 11 讲:每个 chatId 对应独立 Session,实现多群物理隔离。
      // 同一群的连续消息复用同一 Session,跨群互不干扰。
      const session = globalSessionManager.getOrCreate(`feishu:${chatId}`, this.workDir);
      session.append({ role: "user", content: prompt });
      await this.engine.run(session, reporter);
    } catch (err) {
      await reporter.onMessage(`❌ 任务执行失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.activeChatId = null;
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
    const display = args.length > REPORT_MAX_LEN ? args.slice(0, REPORT_MAX_LEN) + "...(已截断)" : args;
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
