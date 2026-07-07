// Anthropic (Claude) 兼容协议适配器 (同声传译员)。
// 对应课程第 04 讲 internal/provider/claude.go。
//
// 与 OpenAI 适配器的关键差异:
// 1. system 是独立顶层字段,不在 messages 数组里
// 2. assistant 消息由 content blocks 组成 (text / tool_use)
// 3. 工具结果是 user 消息里的 tool_result block (非 role=tool)
// 4. 工具 Schema 需把 properties / required 分别填充进 input_schema

import type { LLMProvider } from "./interface.js";
import type { Message, ToolCall, ToolDefinition, Usage } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import { resolveProviderProfile, type ProviderProfile } from "./profile.js";
import { toAnthropicThinkingConfig, anthropicBudgetTokens, type ThinkingEffort } from "./thinking.js";
import { ContextOverflowError, isContextOverflowStatus, LLMStatusError } from "./errors.js";
import { applyAnthropicCacheControl } from "./anthropic-cache.js";
import { parseRateLimitHeaders } from "./ratelimit.js";
import { logger } from "../observability/logger.js";

/** Anthropic content block: 文本、图片或工具调用 */
type Block =
  | { type: "text"; text: string; cache_control?: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicResponse {
  content?: Block[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Anthropic (Claude) 兼容协议适配器 */
export class ClaudeProvider implements LLMProvider {
  private readonly profile: ProviderProfile;
  private readonly thinkingEffort: ThinkingEffort;

  constructor(
    private readonly config: ProviderConfig,
    profile?: ProviderProfile,
  ) {
    this.profile = profile ?? resolveProviderProfile("claude", config.model);
    this.thinkingEffort = config.thinkingEffort ?? "off";
  }

  get modelName(): string {
    return this.config.model;
  }

  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    // 1. 构建请求体(消息翻译 + 工具 schema + thinking + cache 注入)
    const body = this.buildRequestBody(messages, availableTools);

    // 2. 构建请求并发送
    const resp = await fetch(`${this.config.baseURL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // 2 分钟超时,防网络挂起永久阻塞
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`Claude API 上下文溢出 [${resp.status}]: ${text}`);
      }
      throw new LLMStatusError(resp.status, `Claude API 请求失败 [${resp.status}]: ${text}`);
    }

    // 限流信息回传:resp.ok 成功后解析 RateLimit header,命中即回调
    if (this.config.onRateLimitInfo) {
      const info = parseRateLimitHeaders(resp.headers);
      if (info) this.config.onRateLimitInfo(info);
    }

    const data = (await resp.json()) as AnthropicResponse;
    if (!data.content || data.content.length === 0) {
      throw new Error("API 返回了空的 content");
    }

    // 3. 反向翻译:content blocks → 内部 schema.Message
    return this.translateContentBlocks(data.content, data.usage);
  }

  /**
   * 流式生成:与非流式 generate 行为一致,但每收到一段文本就调 onDelta 回调。
   * 通过 SSE (Server-Sent Events) 解析 Anthropic 的流式响应。
   *
   * Anthropic 流式协议关键事件:
   * - message_start:含初始 message 对象(usage.input_tokens)
   * - content_block_start:开始一个 content block(text / tool_use 带 id+name)
   * - content_block_delta:block 增量(text_delta → onDelta;input_json_delta → 累积 tool input)
   * - content_block_stop:block 结束
   * - message_delta:消息级更新(usage.output_tokens + stop_reason)
   * - message_stop:流结束
   * - ping:心跳,忽略
   * - error:服务端错误
   */
  async generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
  ): Promise<Message> {
    // 1. 构建请求体(与 generate 共用,加 stream: true)
    const body = this.buildRequestBody(messages, availableTools);
    body.stream = true;

    // 2. 构建请求并发送
    const resp = await fetch(`${this.config.baseURL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`Claude API 上下文溢出 [${resp.status}]: ${text}`);
      }
      throw new LLMStatusError(resp.status, `Claude API 流式请求失败 [${resp.status}]: ${text}`);
    }

    // 限流信息回传:resp.ok 成功后解析 RateLimit header,命中即回调
    if (this.config.onRateLimitInfo) {
      const info = parseRateLimitHeaders(resp.headers);
      if (info) this.config.onRateLimitInfo(info);
    }

    if (!resp.body) {
      throw new Error("流式响应没有 body");
    }

    // 3. 解析 SSE 流
    // tool_use block 累积器:按 content_block 的 index 存 { id, name, input 累积字符串 }
    const toolUseAccumulator = new Map<
      number,
      { id: string; name: string; inputParts: string[] }
    >();
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以 \n\n 分隔事件
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? ""; // 最后一个可能不完整,留到下次

      for (const event of events) {
        this.handleSseEvent(event, {
          onDelta,
          toolUseAccumulator,
          onText: (text) => {
            fullContent += text;
          },
          onInputTokens: (n) => {
            inputTokens = n;
          },
          onOutputTokens: (n) => {
            outputTokens = n;
          },
          onCacheWrite: (n) => {
            cacheWriteTokens = n;
          },
          onCacheRead: (n) => {
            cacheReadTokens = n;
          },
        });
      }
    }

    // 4. 组装最终 Message:tool_use block 按 index 顺序还原为 ToolCall
    const toolCalls: ToolCall[] = [];
    const sortedIndices = [...toolUseAccumulator.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const acc = toolUseAccumulator.get(idx)!;
      const rawInput = acc.inputParts.join("");
      // input 累积可能为空(模型只发了 content_block_start 没发 delta),兜底 {}
      let inputObj: unknown;
      try {
        inputObj = rawInput === "" ? {} : JSON.parse(rawInput);
      } catch {
        inputObj = {};
      }
      toolCalls.push({
        id: acc.id,
        name: acc.name,
        arguments: JSON.stringify(inputObj),
      });
    }

    const usage: Usage | undefined =
      inputTokens > 0 || outputTokens > 0 || cacheWriteTokens > 0 || cacheReadTokens > 0
        ? {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            cacheWriteTokens,
            cacheReadTokens,
          }
        : undefined;

    return {
      role: "assistant",
      content: fullContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  /**
   * 构建 Anthropic 请求体(消息翻译 + 工具 schema + thinking + prompt cache 注入)。
   * generate 与 generateStream 共用,避免两份重复代码。
   */
  private buildRequestBody(
    messages: Message[],
    availableTools: ToolDefinition[],
  ): Record<string, unknown> {
    let systemPrompt = "";
    const anthropicMsgs: { role: "user" | "assistant"; content: Block[] }[] = [];

    // 1. 消息翻译
    for (const msg of messages) {
      switch (msg.role) {
        case "system":
          // Claude: system 是独立顶层字段
          systemPrompt = msg.content;
          break;
        case "user": {
          if (msg.toolCallId) {
            // 工具观察结果:user 消息里的 tool_result block
            anthropicMsgs.push({
              role: "user",
              content: [{ type: "tool_result", tool_use_id: msg.toolCallId, content: msg.content }],
            });
          } else {
            // 5.5 Image/Media:图片翻译为 Anthropic image block(Claude 仅支持 base64,不支持 URL)。
            // 多模态约定:image block 在前、text block 在后,符合 Claude 文档推荐顺序。
            const blocks: Block[] = [];
            for (const img of msg.images ?? []) {
              if (img.type === "image_base64") {
                blocks.push({
                  type: "image",
                  source: { type: "base64", media_type: img.mimeType, data: img.data },
                });
              } else {
                // Claude 不支持纯 URL 图片,极简处理:报错提示用 base64。
                throw new Error("Claude 不支持 image_url,请用 image_base64");
              }
            }
            blocks.push({ type: "text", text: msg.content });
            anthropicMsgs.push({ role: "user", content: blocks });
          }
          break;
        }
        case "assistant": {
          const blocks: Block[] = [];
          if (msg.content) {
            blocks.push({ type: "text", text: msg.content });
          }
          // 历史工具调用 → tool_use block,input 需解析成对象
          for (const tc of msg.toolCalls ?? []) {
            let input: unknown;
            try {
              input = JSON.parse(tc.arguments);
            } catch {
              input = {};
            }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
          }
          if (blocks.length > 0) {
            anthropicMsgs.push({ role: "assistant", content: blocks });
          }
          break;
        }
      }
    }

    // 2. 工具 Schema 翻译:properties / required 分别填充
    // 统一思考强度:先算 budget,再据此保护 max_tokens(Anthropic 要求 max_tokens > budget_tokens)
    const thinkingConfig = toAnthropicThinkingConfig(this.thinkingEffort);
    const budgetTokens = anthropicBudgetTokens(this.thinkingEffort);
    const maxTokens = thinkingConfig
      ? Math.max(this.profile.maxOutputTokens, budgetTokens + 1024)
      : this.profile.maxOutputTokens;

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: maxTokens,
      messages: anthropicMsgs,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (thinkingConfig) body.thinking = thinkingConfig;
    // 慢思考支撑:availableTools 为空时不挂载 tools
    if (availableTools.length > 0) {
      body.tools = availableTools.map((t) => {
        const schema = t.inputSchema as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        return {
          name: t.name,
          description: t.description,
          input_schema: {
            type: "object",
            properties: schema.properties ?? {},
            required: schema.required ?? [],
          },
        };
      });
    }

    // 3. Anthropic Prompt Cache:在 system/tools/历史前缀尾注入 cache_control 断点,
    // 命中后 cache_read 输入单价降至约 1/10,长会话输入成本可降 ~75%(对标 hermes)。
    // 仅当模型 profile 声明支持 prompt cache 时启用,避免不支持该特性的兼容端点报错。
    if (this.profile.supportsPromptCache) {
      const breakpoints = applyAnthropicCacheControl(body, true);
      if (breakpoints > 0) {
        logger.debug(
          { model: this.config.model, breakpoints },
          `[Claude] 注入 ${breakpoints} 个 prompt cache 断点`,
        );
      }
    }

    return body;
  }

  /**
   * 反向翻译:Anthropic content blocks → 内部 schema.Message。
   * generate(非流式)使用,流式则在解析过程中增量累积。
   */
  private translateContentBlocks(
    content: Block[],
    usage?: AnthropicResponse["usage"],
  ): Message {
    let textContent = "";
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    const normalizedUsage =
      usage &&
      (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number")
        ? {
            promptTokens: usage.input_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          }
        : undefined;

    return {
      role: "assistant",
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: normalizedUsage,
    };
  }

  /**
   * 处理单个 SSE 事件块(已被 \n\n 切分)。
   * 解析 event 类型行 + data 行,按 Anthropic 流式协议分发到回调。
   */
  private handleSseEvent(
    event: string,
    handlers: {
      onDelta: (delta: string) => void;
      toolUseAccumulator: Map<number, { id: string; name: string; inputParts: string[] }>;
      onText: (text: string) => void;
      onInputTokens: (n: number) => void;
      onOutputTokens: (n: number) => void;
      onCacheWrite: (n: number) => void;
      onCacheRead: (n: number) => void;
    },
  ): void {
    // 一个事件块可能含多行(event: / data:),提取出 data JSON 与 event 类型
    const lines = event.split("\n");
    let dataJson = "";
    let eventType = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataJson = line.slice(6);
      } else if (line.startsWith("data:")) {
        // 容错:无空格前缀
        dataJson = line.slice(5);
      }
    }

    if (!dataJson) return;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataJson) as Record<string, unknown>;
    } catch {
      // 无法解析的数据行,跳过
      return;
    }

    // 兼容:优先用 payload.type(event 行缺失时),再用 event 行
    const type = (payload.type as string) || eventType;

    switch (type) {
      case "message_start": {
        const message = payload.message as
          | { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }
          | undefined;
        const u = message?.usage;
        if (u) {
          if (typeof u.input_tokens === "number") handlers.onInputTokens(u.input_tokens);
          if (typeof u.cache_creation_input_tokens === "number")
            handlers.onCacheWrite(u.cache_creation_input_tokens);
          if (typeof u.cache_read_input_tokens === "number")
            handlers.onCacheRead(u.cache_read_input_tokens);
        }
        break;
      }
      case "content_block_start": {
        const index = payload.index as number;
        const block = payload.content_block as
          | { type: string; id?: string; name?: string }
          | undefined;
        if (block?.type === "tool_use" && block.id && block.name) {
          handlers.toolUseAccumulator.set(index, {
            id: block.id,
            name: block.name,
            inputParts: [],
          });
        }
        break;
      }
      case "content_block_delta": {
        const index = payload.index as number;
        const delta = payload.delta as
          | { type: string; text?: string; partial_json?: string }
          | undefined;
        if (!delta) break;
        if (delta.type === "text_delta" && delta.text) {
          handlers.onText(delta.text);
          handlers.onDelta(delta.text);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const acc = handlers.toolUseAccumulator.get(index);
          if (acc) {
            acc.inputParts.push(delta.partial_json);
          }
        }
        break;
      }
      case "content_block_stop":
        // block 结束,无需特殊处理(累积在 content_block_delta 完成)
        break;
      case "message_delta": {
        const usage = payload.usage as { output_tokens?: number } | undefined;
        if (typeof usage?.output_tokens === "number") {
          handlers.onOutputTokens(usage.output_tokens);
        }
        break;
      }
      case "message_stop":
        // 流结束,无需特殊处理
        break;
      case "ping":
        // 心跳,忽略
        break;
      case "error": {
        const err = payload.error as { message?: string; type?: string } | undefined;
        const errMsg = err?.message ?? err?.type ?? "未知 Anthropic 流式错误";
        throw new Error(`Claude 流式错误: ${errMsg}`);
      }
      default:
        // 未知事件类型,忽略(向前兼容未来新增事件)
        break;
    }
  }
}
