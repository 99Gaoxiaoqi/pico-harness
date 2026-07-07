// ACP (Agent Client Protocol) 协议层类型定义。
//
// ACP 是 IDE(如 VSCode 插件)与 Agent(harness)通信的协议。
// 基于 JSON-RPC 2.0 over stdio,类似 LSP 但面向 Agent:
//   IDE(client)发 initialize / session/create / prompt / fs/readTextFile ...
//   pico(server)回 JSON-RPC response + 流式 notification(response/output)。
//
// 本文件只定义方法名常量与请求/响应体类型,不含传输逻辑。
// 传输层见 stdio-server.ts;方法 handler 见 server.ts。

// ---------------------------------------------------------------------------
// 方法名常量
// ---------------------------------------------------------------------------

/** ACP 协议版本(pico 服务端声明的版本) */
export const ACP_PROTOCOL_VERSION = "2025-07-07";

/** pico ACP 服务端在 initialize 握手中声明的身份 */
export const PICO_ACP_SERVER_INFO = {
  name: "pico-harness",
  version: "0.1.0",
} as const;

/** ACP 支持的 4 种运行模式 */
export const ACP_MODES = ["default", "plan", "auto", "yolo"] as const;

/** ACP 运行模式类型 */
export type AcpMode = (typeof ACP_MODES)[number];

/** 请求方法名(IDE → pico) */
export const AcpMethod = {
  /** 握手:声明客户端身份 + 协议版本 */
  INITIALIZE: "initialize",
  /** 新建/加载会话 */
  SESSION_CREATE: "session/create",
  SESSION_LOAD: "session/load",
  /** 提交一条 prompt,触发 Agent run */
  PROMPT: "prompt",
  /** 文件桥接:IDE 读 Agent 工作区文件 */
  FS_READ_TEXT_FILE: "fs/readTextFile",
  FS_WRITE_TEXT_FILE: "fs/writeTextFile",
  /** 中断当前会话的运行 */
  INTERRUPT: "interrupt",
} as const;

/** notification 方法名(pico → IDE,流式输出) */
export const AcpNotification = {
  /** 响应开始:附 messageId */
  RESPONSE_START: "response/start",
  /** 响应增量输出:附 delta 文本(流式) */
  RESPONSE_OUTPUT: "response/output",
  /** 响应结束:附 stopReason */
  RESPONSE_FINISH: "response/finish",
} as const;

/** 响应结束原因 */
export type StopReason = "end_turn" | "max_turns" | "interrupted" | "error";

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface InitializeRequest {
  protocolVersion?: string;
  clientInfo?: { name?: string; version?: string };
}

export interface InitializeResult {
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  capabilities: {
    /** 支持的运行模式 */
    modes: readonly AcpMode[];
  };
}

// ---------------------------------------------------------------------------
// session/create & session/load
// ---------------------------------------------------------------------------

export interface SessionCreateRequest {
  /** 会话绑定的工作目录(IDE 传入项目根目录) */
  workDir: string;
  /** 可选:显式指定 sessionId;缺省则自动生成 */
  sessionId?: string;
  /** 可选:默认运行模式 */
  mode?: AcpMode;
}

export interface SessionCreateResult {
  sessionId: string;
}

export interface SessionLoadRequest {
  sessionId: string;
}

export interface SessionLoadResult {
  sessionId: string;
  workDir: string;
  /** 当前历史消息条数 */
  messageCount: number;
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

export interface PromptRequest {
  sessionId: string;
  /** 用户本轮输入 */
  message: string;
  /** 覆盖本会话默认模式 */
  mode?: AcpMode;
}

/** prompt 的最终响应(在流式 notification 之后返回) */
export interface PromptResult {
  /** 最终完整回复文本(若模型有工具循环,取最后一条纯文本 assistant 消息) */
  message: string;
  /** 停止原因 */
  stopReason: StopReason;
}

/** response/start notification body */
export interface ResponseStartParams {
  sessionId: string;
  messageId: string;
}

/** response/output notification body(流式增量) */
export interface ResponseOutputParams {
  sessionId: string;
  messageId: string;
  /** 本段增量文本 */
  delta: string;
}

/** response/finish notification body */
export interface ResponseFinishParams {
  sessionId: string;
  messageId: string;
  stopReason: StopReason;
}

// ---------------------------------------------------------------------------
// fs/readTextFile & fs/writeTextFile
// ---------------------------------------------------------------------------

export interface FsReadTextFileRequest {
  /** 相对 workDir 的路径(或绝对路径,落在 workDir 内) */
  path: string;
  /** 关联的会话(取其 workDir 作为基准) */
  sessionId?: string;
}

export interface FsReadTextFileResult {
  content: string;
}

export interface FsWriteTextFileRequest {
  path: string;
  content: string;
  sessionId?: string;
}

export interface FsWriteTextFileResult {
  ok: true;
}

// ---------------------------------------------------------------------------
// interrupt
// ---------------------------------------------------------------------------

export interface InterruptRequest {
  sessionId: string;
}

export interface InterruptResult {
  /** 是否成功中断了一个正在进行的 run */
  interrupted: boolean;
}
