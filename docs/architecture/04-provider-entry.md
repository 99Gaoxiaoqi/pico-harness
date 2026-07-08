# Provider 适配与多端入口

> 所有入口最终都装配一个 AgentEngine，引擎通过 LLMProvider 接口与模型通信。不同入口的差异在于装配方式和 I/O 形态。

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

| 维度 | OpenAI | Claude (Anthropic) | Gemini (Google) |
|------|--------|---------------------|-----------------|
| **端点** | `/chat/completions` | `/messages` | `/models/{model}:generateContent` |
| **鉴权** | `Authorization: Bearer` | `x-api-key` + `anthropic-version` | `?key=` query param |
| **system** | messages 数组 `role:system` | 顶层 `body.system` 字段 | 顶层 `system_instruction` |
| **工具定义** | `tools: [{type:function, function:{name,parameters}}]` | `tools: [{name, input_schema}]` | `tools: [{functionDeclarations}]` |
| **工具结果** | `role:tool` + `tool_call_id` | user 消息 `tool_result` block | user parts `functionResponse` |
| **思考强度** | `reasoning_effort` 字符串 | `thinking.budget_tokens` | 不支持 |
| **Prompt Cache** | — | `cache_control: ephemeral` | — |
| **流式** | SSE `data:` + `[DONE]` | 事件驱动(content_block_delta) | SSE alt=sse |
| **assistant 角色** | `assistant` | `assistant` | `model`（注意不是 assistant） |
| **工具调用参数** | JSON 字符串 | 对象（input） | 对象（args） |

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
new CostTracker(provider, modelRoute, session)
// generate(): 计时 → 调真 provider → estimateCost → session.recordUsage → 返回
// generateStream(): 透传 onDelta,同样计费
```

### 限流 Header 解析 (`ratelimit.ts`)
统一解析各家 header（`x-ratelimit-remaining` / `retry-after` / `x-ratelimit-reset`）为 `RateLimitInfo`。

### Anthropic Prompt Cache (`anthropic-cache.ts`)
最��� 4 个 `cache_control: ephemeral` 断点：system → tools 尾 → 历史前缀尾 → 余量。命中后 cache_read 单价降至约 1/10。

---

## 第二部分：多端入口

### 入口差异速查

| 维度 | CLI 默认 | --serve | --acp | --feishu | --tui |
|------|---------|---------|-------|----------|-------|
| **I/O** | stdout 单次 | REST + WS | JSON-RPC stdio | 飞书 WSClient | ink React |
| **Provider** | CostTracker + fallback | 裸 provider | CostTracker | CostTracker | CostTracker |
| **Session** | `console:{workDir}` | `http-{ts}-{n}` | `acp:{uuid}` | `feishu:{chatId}` | 复用 console |
| **流式** | stdout | WS text-delta | response/output | 轮次消息 | TuiReporter |
| **审批** | 终端 | REST + 终端 | 终端 | 飞书卡片 | 终端 |
| **共享单例** | per-run | 进程级 | 进程级 | 进程级 | per-run |
| **MCP** | ✅ | ❌ | ❌ | ❌ | ✅(首轮) |
| **Steer** | --steer | ❌ | ❌ | 运行时注入 | ❌ |

### CLI 入口 (`cli/main.ts` → `run-agent.ts`)

```
main.ts parseArgs → 按模式分发
  ├─ --list-snapshots / --rewind: 文件历史操作
  ├─ --acp: ACP stdio server
  ├─ --feishu: 飞书 bot
  ├─ --serve: HTTP+WS server
  ├─ --tui: TUI ink REPL
  └─ 默认: runAgentFromCli(单次任务)
```

`runAgentFromCli` 装配链：
1. resolveProviderConfig（CLI 参数 > 环境变量）
2. globalSessionManager.getOrCreate（固定 ID 复用）
3. 凭证轮换装配（rebuildProvider 回调）
4. CostTracker 包裹
5. GoalManager/TodoStore/ToolDisclosure 单例
6. buildRegistry + Hooks + 审批中间件
7. PromptComposer.build（预组装 system prompt）
8. AgentEngine 构造
9. session.append(user) + engine.run(session)

### HTTP+WS (`server/`)

**REST 端点**：
| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/sessions` | 创建会话 |
| GET | `/sessions/:id` | 会话状态 |
| POST | `/sessions/:id/messages` | 发消息 |
| POST | `/approvals/:taskId` | 审批 |
| GET | `/tools` | 工具列表 |

**WebSocket**：`ws://host/?sessionId=xxx&lastSeq=NNN&epoch=EEE`
- cursor 多端同步：持久事件推进 seq，易失事件（text-delta）不推进
- fork/rewind 时 epoch++，旧 cursor 失效推 resync

### ACP (`src/acp/`)

Agent Client Protocol，IDE（VSCode 插件）与 Agent 通信协议。
- JSON-RPC 2.0 over stdio
- 方法：`initialize` / `session/create` / `prompt` / `fs/readTextFile` / `fs/writeTextFile`
- 流式：`response/start` → `response/output`（增量）→ `response/finish`
- 4 模式：default(审批) / plan / auto(自动) / yolo(全自动)

### 飞书 (`src/feishu/`)

- WSClient 长连接（无需公网回调地址）
- 每群独立 Session（`feishu:{chatId}`）
- 意图拦截：闲聊不触发，需命令前缀或关键词
- Steer 运行时注入：Agent 运行中消息 push 进 SteerQueue
- 审批卡片：同意/拒绝/修改按钮

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
  ├── TerminalReporter: process.stdout.write(delta)        [CLI]
  ├── TuiReporter: streamingText += delta → emit()          [TUI]
  ├── AcpStreamCollector: notify(response/output, {delta})  [ACP]
  └── WS pushVolatile: broadcast text-delta                 [HTTP/WS]
```

retry / overflowRetry 无需改动自动获得流式能力（构造器已替换 generate）。
