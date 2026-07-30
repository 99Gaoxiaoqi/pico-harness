// Google (Gemini) 原生协议适配器 (同声传译员)。
//
// 与 OpenAI / Claude 协议的关键差异:
// 1. API key 在 x-goog-api-key header,不进入 URL/query
// 2. 端点形如 {baseURL}/v1beta/models/{model}:generateContent
//    流式端点 :streamGenerateContent?alt=sse
// 3. system 是顶层 system_instruction.parts[{text}],不在 contents 里
// 4. 消息用 contents: [{role: "user"/"model", parts: [...]}]
//    (Gemini 用 "model" 不用 "assistant")
// 5. 工具用 tools: [{functionDeclarations: [{name, description, parameters}]}]
//    parameters 即标准 JSON Schema
// 6. 工具调用响应:candidate 的 content.parts 里含 {functionCall: {name, args}}
//    args 是对象,不是 JSON 字符串
// 7. 工具结果回传:user 消息的 parts 里含 {functionResponse: {name, response: {...}}}

import {
  providerRequestSignal,
  type LLMProvider,
  type LLMProviderRequestOptions,
} from "./interface.js";
import type { Message, ToolCall, ToolDefinition, Usage } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import { resolveProviderProfile, type ProviderProfile } from "./profile.js";
import { ContextOverflowError, isContextOverflowStatus, LLMStatusError } from "./errors.js";
import { parseRateLimitHeaders } from "./ratelimit.js";
import { applyReasoningRequestPatch } from "./reasoning-capability.js";
import {
  GeminiPromptCacheController,
  type GeminiPromptCacheStore,
  type GeminiPromptCacheTransport,
} from "./gemini-prompt-cache.js";

/** Gemini content part:文本 / 工具调用 / 工具响应 */
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    toolUsePromptTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export interface GeminiProviderDependencies {
  /** Workspace-owned metadata store. It never receives prompts or credentials. */
  readonly promptCacheStore?: GeminiPromptCacheStore;
  /** Injectable only for integration tests; production uses the native REST transport. */
  readonly promptCacheTransport?: GeminiPromptCacheTransport;
  readonly now?: () => number;
  /** Set only after the native cachedContents spike has passed for this route. Defaults false. */
  readonly enableExplicitPromptCache?: boolean;
}

/** Google (Gemini) 原生协议适配器 */
export class GeminiProvider implements LLMProvider {
  private readonly profile: ProviderProfile;
  private readonly promptCache?: GeminiPromptCacheController;
  private readonly cacheWriteTokensByBody = new WeakMap<object, number>();

  constructor(
    private readonly config: ProviderConfig,
    profile?: ProviderProfile,
    dependencies: GeminiProviderDependencies = {},
  ) {
    this.profile = profile ?? resolveProviderProfile("gemini", config.model);
    if (
      dependencies.enableExplicitPromptCache === true &&
      config.capabilities?.cache !== false &&
      config.capabilities?.promptCache.mode === "explicit"
    ) {
      this.promptCache = new GeminiPromptCacheController({
        store: dependencies.promptCacheStore,
        transport: dependencies.promptCacheTransport ?? this.createPromptCacheTransport(),
        baseURL: config.baseURL,
        model: config.model,
        ttlSeconds: ttlSeconds(config.capabilities.promptCache.ttl),
        ...(dependencies.now ? { now: dependencies.now } : {}),
      });
      void this.promptCache.cleanupExpiredEntries();
    }
  }

  get modelName(): string {
    return this.config.model;
  }

  /** 拼装非流式 generateContent 端点；凭证仅放 x-goog-api-key header。 */
  private generateUrl(): string {
    const base = this.config.baseURL.replace(/\/+$/, "");
    return `${base}/v1beta/models/${this.config.model}:generateContent`;
  }

  /** 拼装流式 streamGenerateContent 端点(alt=sse,凭证仅在 header)。 */
  private streamUrl(): string {
    const base = this.config.baseURL.replace(/\/+$/, "");
    return `${base}/v1beta/models/${this.config.model}:streamGenerateContent?alt=sse`;
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const body = await this.buildRequestBody(messages, availableTools);
    const cacheWriteTokens = this.cacheWriteTokensByBody.get(body);
    options?.onRequestPrepared?.({
      provider: "gemini",
      model: this.config.model,
      body,
    });

    let resp = await fetch(this.generateUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: providerRequestSignal(options?.signal),
    });

    if (!resp.ok && body["cachedContent"] !== undefined) {
      await resp.body?.cancel().catch(() => undefined);
      if (isRejectedCachedContentStatus(resp.status)) {
        await this.promptCache?.invalidateName(String(body["cachedContent"]));
      }
      const fallback = await this.buildRequestBody(messages, availableTools, false);
      options?.onRequestPrepared?.({
        provider: "gemini",
        model: this.config.model,
        body: fallback,
      });
      resp = await fetch(this.generateUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(fallback),
        signal: providerRequestSignal(options?.signal),
      });
    }

    if (!resp.ok) {
      const text = await resp.text();
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`Gemini API 上下文溢出 [${resp.status}]: ${text}`);
      }
      throw new LLMStatusError(resp.status, `Gemini API 请求失败 [${resp.status}]: ${text}`);
    }

    // 限流信息回传:resp.ok 成功后解析 RateLimit header,命中即回调
    if (this.config.onRateLimitInfo) {
      const info = parseRateLimitHeaders(resp.headers);
      if (info) this.config.onRateLimitInfo(info);
    }

    const data = (await resp.json()) as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new Error("Gemini API 返回了空的 candidates/parts");
    }
    return this.withCacheWriteUsage(
      this.translateParts(parts, data.usageMetadata),
      cacheWriteTokens,
    );
  }

  /**
   * 流式生成:请求 streamGenerateContent(alt=sse),解析 SSE。
   * Gemini 流式协议:每条 data 是一个 candidate 增量,
   * candidate.content.parts 里含 text / functionCall。text 即时转发 onDelta,
   * functionCall 按出现顺序保留为独立调用。
   */
  async generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const body = await this.buildRequestBody(messages, availableTools);
    const cacheWriteTokens = this.cacheWriteTokensByBody.get(body);
    options?.onRequestPrepared?.({
      provider: "gemini",
      model: this.config.model,
      body,
    });

    let resp = await fetch(this.streamUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: providerRequestSignal(options?.signal),
    });

    if (!resp.ok && body["cachedContent"] !== undefined) {
      await resp.body?.cancel().catch(() => undefined);
      if (isRejectedCachedContentStatus(resp.status)) {
        await this.promptCache?.invalidateName(String(body["cachedContent"]));
      }
      const fallback = await this.buildRequestBody(messages, availableTools, false);
      options?.onRequestPrepared?.({
        provider: "gemini",
        model: this.config.model,
        body: fallback,
      });
      resp = await fetch(this.streamUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(fallback),
        signal: providerRequestSignal(options?.signal),
      });
    }

    if (!resp.ok) {
      const text = await resp.text();
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`Gemini API 上下文溢出 [${resp.status}]: ${text}`);
      }
      throw new LLMStatusError(resp.status, `Gemini API 流式请求失败 [${resp.status}]: ${text}`);
    }

    // 限流信息回传:resp.ok 成功后解析 RateLimit header,命中即回调
    if (this.config.onRateLimitInfo) {
      const info = parseRateLimitHeaders(resp.headers);
      if (info) this.config.onRateLimitInfo(info);
    }

    if (!resp.body) {
      throw new Error("流式响应没有 body");
    }

    // 解析 SSE 流
    let fullContent = "";
    const toolCalls: ToolCall[] = [];
    let usage: Usage | undefined;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以 \n\n 分隔事件
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const lines = event.split("\n");
        for (const line of lines) {
          const data = line.startsWith("data: ")
            ? line.slice(6)
            : line.startsWith("data:")
              ? line.slice(5)
              : null;
          if (!data || data === "[DONE]") continue;

          let chunk: GeminiResponse;
          try {
            chunk = JSON.parse(data) as GeminiResponse;
          } catch {
            continue;
          }

          // usageMetadata 通常在最后一个 chunk,优先取
          if (chunk.usageMetadata) {
            usage = this.translateUsage(chunk.usageMetadata);
          }

          const parts = chunk.candidates?.[0]?.content?.parts;
          if (!parts) continue;
          for (const part of parts) {
            if (part.text) {
              fullContent += part.text;
              onDelta(part.text);
            } else if (part.functionCall?.name) {
              toolCalls.push({
                id: `gemini-call-${toolCalls.length}`,
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              });
            }
          }
        }
      }
    }

    return this.withCacheWriteUsage(
      {
        role: "assistant",
        content: fullContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
      },
      cacheWriteTokens,
    );
  }

  /**
   * 构建 Gemini 请求体(contents 翻译 + tools + system_instruction + generationConfig)。
   * generate 与 generateStream 共用。
   */
  private async buildRequestBody(
    messages: Message[],
    availableTools: ToolDefinition[],
    useExplicitCache = true,
  ): Promise<Record<string, unknown>> {
    let systemPrompt = "";
    const contents: GeminiContent[] = [];
    const toolCallNames = new Map<string, string>();

    for (const msg of messages) {
      switch (msg.role) {
        case "system":
          systemPrompt = msg.content;
          break;
        case "user": {
          if (msg.toolCallId) {
            // 工具观察结果:user 消息里的 functionResponse part
            // 注:Gemini 的 functionResponse.response 是对象,这里把工具输出字符串包成 {result}
            // (Gemini 不要求 response 一定匹配工具 schema,任意对象均可)
            const functionName = toolCallNames.get(msg.toolCallId) ?? msg.toolCallId;
            contents.push({
              role: "user",
              parts: [
                { functionResponse: { name: functionName, response: { result: msg.content } } },
              ],
            });
          } else {
            // 5.5d 多模态:user 消息可携带 images → Gemini inlineData(仅 base64)
            const parts: GeminiPart[] = [];
            for (const img of msg.images ?? []) {
              if (img.type === "image_base64") {
                parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } } as never);
              } else {
                throw new Error("Gemini inlineData 不支持 image_url,请用 image_base64");
              }
            }
            parts.push({ text: msg.content });
            contents.push({ role: "user", parts });
          }
          break;
        }
        case "assistant": {
          // assistant → role: "model"
          const parts: GeminiPart[] = [];
          if (msg.content) {
            parts.push({ text: msg.content });
          }
          // 历史工具调用 → functionCall part(args 是对象)
          for (const tc of msg.toolCalls ?? []) {
            toolCallNames.set(tc.id, tc.name);
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.arguments) as Record<string, unknown>;
            } catch {
              args = {};
            }
            parts.push({ functionCall: { name: tc.name, args } });
          }
          if (parts.length > 0) {
            contents.push({ role: "model", parts });
          }
          break;
        }
      }
    }

    const body: Record<string, unknown> = { contents };
    if (systemPrompt) {
      body.system_instruction = { parts: [{ text: systemPrompt }] };
    }
    // 无可用工具时不挂载 tools
    if (availableTools.length > 0) {
      body.tools = [
        {
          functionDeclarations: availableTools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }
    body.generationConfig = { maxOutputTokens: this.profile.maxOutputTokens };
    const capability = this.config.capabilities?.reasoningProfile;
    const translated = capability
      ? applyReasoningRequestPatch(body, capability, this.config.thinkingEffort ?? "off", "gemini")
      : body;
    return useExplicitCache ? this.attachExplicitPromptCache(translated) : translated;
  }

  /**
   * Gemini cachedContents own only the stable system/tools prefix. Message history stays on the
   * request so each turn remains semantically identical when cache creation is unavailable.
   */
  private async attachExplicitPromptCache(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.promptCache) return body;
    const source: Record<string, unknown> = {};
    if (body["system_instruction"] !== undefined) {
      source["systemInstruction"] = body["system_instruction"];
    }
    if (body["tools"] !== undefined) source["tools"] = body["tools"];
    if (Object.keys(source).length === 0) return body;
    const cachedContent = await this.promptCache.getOrCreate(source);
    if (!cachedContent) return body;
    const { system_instruction: _systemInstruction, tools: _tools, ...remaining } = body;
    const cachedBody = { ...remaining, cachedContent: cachedContent.name };
    if (cachedContent.cacheWriteTokens !== undefined) {
      this.cacheWriteTokensByBody.set(cachedBody, cachedContent.cacheWriteTokens);
    }
    return cachedBody;
  }

  private createPromptCacheTransport(): GeminiPromptCacheTransport {
    const base = this.config.baseURL.replace(/\/+$/, "");
    const endpoint = `${base}/v1beta/cachedContents`;
    return {
      create: async ({ model, ttlSeconds, source }) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: `models/${model}`,
            ...source,
            ttl: `${ttlSeconds}s`,
          }),
        });
        if (!response.ok)
          throw new LLMStatusError(response.status, "Gemini cachedContents create failed");
        const data = (await response.json()) as {
          name?: unknown;
          expireTime?: unknown;
          usageMetadata?: { totalTokenCount?: unknown };
        };
        if (typeof data.name !== "string" || !data.name)
          throw new Error("Gemini cachedContents missing name");
        const parsedExpiry =
          typeof data.expireTime === "string" ? Date.parse(data.expireTime) : NaN;
        const tokens = data.usageMetadata?.totalTokenCount;
        return {
          name: data.name,
          ...(Number.isFinite(parsedExpiry) ? { expireAt: parsedExpiry } : {}),
          ...(typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
            ? { tokenCount: tokens }
            : {}),
        };
      },
      delete: async (name) => {
        const response = await fetch(`${base}/v1beta/${encodeURI(name)}`, {
          method: "DELETE",
          headers: { "x-goog-api-key": this.config.apiKey },
        });
        if (!response.ok && response.status !== 404) {
          throw new LLMStatusError(response.status, "Gemini cachedContents delete failed");
        }
      },
    };
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", "x-goog-api-key": this.config.apiKey };
  }

  /** 反向翻译:candidate.parts → 内部 schema.Message(非流式用) */
  private translateParts(
    parts: GeminiPart[],
    usageMetadata?: GeminiResponse["usageMetadata"],
  ): Message {
    let textContent = "";
    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      if (part.text) {
        textContent += part.text;
      } else if (part.functionCall?.name) {
        toolCalls.push({
          id: `gemini-call-${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      }
    }

    return {
      role: "assistant",
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usageMetadata ? this.translateUsage(usageMetadata) : undefined,
    };
  }

  private withCacheWriteUsage(message: Message, cacheWriteTokens?: number): Message {
    if (cacheWriteTokens === undefined) return message;
    const usage = message.usage;
    const reportedFields = new Set(usage?.reportedFields ?? []);
    reportedFields.add("prompt");
    reportedFields.add("cacheWrite");
    return {
      ...message,
      usage: {
        promptTokens: (usage?.promptTokens ?? 0) + cacheWriteTokens,
        completionTokens: usage?.completionTokens ?? 0,
        ...(usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
        cacheWriteTokens: (usage?.cacheWriteTokens ?? 0) + cacheWriteTokens,
        ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
        reportedFields: [...reportedFields],
      },
    };
  }

  /** Gemini usageMetadata → 内部 Usage 五桶 */
  private translateUsage(meta: NonNullable<GeminiResponse["usageMetadata"]>): Usage {
    const toolUsePromptTokens = meta.toolUsePromptTokenCount ?? 0;
    const reasoningTokens = meta.thoughtsTokenCount ?? 0;
    return {
      promptTokens: (meta.promptTokenCount ?? 0) + toolUsePromptTokens,
      completionTokens: (meta.candidatesTokenCount ?? 0) + reasoningTokens,
      cacheReadTokens: meta.cachedContentTokenCount ?? 0,
      reasoningTokens,
      reportedFields: [
        ...(typeof meta.promptTokenCount === "number" ||
        typeof meta.toolUsePromptTokenCount === "number"
          ? (["prompt"] as const)
          : []),
        ...(typeof meta.candidatesTokenCount === "number" ||
        typeof meta.thoughtsTokenCount === "number"
          ? (["completion"] as const)
          : []),
        ...(typeof meta.cachedContentTokenCount === "number" ? (["cacheRead"] as const) : []),
        ...(typeof meta.thoughtsTokenCount === "number" ? (["reasoning"] as const) : []),
      ],
    };
  }
}

function ttlSeconds(value: string | undefined): number {
  const matched = /^(\d+)s$/u.exec(value ?? "3600s");
  return matched ? Number(matched[1]) : 3_600;
}

function isRejectedCachedContentStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 422;
}
