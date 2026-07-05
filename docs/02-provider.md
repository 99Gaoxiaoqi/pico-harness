# 第 2 章 · 接上不同的大脑

第 1 章的 Agent 循环能跑了。但有一个硬伤：**它绑死了一种大模型。**

代码里写了 `provider.generate(context, tools)`，但如果我想从 OpenAI 的 GPT-4 换成 Anthropic 的 Claude，会发生什么？请求格式完全不同——字段名不一样、嵌套结构不一样、连 HTTP Header 都不一样。

我一开始的做法很蠢：

```typescript
// 在 Main Loop 里直接写死厂商协议
if (modelType === "claude") {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      system: systemPrompt,           // Claude: system 是顶层字段
      messages: toClaudeFormat(msgs), // 需要一套转换逻辑
      // ...
    })
  });
} else if (modelType === "openai") {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    headers: { "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      messages: toOpenAIFormat(msgs), // 又一套转换逻辑
      // ...
    })
  });
}
```

每次加一个新模型，就要在 Main Loop 里加一个 `if` 分支。每个分支都要重复：错误处理、重试逻辑、Token 统计、超时控制……这不是写代码，是在给自己挖坑。

更痛苦的是：换模型的代价是"重写 Main Loop"。我最初用 OpenAI 的接口写完了整个引擎，但当我想试试 Claude 的效果时，发现所有 `tool_calls` 的字段名都是 OpenAI 风格的——Claude 根本不认识。我改了两天，改了改去，最后 Main Loop 变成了一个 if-else 的噩梦。

然后我想到了一个比喻。

---

## 翻译官模式

联合国会议的同声传译。各国代表说着不同的语言，但翻译员把所有发言都转成与会者能理解的统一语言。

在 Agent Harness 里，不同的大模型就是不同的"语言"：

| 厂商 | 协议特征 |
|------|---------|
| **OpenAI** | `system` 在 `messages` 数组里；工具调用是 `tool_calls` 字段；工具结果 `role="tool"` |
| **Claude** | `system` 是独立顶层字段；工具调用是 `content` 里的 `tool_use` block；工具结果 `role="user"` + `tool_result` block |

Main Loop 不应该知道这些。它只需要一个"翻译官"：接收标准格式的上下文，返回标准格式的响应。

这个翻译官，就是 `LLMProvider` 接口。它只有一个核心方法：

```typescript
// src/provider/interface.ts
export interface LLMProvider {
  /**
   * 接收当前上下文历史与可用工具列表,发起一次大模型推理。
   * @returns 模型的响应消息 (可能含 toolCalls,也可能只有纯文本最终答案)
   */
  generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message>;

  /** 可选:provider 自治判定哪些错误可重试 */
  isRetryableError?(error: unknown): boolean;

  /** 可选:模型名,供重试/计费日志打点 */
  readonly modelName?: string;
}
```

只有 `generate` 是必须实现的。`isRetryableError` 和 `modelName` 是可选的——Provider 可以选择自己处理重试判定，也可以交给上层统一处理。**接口越小，实现越容易，切换越无痛。**

这个接口的简洁性是刻意的。我不需要 `listModels()`、不需要 `countTokens()`、不需要 `streamResponse()`——这些都不是 Main Loop 关心的。Main Loop 只做一件事："给我这些上下文和工具，告诉我模型说了什么"。Provider 怎么实现的，Main Loop 完全不知道。

---

## 两套翻译

### OpenAI 翻译：直来直去

OpenAI 的协议相对简单。翻译工作基本是字段映射：

```typescript
// src/provider/openai.ts —— 核心翻译逻辑
async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
  // 1. 消息翻译
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        openaiMsgs.push({ role: "system", content: msg.content });  // 直接映射
        break;
      case "user":
        if (msg.toolCallId) {
          // 工具结果 → role="tool" + tool_call_id
          openaiMsgs.push({ role: "tool", content: msg.content, tool_call_id: msg.toolCallId });
        } else {
          openaiMsgs.push({ role: "user", content: msg.content });
        }
        break;
      case "assistant":
        openaiMsgs.push({
          role: "assistant",
          content: msg.content,
          tool_calls: msg.toolCalls?.map(tc => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        break;
    }
  }

  // 2. 工具定义翻译:直接映射,因为双方都是 JSON Schema
  body.tools = availableTools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  // 3. 发送请求
  const resp = await fetch(`${this.config.baseURL}/chat/completions`, {
    headers: { Authorization: `Bearer ${this.config.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), // 2 分钟超时
  });

  // 4. 反向翻译:OpenAI 响应 → 内部 Message
  return {
    role: "assistant",
    content: choice.content ?? "",
    toolCalls: choice.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
  };
}
```

OpenAI 的翻译很顺畅，因为它的工具调用格式（`function.name` + `function.arguments`）和 JSON Schema 参数定义与我们内部结构天然对齐。翻译基本是"穿衣服脱衣服"——请求时把内部 Message 包一层 OpenAI 的壳，响应时把壳剥掉。

### Claude 翻译：这里有坑

Claude 的协议就不那么友好了。它有四个关键差异，每一个都让我踩过坑。

**差异 1：`system` 不在 `messages` 里。**

```typescript
// Claude: system 是独立顶层字段
if (systemPrompt) body.system = systemPrompt;

// OpenAI: system 是 messages 数组里的一条
// openaiMsgs.push({ role: "system", content: msg.content });
```

这意味着翻译时要先把 `role="system"` 的消息从数组里**提取出来**，单独放到 `body.system`。如果忘了这一步，Claude API 会直接报错。我第一次切换时完全没注意到这个差异，对着 400 错误查了半小时。

**差异 2：消息体是 Content Blocks 数组，不是纯文本。**

```typescript
// Claude 的消息结构:
{ role: "user", content: [{ type: "text", text: "..." }] }

// 工具调用:
{ role: "assistant", content: [
    { type: "text", text: "我先读一下文件" },
    { type: "tool_use", id: "call_123", name: "read_file", input: { path: "..." } },
  ]}
```

每个 `assistant` 消息的 `content` 是一个数组，里面可以混排文本块和工具调用块。这和 OpenAI 的 `content` 是纯字符串 + 单独的 `tool_calls` 字段完全不同。翻译时要拆解数组：文本块合并成 `content` 字符串，工具调用块映射到 `toolCalls` 数组。

**差异 3：工具结果在 `user` 消息里，不是独立的 `role="tool"`。**

```typescript
// Claude: 工具结果是 user 消息里的 tool_result block
anthropicMsgs.push({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: msg.toolCallId, content: msg.content }],
});

// OpenAI: 工具结果是 role="tool" 的独立消息
// openaiMsgs.push({ role: "tool", content: msg.content, tool_call_id: msg.toolCallId });
```

这个差异很坑——我第一次调试时发现 Claude 一直"看不到"工具执行结果，因为我把工具结果放在了独立的 `role="tool"` 消息里（这是 OpenAI 的习惯），但 Claude 期望它在 `user` 消息的 `content` 数组里。

**差异 4：`arguments` 的序列化方向相反。**

```typescript
// Claude 的 tool_use block 里,input 是 JSON 对象
{ type: "tool_use", id: "call_123", name: "read_file", input: { path: "src/a.ts" } }

// 但我们的内部 ToolCall.arguments 是 JSON 字符串！
// 所以发送时需要 JSON.parse:
input = JSON.parse(tc.arguments);  // 字符串 → 对象

// 接收时需要 JSON.stringify:
arguments: JSON.stringify(block.input); // 对象 → 字符串
```

这是两个协议之间最微妙的差异。OpenAI 把参数当 JSON 字符串传输，Claude 把参数当 JSON 对象传输。这意味着同一个 Provider 实现里，发送方向和接收方向做**相反的**序列化操作。一开始我把方向搞反了，工具怎么都调不通。

---

## Claude Prompt Caching：意外收获

在实现 Claude Provider 的过程中，我发现了一个"免费的性能优化"：Anthropic 的 Prompt Cache。

Claude 允许在 system prompt 和 tools 定义的特定位置设置 `cache_control` 断点。设置了断点的内容会被缓存，后续请求如果命中缓存，读取代价仅为正常价格的 10%，写入代价为正常价格的 125%。

在 Agent 循环里，system prompt 和 tools 定义在每一轮都是完全相同的。这意味着它们天然适合缓存：

```typescript
// src/provider/anthropic-cache.ts
// 在 system prompt 末尾和 tools 定义末尾设置缓存断点
body.system = [
  { type: "text", text: systemPrompt },
  { type: "text", text: "...", cache_control: { type: "ephemeral" } }, // 断点
];

body.tools = [
  ...tools.map(t => ({ name: t.name, ... })),
  // 最后一个 tool 的末尾加断点
];
```

实测效果：在 20 轮的 Agent 任务中，大约 60% 的输入 Token 命中缓存。以 Claude Sonnet 的价格（输入 $3/百万 Token），这意味着每千轮任务省下大约 $1.50。

这不是我计划内的功能——它是在阅读 Anthropic 文档时偶然发现的。**先于框架知道模型的新能力，是自建 Provider 的最大优势。**

---

## 做决定的工厂

有了两套 Provider 实现，但还有一个问题：怎么决定用哪个？

我可以在代码里写死 `new OpenAIProvider(config)`，但这样就回到老路了。我需要一个"做决定"的地方——一个工厂。

```typescript
// src/provider/factory.ts
export type ProviderKind = "openai" | "claude";

export function createProvider(
  kind: ProviderKind,
  config?: ProviderConfig,
  thinkingEffort?: ThinkingEffort,
): LLMProvider {
  const cfg = resolveConfig(config, thinkingEffort);
  switch (kind) {
    case "openai":
      return createOpenAIProviderWithFallback(cfg);
    case "claude":
      return new ClaudeProvider(cfg);
  }
}
```

Factory 做三件事：

1. **协议选择**：根据 `kind` 参数分派到对应实现。
2. **配置加载**：如果没传 config，自动从环境变量读取（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`）。
3. **模型兜底**：OpenAI 兼容协议下，如果主模型挂了，自动切换到备用模型。

模型兜底是后来加上的。有一次 Ark（火山方舟）的 DeepSeek V4 Pro 实例宕机了，Agent 直接挂掉。我问自己：为什么引擎不能自动切模型？

```typescript
// factory.ts —— ModelFallbackProvider
class ModelFallbackProvider implements LLMProvider {
  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    try {
      return await this.activeProvider.generate(messages, tools);
    } catch (error) {
      if (!this.switched && this.isModelUnavailable(error)) {
        // 主模型挂了，切换到备用模型
        this.switched = true;
        this.activeProvider = this.create({ ...this.primaryConfig, model: this.fallbackModel });
        return this.activeProvider.generate(messages, tools);
      }
      throw error;
    }
  }
}
```

对于 GLM-5.2 模型，备用是 Kimi K2.5。当火山方舟的 GLM 实例不可用时，引擎自动降级到 Kimi。用户甚至不会注意到切换发生了——只有日志里多了一行 `[fallback] switched to kimi-k2.5`。

---

## 把 Provider 信息暴露给引擎

还有一个被忽略但重要的问题：**引擎需要知道 Provider 的信息，但不能依赖 Provider 的实现。**

比如重试逻辑。有些错误是 transient（网络超时、限流），应该重试；有些是 permanent（API Key 无效、模型不存在），重试也是浪费时间。通用的重试框架可以处理常见的 HTTP 错误码（429、503），但 Provider 可能有特定的错误模式。

解决方案：Provider 可选地暴露 `isRetryableError` 方法：

```typescript
// src/provider/errors.ts —— 通用重试判定
export function isRetryableError(error: unknown, provider?: LLMProvider): boolean {
  // 1. 先问 Provider："你自己知道这个错误能重试吗？"
  if (provider?.isRetryableError?.(error)) return true;

  // 2. 通用判定：HTTP 429（限流）、503（服务不可用）、网络超时
  if (error instanceof TooManyRequestsError) return true;
  if (error instanceof ServiceUnavailableError) return true;
  if (isNetworkTimeout(error)) return true;

  // 3. 默认：不重试
  return false;
}
```

Provider 如果实现了 `isRetryableError`，引擎会优先用它。如果没实现，引擎用通用逻辑兜底。**责任分层：引擎提供默认行为，Provider 可以覆盖特定行为。**

---

## 为什么不是 LangChain 的 BaseChatModel？

读过 LangChain 源码的人可能会问：它的 `BaseChatModel` 也抽象了 Provider，你为什么不用？

因为 LangChain 的抽象太重了。它的 `BaseChatModel` 有 20+ 个方法——`_generate`、`_stream`、`_agenerate`、`_astream`、`bind_tools`、`with_structured_output`、`with_fallbacks`……每个方法都带着一堆默认实现。当你想加一个"发送前记录 Token 用量"的钩子时，你发现要覆盖五个方法。

pico 的 `LLMProvider` 只有一个 `generate` 方法。如果你想要流式输出？再实现一个 `StreamingProvider` 接口（如果需要的话）。如果你想要 Token 计数？在 `generate` 里加一行 log。**不要为不存在的问题写接口。**

---

## 现在有了什么

我们有了一个 Provider 系统，它：

- 通过 `LLMProvider` 接口解耦引擎和模型（Main Loop 永远不知道背后是 OpenAI 还是 Claude）
- 用 Factory 模式动态分派，支持从环境变量加载配置
- 在 OpenAI 兼容协议下自动降级到备用模型
- Claude Provider 利用 Prompt Cache 降低 60% 的重复输入成本
- 重试逻辑分层：引擎提供通用兜底，Provider 可覆盖特定行为

但 Agent 能用的工具还是空的。Main Loop 里调用的 `registry.execute()` 需要一个真实的工具集。

接下来，我要给它装上四把趁手的工具——读、写、改、跑。

[下一章：教它用工具 →](03-tools.md)
