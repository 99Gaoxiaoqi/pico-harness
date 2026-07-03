// Anthropic (Claude) 兼容协议适配器 (同声传译员)。
// 对应课程第 04 讲 internal/provider/claude.go。
//
// 与 OpenAI 适配器的关键差异:
// 1. system 是独立顶层字段,不在 messages 数组里
// 2. assistant 消息由 content blocks 组成 (text / tool_use)
// 3. 工具结果是 user 消息里的 tool_result block (非 role=tool)
// 4. 工具 Schema 需把 properties / required 分别填充进 input_schema

import type { LLMProvider } from "./interface.js";
import type { Message, ToolCall, ToolDefinition } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import { resolveProviderProfile, type ProviderProfile } from "./profile.js";
import { toAnthropicThinkingConfig, anthropicBudgetTokens, type ThinkingEffort } from "./thinking.js";
import { ContextOverflowError, isContextOverflowStatus, LLMStatusError } from "./errors.js";
import { applyAnthropicCacheControl } from "./anthropic-cache.js";
import { logger } from "../observability/logger.js";

/** Anthropic content block: 文本或工具调用 */
type Block =
  | { type: "text"; text: string; cache_control?: unknown }
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
            anthropicMsgs.push({
              role: "user",
              content: [{ type: "text", text: msg.content }],
            });
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

    // 3. 构建请求并发送
    // Anthropic Prompt Cache:在 system/tools/历史前缀尾注入 cache_control 断点,
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

    const data = (await resp.json()) as AnthropicResponse;
    if (!data.content || data.content.length === 0) {
      throw new Error("API 返回了空的 content");
    }

    // 4. 反向翻译:content blocks → 内部 schema.Message
    let textContent = "";
    const toolCalls: ToolCall[] = [];
    for (const block of data.content) {
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

    const usage =
      data.usage &&
      (typeof data.usage.input_tokens === "number" || typeof data.usage.output_tokens === "number")
        ? {
            promptTokens: data.usage.input_tokens ?? 0,
            completionTokens: data.usage.output_tokens ?? 0,
            cacheWriteTokens: data.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
          }
        : undefined;

    return {
      role: "assistant",
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }
}
