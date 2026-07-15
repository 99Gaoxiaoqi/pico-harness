# Provider 适配与共享 Runtime 入口

> TUI 与 Desktop 共用同一 Provider 配置、凭证解析和 Agent Runtime。入口层负责 session、reporter、工具与审批装配，不各自维护模型配置副本。

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

- `createProvider(kind, config, thinkingEffort?)`：只根据显式配置创建协议适配器
- Factory 不读取 `process.env`，也不持有进程级凭证池
- 模型可用性 fallback 属于 `AgentRuntime` 的路由装配，不属于 Provider factory

### 配置与凭证分层

```text
Session / CLI 显式选择
          ↓
已信任项目 .pico/config.json
          ↓
$PICO_HOME/config.json（Desktop + TUI 共享）
          ↓
LLM_* 环境变量（兼容入口）
```

上图只描述非秘密配置和模型路由的优先级。`EffectiveConfigResolver` 为每个字段保留来源；工作区未信任时不读取项目配置；同 ID Provider 的协议或规范化 Endpoint 冲突时直接拒绝合并。`UserConfigStore` 以内容 SHA-256 revision 执行 OCC，在短锁内复查 revision 并原子替换文件。

`loadEffectiveModelRuntime` 是 TUI、Desktop 前台运行、Compact 和子代理的统一模型解析入口。它先解析配置，再按“Provider 指定的宿主环境变量 > 匹配 authority 的 v2 凭证 > 项目路由 v1 凭证”向 `ModelRouter` 注入进程内 secret。环境凭证会遮蔽但不会改写已存的系统凭证。secret 不属于 `EffectiveConfigSnapshot`；经过本机认证的 TUI/Desktop 可以用 write-only Runtime 请求在进程间短暂传递 secret，但它不得出现在 Runtime 响应、事件、持久配置、Renderer Store 或日志中，也不得写入请求之外的长期内存状态。发布构建默认禁用持久凭证并 fail-closed：现有 `/usr/bin/security` 适配无法阻止同一 macOS 用户下的 Agent Shell 读取条目，只允许本地开发通过 `PICO_UNSAFE_KEYCHAIN_CLI=1` 显式启用，不得用于发布。正式 macOS 版本必须改用签名的 Pico Credential Broker/XPC 进程；在该后端和其他平台安全后端完成前，只支持环境变量兼容入口。

每个 Run 固定使用启动时的配置快照。TUI 在下一轮 Run 前重新解析配置和凭证；daemon 通过 `config.updated` 通知 Desktop，Renderer 在事件后刷新，并在窗口重新聚焦时补读。刷新不会热换正在运行的 Provider，Session 显式路由仍优先；损坏配置、过期 revision 与 authority 冲突都 fail-closed。

凭证引用分两代：

- v2 按 `providerId + protocol + normalized endpoint + slot` 绑定，用于设备级共享 Provider。
- v1 按工作区与完整 model route 绑定，仅保留给旧项目配置和已持久 Automation。

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

CredentialPool 由每次 `AgentRuntime` 执行根据显式 `runtimeEnv` 创建，轮换状态不会在不同
Runtime Host 之间共享。`CredentialRotationCoordinator` 将实际失败的 key 与 Provider 请求
绑定，避免并发晚到的 429 错误误伤已经切换的新 key。

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

## 第二部分：产品入口

`pico` 启动 TUI；Desktop 通过类型化本地 daemon 协议使用同一 Runtime。当前没有公开的
远程或 one-shot/headless 产品入口。

### 入口边界

| 维度         | TUI                            | Desktop                                          |
| ------------ | ------------------------------ | ------------------------------------------------ |
| **启动**     | `pico` / `npm run dev`         | Electron Main 连接当前 `PICO_HOME` 的本地 daemon |
| **I/O**      | ink React TUI + `TuiReporter`  | React Renderer + 类型化 Preload/Runtime 事件     |
| **Provider** | 共享 ModelRouter + CostTracker | 同一 ModelRouter；Renderer 不接触 secret         |
| **Session**  | 当前项目 TUI Session           | Workspace → Session → 多轮 Run 的连续 Transcript |
| **审批**     | 本地 TUI/终端审批              | Transcript 内 Approval / Ask User                |
| **MCP**      | 工作区配置，可用高级命令管理   | 同一工作区配置，通过 daemon 类型化方法管理       |

### TUI 启动装配 (`cli/main.ts` → `tui/repl.tsx` → `run-agent.ts`)

```
main.ts parseArgs
  └─ startTuiRepl
      └─ handleSubmit
          └─ runAgentFromCli
              └─ AgentRuntime.execute
```

`runAgentFromCli` 是 TUI 每轮运行的兼容包装，不是公开 one-shot/headless API。共享装配链
位于 `AgentRuntime`：

1. loadEffectiveModelRuntime（Session / CLI > 项目 > 用户 > 环境）
2. globalSessionManager.getOrCreate（固定 ID 复用）
3. 从显式 runtimeEnv 创建本次 Runtime 的凭证轮换池
4. CostTracker 包裹
5. GoalManager/TodoStore/ToolDisclosure 单例
6. buildRegistry + Hooks + 审批中间件
7. PromptComposer.build（预组装 system prompt）
8. AgentEngine 构造（`PICO_TRACE=1` 或 `trace: true` 时注入 Tracer）
9. session.append(user) + engine.run(session)

Desktop 的装配链是 `Renderer → Preload → Electron Main → LocalRuntimeClient → daemon →
DesktopRuntimeService/WorkspaceRuntimeService → AgentRuntime`。协议参数、结果与事件由
`packages/protocol` 定义，Desktop 可调用的方法由同一包的白名单约束。

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
