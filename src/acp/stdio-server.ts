// AcpStdioServer:JSON-RPC 2.0 over stdio 的服务端传输层。
//
// 与 src/mcp/stdio-client.ts 对称:那边是 client(往子进程 stdin 写请求、从 stdout 读响应),
// 这边是 server(从自己的 stdin 读请求、往 stdout 写响应)。
//
// 核心机制(复用 MCP 的成熟行缓冲方案,方向相反):
//   - 读 stdin 行:每条 JSON-RPC 消息占一行(\n 分隔),跨 chunk 拼接不完整行
//   - 按方法派发到 handler:handler 返回 result 或抛错,包装成 JSON-RPC response
//   - 写 stdout 行:response / notification 都序列化为一行 JSON + \n
//   - notification(无 id):不等响应,流式用(response/output)
//
// 生命周期:
//   start() → 绑定 process.stdin/stdout → 监听 data 事件 → 行缓冲派发
//   stop()  → 移除监听器
//
// 错误处理:handler 抛错 → 包装成 JSON-RPC error response(code -32603);
// 无法解析的行 → warn 后忽略(不回错,因为无 id 可关联)。

import { logger } from "../observability/logger.js";

/**
 * 方法 handler 签名。
 * @param params 请求 params(可能 undefined)
 * @param notify 通知回调:handler 可在执行期间向 client 推送 notification(流式输出)
 * @returns result,会被包进 JSON-RPC response 的 result 字段
 */
export type AcpMethodHandler = (
  params: Record<string, unknown> | undefined,
  notify: (method: string, params: Record<string, unknown>) => void,
) => Promise<unknown>;

/** 标准 JSON-RPC 错误码(复用 MCP 的定义) */
const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * AcpStdioServer:把 process.stdin/stdout 包装成 JSON-RPC server。
 *
 * 设计上完全依赖 Node 的 process.stdin/stdout —— 与 MCP 客户端 spawn 子进程不同,
 * server 端是"被 spawn 的那个进程",直接读写自己的 stdio 即可。
 * 这种依赖让它在被测试时可以通过注入 stream 解耦(见构造参数)。
 */
export class AcpStdioServer {
  /** stdin 行缓冲:JSON-RPC 消息以 \n 分隔,跨 chunk 拼接不完整行 */
  private stdinBuffer = "";
  private running = false;

  /**
   * @param input  可读流(默认 process.stdin);测试时注入 string/ PassThrough
   * @param output 可写流(默认 process.stdout);测试时注入收集器
   * @param handlers 方法名 → handler 映射(由 AcpServer 注入)
   */
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly handlers: Map<string, AcpMethodHandler> = new Map(),
  ) {}

  /** 注册方法 handler(由 AcpServer 调用) */
  registerMethod(method: string, handler: AcpMethodHandler): void {
    this.handlers.set(method, handler);
  }

  /** 启动:开始监听 stdin */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.setEncoding?.("utf8");
    this.input.on("data", (chunk: string) => {
      this.stdinBuffer += chunk;
      this.drainLines();
    });
    this.input.on("end", () => {
      // stdin 关闭(client 断开):把残留缓冲跑完,然后停止
      this.drainLines();
      this.running = false;
    });
    this.input.on("error", (err) => {
      logger.error({ err: String(err) }, "[ACP] stdin 读取错误");
    });
    logger.info("[ACP] stdio server 启动,等待 IDE 请求");
  }

  /** 停止:移除监听器(进程退出前调用) */
  stop(): void {
    this.running = false;
    this.input.removeAllListeners?.("data");
  }

  /**
   * 直接派发一条 JSON-RPC 消息(测试主入口 + 内部共用)。
   * 接收已解析的 JSON 对象,派发到对应 handler,返回应写的响应行(字符串)。
   * notification(无 id)不回响应 → 返回 undefined。
   *
   * 暴露为 public 便于测试:不必走真实 stdio,直接喂数据验证 handler。
   */
  async dispatch(json: unknown): Promise<string | undefined> {
    if (typeof json !== "object" || json === null) {
      // 非法消息:无 id 可关联,无法回错,只能 warn 后丢弃
      logger.warn({ msg: String(json) }, "[ACP] 收到非对象 JSON-RPC 消息,已忽略");
      return undefined;
    }
    const msg = json as {
      jsonrpc?: string;
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
    };
    // notification(无 id):若 handler 存在则调用,但不回响应。
    // 用局部 const 提取 id,让 TS 在 hasId 分支内正确收窄(属性访问无法跨变量收窄)。
    const rawId = msg.id;
    const hasId = rawId !== undefined && rawId !== null;
    const id = hasId ? (rawId as number | string) : undefined;
    const method = msg.method;
    const handler = method !== undefined ? this.handlers.get(method) : undefined;

    if (!handler) {
      if (!hasId) return undefined; // 未知 notification:静默忽略
      // 未知 request:回 method not found
      return this.encodeError(id!, JSONRPC_ERROR.METHOD_NOT_FOUND, `方法不存在: ${method ?? "(空)"}`);
    }

    // 通知回调:让 handler 在执行期间向 client 推送流式 notification
    const notify = (m: string, p: Record<string, unknown>): void => {
      this.writeNotification(m, p);
    };

    try {
      const result = await handler(msg.params, notify);
      if (!hasId) return undefined; // notification:无需回响应
      return this.encodeResult(id!, result);
    } catch (err) {
      if (!hasId) return undefined; // notification 失败也无法回错
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ method, err: message }, `[ACP] handler "${method}" 抛错`);
      return this.encodeError(id!, JSONRPC_ERROR.INTERNAL_ERROR, message);
    }
  }

  // ---------- 内部实现 ----------

  /** 把 stdin 缓冲按 \n 切分,每行解析为 JSON 并派发 */
  private drainLines(): void {
    let idx: number;
    while ((idx = this.stdinBuffer.indexOf("\n")) !== -1) {
      const line = this.stdinBuffer.slice(0, idx).trim();
      this.stdinBuffer = this.stdinBuffer.slice(idx + 1);
      if (line.length === 0) continue;
      void this.handleLine(line);
    }
  }

  /** 单行处理:解析 JSON → 派发 → 写回响应(若有) */
  private async handleLine(line: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      logger.warn({ line }, "[ACP] 无法解析 stdin 行为 JSON,已忽略");
      return;
    }
    const response = await this.dispatch(json);
    if (response !== undefined) {
      this.writeRaw(response);
    }
  }

  /** 写一行 JSON-RPC 响应(已序列化好的字符串) */
  private writeRaw(text: string): void {
    this.output.write(text.endsWith("\n") ? text : text + "\n");
  }

  /** 写 notification(无 id,服务端主动推送) */
  writeNotification(method: string, params: Record<string, unknown>): void {
    const msg = { jsonrpc: "2.0", method, params };
    this.writeRaw(JSON.stringify(msg));
  }

  private encodeResult(id: number | string, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }

  private encodeError(id: number | string, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
