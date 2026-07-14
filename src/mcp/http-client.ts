// HttpMcpClient:通过 HTTP/SSE 与 MCP server 通信的客户端。
//
// 支持两种 transport:
//   1. http (Streamable HTTP):每个 JSON-RPC 请求 POST 一次,响应可能是
//      application/json(单响应)或 text/event-stream(SSE 流,含本次响应)。
//   2. sse (legacy SSE):先 GET 建立 SSE 长连接收响应,POST 发请求;
//      server 首个 `endpoint` 事件告知 POST 地址。
//
// 不依赖 EventSource —— Node 的 fetch 已支持 streaming response,
// 手写 SSE 行解析即可,保持零外部依赖。
//
// 接口与 StdioMcpClient 一致(McpClient),让 McpConnectionManager 无感切换。

import { logger } from "../observability/logger.js";
import type { ToolExecutionContext } from "../tools/registry.js";
import {
  JsonRpcErrorCode,
  MCP_ELICITATION_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  PICO_MCP_CLIENT_INFO,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClient,
  type McpClientOptions,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpPromptGetResult,
  type McpPromptListResult,
  type McpResourceListResult,
  type McpResourceReadResult,
  type McpServerConfig,
  type McpTool,
  type McpToolResult,
} from "./types.js";
import { redactSensitiveText } from "./redact.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const MAX_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const CANCELLATION_POST_TIMEOUT_MS = 1_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_CONCURRENT_ELICITATIONS = 1;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  controller: AbortController;
  signal?: AbortSignal;
  abortListener?: () => void;
  abortReason?: Error;
  transport?: Promise<void>;
  abortTask?: Promise<void>;
}

type OutgoingJsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | { jsonrpc: "2.0"; method: string; params: Record<string, unknown> };

/**
 * HttpMcpClient:把一个远程 MCP server 封装成 McpClient 接口。
 *
 * 对 http transport:无状态,每个请求独立 POST。
 * 对 sse transport:connect() 时建立持久 SSE 连接,所有响应走该流;
 *   请求 POST 到 server 告知的 endpoint。
 */
export class HttpMcpClient implements McpClient {
  /**
   * HTTP 只能证明本地 fetch/stream 已中止并发出 cancellation。
   * 远程 server 是否真正停止副作仍取决于它的协作实现。
   */
  readonly toolCancellationScope = "transport" as const;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private connected = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  /** sse 模式:POST 请求的目标地址(由 server 的 endpoint 事件告知) */
  private postEndpoint: string | undefined;
  /** sse 模式:读 SSE 流的 AbortController,close() 时中止 */
  private sseAbort: AbortController | undefined;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeTransports = new Set<Promise<unknown>>();
  private readonly closeHandlers: Array<(err?: Error) => void> = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];
  private readonly elicitationControllers = new Set<AbortController>();
  private negotiatedProtocolVersion = MCP_PROTOCOL_VERSION;
  private sessionId: string | undefined;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: McpClientOptions = {},
  ) {
    if (config.transport !== "http" && config.transport !== "sse") {
      throw new Error(`HttpMcpClient 不支持 transport=${config.transport}`);
    }
    if (!config.url) {
      throw new Error(`MCP server "${config.name}" 缺少 url 字段(http/sse 模式必填)`);
    }
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error(`MCP server "${this.config.name}" 已关闭,无法重连`);
    if (this.connected) return;

    if (this.config.transport === "sse") {
      // sse:先建立持久连接,等 endpoint 事件
      await this.startSseStream();
    }
    // http transport 无需预连接,initialize 时直接 POST

    await this.initialize();
    if (this.closed) throw new Error(`MCP server "${this.config.name}" 已关闭,无法重连`);
    this.connected = true;
    logger.info(
      { server: this.config.name, transport: this.config.transport },
      `[MCP] ${this.config.transport} server "${this.config.name}" 连接成功`,
    );
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((t) => this.normalizeTool(t));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<McpToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, context?.signal);
    return this.normalizeToolResult(result);
  }

  async listResources(cursor?: string): Promise<McpResourceListResult> {
    const result = (await this.request("resources/list", cursor ? { cursor } : {})) as {
      resources?: unknown;
      nextCursor?: unknown;
    };
    return {
      resources: Array.isArray(result.resources)
        ? (result.resources as McpResourceListResult["resources"])
        : [],
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    const result = (await this.request("resources/read", { uri })) as { contents?: unknown };
    return {
      contents: Array.isArray(result.contents)
        ? (result.contents as McpResourceReadResult["contents"])
        : [],
    };
  }

  async listPrompts(cursor?: string): Promise<McpPromptListResult> {
    const result = (await this.request("prompts/list", cursor ? { cursor } : {})) as {
      prompts?: unknown;
      nextCursor?: unknown;
    };
    return {
      prompts: Array.isArray(result.prompts)
        ? (result.prompts as McpPromptListResult["prompts"])
        : [],
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptGetResult> {
    const result = (await this.request("prompts/get", {
      name,
      ...(args !== undefined ? { arguments: args } : {}),
    })) as { description?: unknown; messages?: unknown };
    return {
      ...(typeof result.description === "string" ? { description: result.description } : {}),
      messages: Array.isArray(result.messages)
        ? (result.messages as McpPromptGetResult["messages"])
        : [],
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (reason?: unknown) => void;
    const closing = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveClose = resolvePromise;
      rejectClose = rejectPromise;
    });
    this.closePromise = closing;
    void this.closeInternal().then(resolveClose, rejectClose);
    return closing;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.connected = false;
    const closeError = new Error(`MCP server "${this.config.name}" 已关闭`);
    for (const controller of this.elicitationControllers) controller.abort(closeError);

    // 中止 SSE 流
    if (this.sseAbort) {
      this.sseAbort.abort();
    }
    const pending = [...this.pending.entries()];
    for (const controller of [...this.activeControllers]) controller.abort();
    for (const [id, request] of pending) {
      if (request.method === "tools/call") this.abortPendingRequest(id, closeError);
      else this.abortNonToolRequest(id, closeError);
    }
    // 不在 abort() 后立即假装完成：等所有本地 POST/stream 真正 settle。
    const transports = [...this.activeTransports];
    const abortTasks = pending
      .map(([, request]) => request.abortTask)
      .filter((task): task is Promise<void> => task !== undefined);
    await Promise.allSettled([...transports, ...abortTasks]);
    this.sseAbort = undefined;
    this.activeControllers.clear();
    for (const [id, request] of this.pending) {
      this.takePending(id);
      request.reject(closeError);
    }
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  // ---------- 内部实现 ----------

  private async initialize(): Promise<void> {
    const requestedVersion = this.options.elicitationHandler
      ? MCP_ELICITATION_PROTOCOL_VERSION
      : MCP_PROTOCOL_VERSION;
    const result = await this.request("initialize", {
      protocolVersion: requestedVersion,
      capabilities: this.options.elicitationHandler ? { elicitation: {} } : {},
      clientInfo: PICO_MCP_CLIENT_INFO,
    });
    const initialized = result as {
      protocolVersion?: unknown;
      serverInfo?: { name?: string; version?: string };
    };
    this.negotiatedProtocolVersion = supportedProtocolVersion(
      initialized.protocolVersion,
      requestedVersion,
    );
    const serverInfo = initialized.serverInfo;
    logger.info(
      { server: this.config.name, serverInfo },
      `[MCP] 握手成功: ${serverInfo?.name ?? "unknown"} v${serverInfo?.version ?? "?"}`,
    );
    // Streamable HTTP 不强制要求 initialized 通知,但发了无害;sse 通道下用 POST 发
    if (this.config.transport === "sse" && this.postEndpoint) {
      await this.sendHttpPost({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }).catch(() => {
        /* notification 失败不影响后续 */
      });
    } else {
      // http transport:尽力发 notification,失败静默
      await this.sendHttpPost({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }).catch(() => {});
    }
  }

  /**
   * 发送 JSON-RPC request 并等待响应。
   * - http:POST 本次请求,直接从响应体(JSON 或 SSE)拿结果。
   * - sse:POST 到 endpoint,响应走已建立的 SSE 流。
   */
  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP server "${this.config.name}" 已关闭`));
    }
    signal?.throwIfAborted();
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = this.config.toolTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutError = new Error(
          `MCP server "${this.config.name}" 请求 ${method} 超时(${timeoutMs}ms)`,
        );
        if (method === "tools/call") this.abortPendingRequest(id, timeoutError);
        else this.abortNonToolRequest(id, timeoutError);
      }, timeoutMs);

      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        timer,
        controller,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        pending.abortListener = () => this.abortPendingRequest(id, abortReason(signal));
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      if (signal?.aborted) {
        pending.abortListener?.();
        return;
      }

      const send = this.config.transport === "sse" ? this.postEndpoint : undefined;
      // http:sendHttpPost 会从响应体直接 resolve;sse:仅 POST,响应走 SSE 流
      pending.transport = this.performRequest(id, req, send, controller);
    });
  }

  private async performRequest(
    id: number,
    request: JsonRpcRequest,
    targetUrl: string | undefined,
    controller: AbortController,
  ): Promise<void> {
    try {
      const directResult = await this.sendHttpPost(request, targetUrl, controller);
      const pending = this.pending.get(id);
      if (!pending || pending.abortReason || directResult === undefined) return;
      this.takePending(id);
      if (directResult.error) {
        pending.reject(
          new Error(`MCP server "${this.config.name}" 返回错误: ${directResult.error.message}`),
        );
      } else {
        pending.resolve(directResult.result);
      }
    } catch (err) {
      const pending = this.pending.get(id);
      // abort 路径由 finishAbortedRequest 在 transport 真正 settle 后统一拒绝。
      if (!pending || pending.abortReason) return;
      this.takePending(id);
      pending.reject(
        new Error(
          redactSensitiveText(
            `MCP server "${this.config.name}" 发送请求失败: ${errorMessage(err)}`,
          ),
        ),
      );
    }
  }

  private abortPendingRequest(id: number, reason: Error): void {
    const pending = this.pending.get(id);
    if (!pending || pending.abortReason) return;
    pending.abortReason = reason;
    clearTimeout(pending.timer);
    pending.abortTask = this.finishAbortedRequest(id, pending, reason);
  }

  /** initialize/list 等无文件副作请求只需立即中止本地 IO。 */
  private abortNonToolRequest(id: number, reason: Error): void {
    const pending = this.takePending(id);
    if (!pending) return;
    pending.controller.abort(reason);
    pending.reject(reason);
  }

  private async finishAbortedRequest(
    id: number,
    pending: PendingRequest,
    reason: Error,
  ): Promise<void> {
    // 先启动协议取消，再中止原 fetch/stream；两者都真正 settle 后才 reject。
    const cancellation = this.sendCancellation(id, reason);
    pending.controller.abort(reason);
    await pending.transport?.catch(() => {});
    await cancellation;
    const current = this.takePending(id);
    current?.reject(reason);
  }

  private async sendCancellation(requestId: number, reason: Error): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CANCELLATION_POST_TIMEOUT_MS);
    try {
      await this.sendHttpPost(
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId, reason: reason.message },
        },
        this.config.transport === "sse" ? this.postEndpoint : undefined,
        controller,
        true,
      );
    } catch (err) {
      logger.debug(
        { server: this.config.name, err: errorMessage(err) },
        `[MCP] HTTP cancellation notification 未获得响应`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST 一个 JSON-RPC 消息。
   * @param targetUrl 目标地址;sse 模式用 server 告知的 endpoint,http 模式就是 config.url
   * @returns http 模式返回解析后的 JsonRpcResponse;sse 模式返回 undefined(响应走 SSE 流)
   */
  private sendHttpPost(
    msg: OutgoingJsonRpcMessage,
    targetUrl?: string,
    controller = new AbortController(),
    allowWhileClosing = false,
  ): Promise<JsonRpcResponse | undefined> {
    if (this.closed && !allowWhileClosing) {
      return Promise.reject(new Error(`MCP server "${this.config.name}" 已关闭`));
    }
    return this.trackTransport(this.sendHttpPostInternal(msg, targetUrl, controller));
  }

  private async sendHttpPostInternal(
    msg: OutgoingJsonRpcMessage,
    targetUrl: string | undefined,
    controller: AbortController,
  ): Promise<JsonRpcResponse | undefined> {
    const url = targetUrl ?? this.config.url!;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.config.headers ?? {}),
      ...(this.negotiatedProtocolVersion === MCP_ELICITATION_PROTOCOL_VERSION
        ? { "MCP-Protocol-Version": this.negotiatedProtocolVersion }
        : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };

    try {
      this.activeControllers.add(controller);
      const res = await this.fetchSameOrigin(url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if ("method" in msg && msg.method === "initialize") {
        this.sessionId = res.headers.get("mcp-session-id") ?? undefined;
      }
      if (!("method" in msg) || res.status === 202 || res.status === 204) {
        await cancelResponseBody(res);
        return undefined;
      }

      const contentType = res.headers.get("content-type") ?? "";

      // SSE 响应:读流直到拿到对应 id 的 response
      if (contentType.includes("text/event-stream")) {
        return await this.readSseResponse(res, msg);
      }

      // JSON 响应:直接解析
      if (contentType.includes("application/json")) {
        const text = await readLimitedResponseText(
          res,
          MAX_HTTP_RESPONSE_BYTES,
          `MCP server "${this.config.name}" JSON 响应`,
        );
        try {
          return JSON.parse(text) as JsonRpcResponse;
        } catch {
          throw new Error(`MCP server "${this.config.name}" 返回无法解析的 JSON 响应`);
        }
      }

      // 兜底:当纯文本解析
      const text = await readLimitedResponseText(
        res,
        MAX_HTTP_RESPONSE_BYTES,
        `MCP server "${this.config.name}" 文本响应`,
      );
      try {
        return JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new Error(
          `MCP server "${this.config.name}" 返回无法解析的响应: ${text.slice(0, 200)}`,
        );
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * 从 HTTP 响应的 SSE 流中读取,直到拿到匹配本次请求 id 的 response。
   * (适用于 http transport 的 SSE 响应模式)
   */
  private async readSseResponse(
    res: Response,
    msg: OutgoingJsonRpcMessage,
  ): Promise<JsonRpcResponse | undefined> {
    const body = res.body;
    const wantId = "id" in msg ? msg.id : undefined;
    if (!body) {
      if (wantId !== undefined) {
        throw new Error(`missing response id ${String(wantId)} in HTTP SSE response`);
      }
      return undefined;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_HTTP_RESPONSE_BYTES) {
          throw new Error(
            `MCP server "${this.config.name}" HTTP SSE 响应超过 ${MAX_HTTP_RESPONSE_BYTES} 字节上限`,
          );
        }
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = findSseSeparator(buffer)) !== -1) {
          const separatorLength = sseSeparatorLength(buffer, sep);
          const eventBlock = buffer.slice(0, sep);
          buffer = buffer.slice(sep + separatorLength);
          assertByteLimit(eventBlock, MAX_SSE_EVENT_BYTES, "HTTP SSE 事件");
          const parsed = this.parseSseEvent(eventBlock);
          if (parsed !== null && "method" in parsed && parsed.id !== undefined) {
            void this.handleServerRequest(parsed as JsonRpcRequest);
          } else if (parsed !== null && parsed.id === wantId) {
            return parsed as JsonRpcResponse;
          }
        }
        assertByteLimit(buffer, MAX_SSE_BUFFER_BYTES, "HTTP SSE 累计缓冲区");
      }
      if (wantId !== undefined) {
        throw new Error(`missing response id ${String(wantId)} in HTTP SSE response`);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return undefined;
  }

  /** 解析一个 SSE 事件块(以空行分隔),提取 data 里的 JSON-RPC 消息 */
  private parseSseEvent(block: string): (JsonRpcRequest | JsonRpcResponse) | null {
    const lines = splitSseLines(block);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return null;
    try {
      const msg = JSON.parse(dataLines.join("\n")) as JsonRpcRequest | JsonRpcResponse;
      return msg;
    } catch {
      return null;
    }
  }

  /**
   * sse transport:建立持久 SSE 连接,持续读流并把 response 派发给 pending。
   * 首个 `endpoint` 事件告知 POST 地址。
   */
  private async startSseStream(): Promise<void> {
    this.sseAbort = new AbortController();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.config.headers ?? {}),
    };

    // 不 await:读流是无限循环,只在 endpoint 到达后 resolve
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const stream = this.fetchSameOrigin(this.config.url!, {
        method: "GET",
        headers,
        signal: this.sseAbort!.signal,
      })
        .then(async (res) => {
          if (!res.ok || !res.body) {
            rejectReady(new Error(`SSE 连接失败: HTTP ${res.status}`));
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value.byteLength > MAX_HTTP_RESPONSE_BYTES) {
                throw new Error(`SSE 输入块超过 ${MAX_HTTP_RESPONSE_BYTES} 字节上限`);
              }
              buffer += decoder.decode(value, { stream: true });
              let sep: number;
              while ((sep = findSseSeparator(buffer)) !== -1) {
                const separatorLength = sseSeparatorLength(buffer, sep);
                const eventBlock = buffer.slice(0, sep);
                buffer = buffer.slice(sep + separatorLength);
                assertByteLimit(eventBlock, MAX_SSE_EVENT_BYTES, "SSE 事件");
                this.handleSseEvent(eventBlock, resolveReady);
              }
              assertByteLimit(buffer, MAX_SSE_BUFFER_BYTES, "SSE 累计缓冲区");
            }
          } catch (err) {
            const safeError = new Error(
              redactSensitiveText(
                `SSE 流中断: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
            rejectReady(safeError);
            if (!this.closed) {
              this.failAllPending(safeError);
              this.emitError(safeError);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
            rejectReady(
              new Error(
                this.closed
                  ? `MCP server "${this.config.name}" 已关闭`
                  : `MCP server "${this.config.name}" SSE 流在 endpoint 就绪前已关闭`,
              ),
            );
            if (!this.closed && this.connected) {
              this.emitClose(new Error(`MCP server "${this.config.name}" SSE 流已关闭`));
            }
          }
        })
        .catch((err) => {
          const safeError = new Error(
            redactSensitiveText(
              `SSE 连接失败: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          rejectReady(safeError);
          if (!this.closed) {
            this.emitError(safeError);
          }
        });
      this.trackTransport(stream);
    });

    // 等 endpoint 事件到达(带超时)
    const timeoutMs = this.config.startupTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            this.sseAbort?.abort();
            reject(new Error(`等待 SSE endpoint 事件超时`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 处理 SSE 事件块:endpoint 事件设 POST 地址;message 事件派发给 pending */
  private handleSseEvent(block: string, onEndpoint: () => void): void {
    const lines = splitSseLines(block);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (event === "endpoint" && dataLines.length > 0) {
      // endpoint 事件:data 是 POST 地址(可能相对 URL)
      this.postEndpoint = this.resolveSameOriginUrl(dataLines[0]!);
      onEndpoint();
      return;
    }
    if (dataLines.length === 0) return;
    try {
      const msg = JSON.parse(dataLines.join("\n")) as JsonRpcRequest | JsonRpcResponse;
      if ("method" in msg && msg.id !== undefined) {
        void this.handleServerRequest(msg);
      } else if (msg.id !== undefined) {
        this.resolvePending(msg as JsonRpcResponse);
      }
    } catch {
      /* 忽略无法解析的事件 */
    }
  }

  private resolvePending(response: JsonRpcResponse): void {
    if (typeof response.id !== "number") return;
    const id = response.id;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.abortReason) return;
    this.takePending(id);
    if (response.error) {
      pending.reject(
        new Error(`MCP server "${this.config.name}" 返回错误: ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    let response: JsonRpcResponse;
    if (request.method !== "elicitation/create") {
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: JsonRpcErrorCode.METHOD_NOT_FOUND, message: "Method not found" },
      };
    } else if (
      this.negotiatedProtocolVersion !== MCP_ELICITATION_PROTOCOL_VERSION ||
      !this.options.elicitationHandler ||
      !this.associatedRequest()
    ) {
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: JsonRpcErrorCode.INVALID_REQUEST, message: "Elicitation unavailable" },
      };
    } else if (this.elicitationControllers.size >= MAX_CONCURRENT_ELICITATIONS) {
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: JsonRpcErrorCode.INTERNAL_ERROR, message: "Too many elicitations" },
      };
    } else {
      const parsed = parseElicitationRequest(request.params);
      if (!parsed) {
        response = {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: JsonRpcErrorCode.INVALID_PARAMS, message: "Invalid elicitation params" },
        };
      } else {
        const controller = new AbortController();
        const associatedSignal = this.associatedRequest()?.signal;
        const abortFromOrigin = (): void =>
          controller.abort(
            associatedSignal?.reason ?? new DOMException("Request aborted", "AbortError"),
          );
        associatedSignal?.addEventListener("abort", abortFromOrigin, { once: true });
        if (associatedSignal?.aborted) abortFromOrigin();
        this.elicitationControllers.add(controller);
        try {
          const result = normalizeElicitationResult(
            await this.options.elicitationHandler(parsed, {
              server: this.config.name,
              signal: controller.signal,
            }),
          );
          response = { jsonrpc: "2.0", id: request.id, result };
        } catch (error) {
          response = {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: JsonRpcErrorCode.INTERNAL_ERROR,
              message: redactSensitiveText(errorMessage(error)),
            },
          };
        } finally {
          associatedSignal?.removeEventListener("abort", abortFromOrigin);
          this.elicitationControllers.delete(controller);
        }
      }
    }
    if (this.closed) return;
    await this.sendHttpPost(
      response,
      this.config.transport === "sse" ? this.postEndpoint : undefined,
    ).catch((error) => {
      logger.warn(
        { server: this.config.name, err: errorMessage(error) },
        "[MCP] Elicitation 响应发送失败",
      );
    });
  }

  private associatedRequest(): PendingRequest | undefined {
    return [...this.pending.values()].find((pending) =>
      ["tools/call", "resources/read", "prompts/get"].includes(pending.method),
    );
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.abortReason && pending.abortTask) continue;
      this.takePending(id);
      pending.controller.abort();
      pending.reject(err);
    }
  }

  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    this.pending.delete(id);
    return pending;
  }

  private emitClose(err?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(err);
    }
  }

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) {
      handler(err);
    }
  }

  private trackTransport<T>(transport: Promise<T>): Promise<T> {
    this.activeTransports.add(transport);
    void transport.then(
      () => this.activeTransports.delete(transport),
      () => this.activeTransports.delete(transport),
    );
    return transport;
  }

  /** 把 SSE endpoint 解析成绝对 URL,并拒绝把凭据发到不同来源。 */
  private resolveSameOriginUrl(maybeRelative: string): string {
    const configured = parseHttpUrl(this.config.url!, this.config.name);
    let resolved: URL;
    try {
      resolved = new URL(maybeRelative, configured);
    } catch {
      throw new Error(`MCP server "${this.config.name}" 返回了无效的 SSE endpoint`);
    }
    if (resolved.origin !== configured.origin) {
      throw new Error(
        `拒绝 MCP server "${this.config.name}" 的跨源 SSE endpoint (${configured.origin} -> ${resolved.origin})`,
      );
    }
    return resolved.toString();
  }

  /**
   * Node fetch 默认会自动跟随重定向,且可能把自定义 Authorization 一并带走。
   * MCP transport 仅允许在配置 URL 的同一 origin 内跳转,并限制跳转次数。
   */
  private async fetchSameOrigin(url: string, init: RequestInit): Promise<Response> {
    const configured = parseHttpUrl(this.config.url!, this.config.name);
    let current = parseHttpUrl(url, this.config.name);
    if (current.origin !== configured.origin) {
      throw new Error(
        `拒绝 MCP server "${this.config.name}" 的跨源请求 (${configured.origin} -> ${current.origin})`,
      );
    }

    for (let redirectCount = 0; ; redirectCount++) {
      const response = await fetch(current, { ...init, redirect: "manual" });
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      if (redirectCount >= MAX_REDIRECTS) {
        await cancelResponseBody(response);
        throw new Error(`MCP server "${this.config.name}" 重定向超过 ${MAX_REDIRECTS} 次上限`);
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        await cancelResponseBody(response);
        throw new Error(`MCP server "${this.config.name}" 返回了无效的重定向地址`);
      }
      if (next.origin !== configured.origin) {
        await cancelResponseBody(response);
        throw new Error(
          `拒绝 MCP server "${this.config.name}" 的跨源重定向 (${configured.origin} -> ${next.origin})`,
        );
      }
      await cancelResponseBody(response);
      current = next;
    }
  }

  private normalizeTool(raw: unknown): McpTool {
    const t = raw as { name?: string; description?: string; inputSchema?: unknown };
    return {
      name: t.name ?? "",
      description: t.description ?? "",
      inputSchema:
        typeof t.inputSchema === "object" && t.inputSchema !== null
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object" },
    };
  }

  private normalizeToolResult(raw: unknown): McpToolResult {
    const r = raw as { content?: unknown; isError?: unknown };
    const content = Array.isArray(r.content) ? r.content : [];
    return {
      content: content as McpToolResult["content"],
      isError: r.isError === true,
    };
  }
}

function findSseSeparator(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function sseSeparatorLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

function splitSseLines(block: string): string[] {
  return block.split(/\r?\n/);
}

function parseHttpUrl(value: string, serverName: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported");
    return url;
  } catch {
    throw new Error(`MCP server "${serverName}" 的 URL 必须是有效的 http/https 地址`);
  }
}

function assertByteLimit(value: string, limit: number, label: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > limit) {
    throw new Error(`${label}超过 ${limit} 字节上限`);
  }
}

async function readLimitedResponseText(
  response: Response,
  limit: number,
  label: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
      await cancelResponseBody(response);
      throw new Error(`${label}声明的体积超过 ${limit} 字节上限`);
    }
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        throw new Error(`${label}超过 ${limit} 字节上限`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes,
  ).toString("utf8");
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("MCP tool call aborted", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function supportedProtocolVersion(value: unknown, fallback: string): string {
  const version = typeof value === "string" ? value : fallback;
  if (version === MCP_PROTOCOL_VERSION || version === MCP_ELICITATION_PROTOCOL_VERSION) {
    return version;
  }
  throw new Error(`MCP server 协商了不支持的协议版本: ${version}`);
}

function parseElicitationRequest(
  value: Record<string, unknown> | undefined,
): McpElicitationRequest | undefined {
  if (!value || typeof value.message !== "string" || value.message.length > 2_000) return undefined;
  if (value.mode !== undefined && value.mode !== "form") return undefined;
  if (
    typeof value.requestedSchema !== "object" ||
    value.requestedSchema === null ||
    Array.isArray(value.requestedSchema)
  ) {
    return undefined;
  }
  return {
    ...(value.mode === "form" ? { mode: "form" as const } : {}),
    message: value.message,
    requestedSchema: value.requestedSchema as Record<string, unknown>,
  };
}

function normalizeElicitationResult(result: McpElicitationResult): McpElicitationResult {
  if (result.action !== "accept" && result.action !== "decline" && result.action !== "cancel") {
    throw new Error("Elicitation handler 返回了非法 action");
  }
  if (result.action === "accept") {
    if (!result.content || typeof result.content !== "object" || Array.isArray(result.content)) {
      throw new Error("Elicitation accept 缺少 content");
    }
    return { action: "accept", content: result.content };
  }
  return { action: result.action };
}
