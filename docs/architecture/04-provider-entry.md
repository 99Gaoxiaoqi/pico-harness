# Provider 适配与 TUI 入口

> TUI 入口最终装配一个 AgentEngine，引擎通过 LLMProvider 接口与模型通信。入口层负责 provider 配置、session、reporter、工具与审批装配。

---

## 第一部分：Provider 层 (`src/provider/`)

### 核心契约 (`interface.ts`)

```ts
interface LLMProvider {
  generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message>;
  generateStream?(messages, availableTools, onDelta: (delta: string) => void): Promise<Message>;
  isRetryableError?(error: unknown): boolean;
  readonly modelName?: string;
}
```

接口最小化（仅 `generate` 必填），新增 provider 零成本接入。

### 三家 Provider 协议差异

| 维度               | OpenAI                                                 | Claude (Anthropic)                | Gemini (Google)                   |
| ------------------ | ------------------------------------------------------ | --------------------------------- | --------------------------------- |
| **端点**           | `/chat/completions`                                    | `/messages`                       | `/models/{model}:generateContent` |
| **鉴权**           | `Authorization: Bearer`                                | `x-api-key` + `anthropic-version` | `?key=` query param               |
| **system**         | messages 数组 `role:system`                            | 顶层 `body.system` 字段           | 顶层 `system_instruction`         |
| **工具定义**       | `tools: [{type:function, function:{name,parameters}}]` | `tools: [{name, input_schema}]`   | `tools: [{functionDeclarations}]` |
| **工具结果**       | `role:tool` + `tool_call_id`                           | user 消息 `tool_result` block     | user parts `functionResponse`     |
| **思考强度**       | `reasoning_effort` 字符串                              | `thinking.budget_tokens`          | 不支持                            |
| **Prompt Cache**   | —                                                      | `cache_control: ephemeral`        | —                                 |
| **流式**           | SSE `data:` + `[DONE]`                                 | 事件驱动(content_block_delta)     | SSE alt=sse                       |
| **assistant 角色** | `assistant`                                            | `assistant`                       | `model`（注意不是 assistant）     |
| **工具调用参数**   | JSON 字符串                                            | 对象（input）                     | 对象（args）                      |

### Provider 工厂 (`factory.ts`)

- `createProvider(kind, config?, thinkingEffort?)`：主入口
- OpenAI 走 `createOpenAIProviderWithFallback`（带模型 fallback：glm-5.2 → kimi-k2.5）
- `getCredentialPool()`：进程级单例，多 key 时自动轮换

### 重试 + 凭证轮换

```
generateWithRetry (retry.ts)
  ├─ 429/5xx → 指数退避(300ms~5s) 重试 3 次
  ├─ 429 + onRateLimited → 切 key 跳过退避
  │   └─ credentialPool.markRateLimited(currentKey) → getNext()
  └─ ContextOverflowError → 不重试(交给压缩层)

CredentialPool (credential-pool.ts)
  ├─ round-robin 轮询 + 60s 冷却
  ├─ markRateLimitedWithInfo: 用 RateLimit header 精确冷却
  └─ 全限流兜底: 取最早到期的 key
```

### 成本追踪 (CostTracker)

装饰器模式——实现 LLMProvider 接口，内部包裹真实 provider。Engine 毫不知情被监控（AOP）。

```ts
new CostTracker(provider, modelRoute, session);
// generate(): 计时 → 调真 provider → estimateCost → session.recordUsage → 返回
// generateStream(): 透传 onDelta,同样计费
```

### 限流 Header 解析 (`ratelimit.ts`)

统一解析各家 header（`x-ratelimit-remaining` / `retry-after` / `x-ratelimit-reset`）为 `RateLimitInfo`。

### Anthropic Prompt Cache (`anthropic-cache.ts`)

最多 4 个 `cache_control: ephemeral` 断点：system → tools 尾 → 历史前缀尾 → 余量。命中后 cache_read 单价降至约 1/10。

---

## 第二部分：TUI 单入口

`pico` → TUI 是唯一公开产品入口。REST/WebSocket、ACP、飞书和 one-shot/headless CLI 属于已退役的历史外壳。

### 入口边界

| 维度         | 当前实现                       |
| ------------ | ------------------------------ |
| **启动**     | `pico` / `npm run dev`         |
| **I/O**      | ink React TUI + `TuiReporter`  |
| **Provider** | CostTracker + fallback         |
| **Session**  | 当前项目 TUI session           |
| **审批**     | 本地 TUI/终端审批              |
| **MCP**      | 通过 `--mcp-config` 启动时加载 |

### 启动装配 (`cli/main.ts` → `tui/repl.tsx` → `run-agent.ts`)

```
main.ts parseArgs
  └─ startTuiRepl
      └─ handleSubmit
          └─ runAgentFromCli
```

`runAgentFromCli` 是 TUI 每轮运行的内部装配函数，不是公开 one-shot/headless API。其装配链：

1. resolveProviderConfig（CLI 参数 > 环境变量）
2. globalSessionManager.getOrCreate（固定 ID 复用）
3. 凭证轮换装配（rebuildProvider 回调）
4. CostTracker 包裹
5. GoalManager/TodoStore/ToolDisclosure 单例
6. buildRegistry + Hooks + 审批中间件
7. PromptComposer.build（预组装 system prompt）
8. AgentEngine 构造（`PICO_TRACE=1` 或 `trace: true` 时注入 Tracer）
9. session.append(user) + engine.run(session)

### TUI (`src/tui/`)

ink + React 19 全屏 REPL（对标 Claude Code）。

```
InputBox ──▶ handleSubmit ──▶ runAgentFromCli({reporter: TuiReporter})
                                           │
engine 事件流(onTextDelta/onToolCall/...)   │
                                           ▼
TuiReporter → TuiEntry[] → onUpdate → setEntries → ink 重渲染
                                           │
                            React 组件树(MessageRow memo)
```

**架构决策**：

- 不用 ink `<Static>`（滚雪球 bug），所有条目留同一渲染树
- `alternateScreen: true`（alt buffer，内容不进 scrollback）
- QueryGuard 三态状态机防并发提交
- SpinnerMode 5 阶段：requesting/thinking/tool-use/responding/idle
- StreamingText 逐行流式（stable/unstable 分割）
- React.memo 跳过静态条目重渲染

---

## 流式输出完整回调链

```
provider.generateStream
  │ onDelta(delta)
  ▼
loop.ts 构造包装 provider，把 generate() 替换为 generateStream()
  │ delta => reporter.onTextDelta?.(delta)
  ▼
Reporter.onTextDelta(delta)
  └── TuiReporter: streamingText += delta → emit()          [公开 TUI]
```

retry / overflowRetry 无需改动自动获得流式能力（构造器已替换 generate）。
