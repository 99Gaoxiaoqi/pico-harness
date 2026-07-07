// AcpServer:ACP 方法 handler 的实现层 + AgentEngine 桥接。
//
// 持有 SessionManager 和一个 engine 工厂(mode + session → engine),
// 把各 ACP 方法请求派发到具体逻辑:
//   initialize      → 返回 serverInfo + capabilities(4 模式)
//   session/create  → globalSessionManager.getOrCreate → {sessionId}
//   session/load    → 取已存在会话,返回状态摘要
//   prompt          → 装配 engine(按 mode 映射 planMode/approval)→ engine.run
//                     → 流式回 response/start + response/output(经 reporter)+ response/finish
//   fs/readTextFile → 直接 IO 读 workDir 内文件(极简,不走工具)
//   fs/writeTextFile→ 直接 IO 写文件
//   interrupt       → 标记中断 flag(简化:不真正中止 engine.run)
//
// 引擎装配的关键模式(对标飞书 bot 的 engineFactory):把 engine 构造委托给
// 注入的工厂,生产入口(main.ts)提供真实工厂(provider+registry+approval),
// 测试入口提供 mock 工厂(注入 ScriptedProvider)。AcpServer 本身不 import
// 任何 Provider/Registry 实现,保持极简与可测。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../observability/logger.js";
import type { Session } from "../engine/session.js";
import { globalSessionManager } from "../engine/session.js";
import type { AgentEngine } from "../engine/loop.js";
import type { Reporter } from "../engine/reporter.js";
import {
  ACP_MODES,
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  AcpNotification,
  PICO_ACP_SERVER_INFO,
  type AcpMode,
  type InitializeResult,
  type InterruptRequest,
  type InterruptResult,
  type PromptRequest,
  type PromptResult,
  type SessionCreateRequest,
  type SessionCreateResult,
  type SessionLoadRequest,
  type SessionLoadResult,
  type StopReason,
} from "./protocol.js";
import type { AcpStdioServer, AcpMethodHandler } from "./stdio-server.js";
import type { ImagePart } from "../schema/message.js";

/**
 * Engine 工厂签名:给定会话 + 模式 + reporter,构造一个 AgentEngine。
 *
 * 工厂内部负责:
 *   - 创建 provider(createProvider / mock)
 *   - 构造 registry(buildDefaultToolRegistry + approval 中间件)
 *   - 按 mode 设置 planMode / YOLO 审批
 *   - 注入 delegation / plan-exit 等工具
 *
 * 生产入口(main.ts)与测试入口(测试注入)各提供一个工厂实现,
 * 让 AcpServer 与具体 provider 解耦。
 */
export type AcpEngineFactory = (opts: {
  session: Session;
  mode: AcpMode;
  reporter: Reporter;
}) => AgentEngine;

/** 默认模式(session/create 未指定 mode 时) */
export const DEFAULT_ACP_MODE: AcpMode = "default";

/** 校验 mode 是否合法;非法时回落到 default */
export function normalizeMode(mode: unknown): AcpMode {
  return typeof mode === "string" && (ACP_MODES as readonly string[]).includes(mode)
    ? (mode as AcpMode)
    : DEFAULT_ACP_MODE;
}

/**
 * 每个会话的运行时状态:记录正在进行的 run 供 interrupt 查询。
 * 简化设���:interrupt 只标记 flag,不真正中止 engine.run(那需要侵入 loop.ts,
 * 超出本次范围)。flag 让 IDE 感知中断意图,run 自然走完后返回。
 */
interface SessionRunState {
  running: boolean;
  /** 中断标记:interrupt 置 true,run 结束后清零 */
  interrupted: boolean;
}

/**
 * AcpServer:把 ACP 方法请求桥接到 AgentEngine。
 *
 * 与 AcpStdioServer 的关系:AcpServer 负责"做什么"(handler 逻辑),
 * AcpStdioServer 负责"怎么收发"(JSON-RPC over stdio)。
 * start() 时 AcpServer 把各 handler 注册到 stdio server,后者驱动前者。
 */
export class AcpServer {
  /** sessionId → 运行状态(供 interrupt) */
  private readonly runStates = new Map<string, SessionRunState>();
  /** 进程级默认模式(--mode 注入) */
  private readonly defaultMode: AcpMode;

  constructor(
    private readonly engineFactory: AcpEngineFactory,
    private readonly stdio: AcpStdioServer,
    options?: { defaultMode?: AcpMode },
  ) {
    this.defaultMode = options?.defaultMode ?? DEFAULT_ACP_MODE;
    this.registerHandlers();
  }

  /** 注册所有方法 handler 到 stdio server */
  private registerHandlers(): void {
    const reg = (method: string, handler: AcpMethodHandler): void => {
      this.stdio.registerMethod(method, handler);
    };
    reg(AcpMethod.INITIALIZE, () => this.handleInitialize());
    reg(AcpMethod.SESSION_CREATE, (p) => this.handleSessionCreate(p));
    reg(AcpMethod.SESSION_LOAD, (p) => this.handleSessionLoad(p));
    reg(AcpMethod.PROMPT, (p, notify) => this.handlePrompt(p, notify));
    reg(AcpMethod.FS_READ_TEXT_FILE, (p) => this.handleFsRead(p));
    reg(AcpMethod.FS_WRITE_TEXT_FILE, (p) => this.handleFsWrite(p));
    reg(AcpMethod.INTERRUPT, (p) => this.handleInterrupt(p));
  }

  // ---------------------------------------------------------------- initialize

  private async handleInitialize(): Promise<InitializeResult> {
    return {
      serverInfo: { name: PICO_ACP_SERVER_INFO.name, version: PICO_ACP_SERVER_INFO.version },
      protocolVersion: ACP_PROTOCOL_VERSION,
      capabilities: { modes: ACP_MODES },
    };
  }

  // ---------------------------------------------------------------- session

  private async handleSessionCreate(
    params: Record<string, unknown> | undefined,
  ): Promise<SessionCreateResult> {
    const req = (params ?? {}) as Partial<SessionCreateRequest>;
    const workDir = typeof req.workDir === "string" ? req.workDir : process.cwd();
    const sessionId = typeof req.sessionId === "string" && req.sessionId.length > 0
      ? req.sessionId
      : `acp:${randomUUID()}`;
    const mode = normalizeMode(req.mode);
    // ACP 会话默认关闭持久化:IDE 侧自己管理状态,避免 .claw/sessions 文件堆积。
    // (与测试场景一致:不落盘,进程退出即清理。)
    await globalSessionManager.getOrCreate(sessionId, workDir, { persistence: false });
    this.runStates.set(sessionId, { running: false, interrupted: false });
    logger.info({ sessionId, workDir, mode }, "[ACP] session/create");
    return { sessionId };
  }

  private async handleSessionLoad(
    params: Record<string, unknown> | undefined,
  ): Promise<SessionLoadResult> {
    const req = (params ?? {}) as Partial<SessionLoadRequest>;
    const sessionId = typeof req.sessionId === "string" ? req.sessionId : "";
    if (sessionId.length === 0) {
      throw new Error("session/load 缺少 sessionId");
    }
    const session = await globalSessionManager.getOrCreate(sessionId, process.cwd(), {
      persistence: false,
    });
    return {
      sessionId: session.id,
      workDir: session.workDir,
      messageCount: session.length,
    };
  }

  // ---------------------------------------------------------------- prompt

  private async handlePrompt(
    params: Record<string, unknown> | undefined,
    notify: (method: string, params: Record<string, unknown>) => void,
  ): Promise<PromptResult> {
    const req = (params ?? {}) as Partial<PromptRequest>;
    const sessionId = typeof req.sessionId === "string" ? req.sessionId : "";
    const message = typeof req.message === "string" ? req.message : "";
    if (sessionId.length === 0) throw new Error("prompt 缺少 sessionId");
    if (message.length === 0) throw new Error("prompt 缺少 message");

    const session = await globalSessionManager.getOrCreate(sessionId, process.cwd(), {
      persistence: false,
    });
    // 请求未指定 mode 时回落到进程默认模式(--mode 注入)
    const mode = normalizeMode(req.mode ?? this.defaultMode);
    const state = this.getRunState(sessionId);
    state.running = true;
    state.interrupted = false;

    const messageId = `msg:${randomUUID()}`;
    // 1. response/start:告诉 IDE 本轮回复的 messageId,后续 output/finish 都用它关联
    notify(AcpNotification.RESPONSE_START, { sessionId, messageId });

    // 2. 流式收集 reporter:engine 内部 onTextDelta(流式 provider)或 onMessage
    //    转成 response/output notification 推给 IDE。
    const collector = new AcpStreamCollector(sessionId, messageId, notify);
    const engine = this.engineFactory({ session, mode, reporter: collector.reporter });

    let stopReason: StopReason = "end_turn";
    let finalText = "";
    try {
      // 5.5e 图片入口:req.images(base64 内联)→ ImagePart[],透传到 user 消息
      const images: ImagePart[] | undefined = req.images?.map((img) => ({
        type: "image_base64",
        mimeType: img.mimeType,
        data: img.data,
      }));
      session.append({
        role: "user",
        content: message,
        ...(images ? { images } : {}),
      });
      const newMessages = await engine.run(session);
      finalText = findFinalAssistantText(newMessages);
      if (state.interrupted) {
        stopReason = "interrupted";
      }
    } catch (err) {
      stopReason = "error";
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ sessionId, err: errMsg }, "[ACP] prompt 执行出错");
      // 把错误也作为一段 output 推给 IDE,避免它一直等
      notify(AcpNotification.RESPONSE_OUTPUT, {
        sessionId,
        messageId,
        delta: `[错误] ${errMsg}`,
      });
      // 重新抛出会让 stdio 层包装成 error response;此处改吞掉,finish 用 error 原因
      finalText = finalText || `[错误] ${errMsg}`;
    } finally {
      state.running = false;
      // 3. response/finish:本轮结束
      notify(AcpNotification.RESPONSE_FINISH, {
        sessionId,
        messageId,
        stopReason,
      });
    }

    return { message: finalText, stopReason };
  }

  // ---------------------------------------------------------------- fs

  private async handleFsRead(
    params: Record<string, unknown> | undefined,
  ): Promise<{ content: string }> {
    const req = (params ?? {}) as { path?: string; sessionId?: string };
    if (typeof req.path !== "string") throw new Error("fs/readTextFile 缺少 path");
    const workDir = await this.resolveWorkDir(req.sessionId);
    const absPath = safeResolveWithin(workDir, req.path);
    const content = await readFile(absPath, "utf8");
    return { content };
  }

  private async handleFsWrite(
    params: Record<string, unknown> | undefined,
  ): Promise<{ ok: true }> {
    const req = (params ?? {}) as { path?: string; content?: string; sessionId?: string };
    if (typeof req.path !== "string") throw new Error("fs/writeTextFile 缺少 path");
    if (typeof req.content !== "string") throw new Error("fs/writeTextFile 缺少 content");
    const workDir = await this.resolveWorkDir(req.sessionId);
    const absPath = safeResolveWithin(workDir, req.path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, req.content, "utf8");
    return { ok: true };
  }

  // ---------------------------------------------------------------- interrupt

  private async handleInterrupt(
    params: Record<string, unknown> | undefined,
  ): Promise<InterruptResult> {
    const req = (params ?? {}) as Partial<InterruptRequest>;
    const sessionId = typeof req.sessionId === "string" ? req.sessionId : "";
    const state = sessionId ? this.runStates.get(sessionId) : undefined;
    if (state && state.running) {
      state.interrupted = true;
      logger.info({ sessionId }, "[ACP] interrupt:已标记中断");
      return { interrupted: true };
    }
    return { interrupted: false };
  }

  // ---------------------------------------------------------------- helpers

  private getRunState(sessionId: string): SessionRunState {
    let state = this.runStates.get(sessionId);
    if (!state) {
      state = { running: false, interrupted: false };
      this.runStates.set(sessionId, state);
    }
    return state;
  }

  /** 取会话的 workDir;无会话时回落到 process.cwd() */
  private async resolveWorkDir(sessionId: string | undefined): Promise<string> {
    if (typeof sessionId === "string" && sessionId.length > 0) {
      const session = await globalSessionManager.getOrCreate(sessionId, process.cwd(), {
        persistence: false,
      });
      return session.workDir;
    }
    return process.cwd();
  }
}

/**
 * 把 engine 的流式事件(onTextDelta / onMessage)转成 ACP response/output notification。
 *
 * engine 的流式分两路:
 *   - generateStream 的 onTextDelta:provider 每生成一段就回调(真正的 token 流)
 *   - onMessage:模型完成一轮纯文本输出时回调(可能是最终答案或思考过程)
 * 两路都汇成 response/output 推给 IDE,IDE 拼接展示。
 */
class AcpStreamCollector {
  readonly reporter: Reporter;

  constructor(
    private readonly sessionId: string,
    private readonly messageId: string,
    private readonly notify: (method: string, params: Record<string, unknown>) => void,
  ) {
    // 闭包直接捕获构造参数,无需 this 别名(规避 no-this-alias)
    const emit = (delta: string): void => {
      this.notify(AcpNotification.RESPONSE_OUTPUT, {
        sessionId: this.sessionId,
        messageId: this.messageId,
        delta,
      });
    };
    this.reporter = {
      onStart() {},
      onTurnStart() {},
      onThinking() {},
      onToolCall() {},
      onToolResult() {},
      onMessage(content: string): void {
        if (content.length > 0) emit(content);
      },
      onFinish() {},
      onTextDelta(delta: string): void {
        if (delta.length > 0) emit(delta);
      },
    };
  }
}

/** 从本轮新增消息里找最后一条纯文本 assistant 回复(无 toolCalls) */
function findFinalAssistantText(messages: readonly { role: string; content: string; toolCalls?: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && (m.toolCalls === undefined || (m.toolCalls as unknown[]).length === 0)) {
      return m.content;
    }
  }
  return "";
}

/**
 * 安全路径解析:把相对路径锚定到 workDir,绝对路径要求落在 workDir 内,
 * 防止 IDE 读写到工作区之外(路径穿越防护)。
 */
export function safeResolveWithin(workDir: string, path: string): string {
  const base = resolve(workDir);
  const abs = isAbsolute(path) ? resolve(path) : resolve(join(base, path));
  const rel = relative(base, abs);
  // rel 不以 ".." 开头且非绝对路径,说明落在 workDir 内
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`路径越界: ${path} 不在工作区 ${base} 内`);
  }
  // Windows:相对路径分隔符可能是 "\\",也需校验
  return abs;
}
