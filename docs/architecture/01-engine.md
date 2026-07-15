# 核心引擎层 (`src/engine/`)

> 引擎是微型 OS 内核：Session 驱动的 Two-Stage ReAct 循环。自身不维护状态，靠外部 Session 推理。

## 文件总览

| 文件               | 行数  | 职责                                                     |
| ------------------ | ----- | -------------------------------------------------------- |
| `loop.ts`          | ~1316 | AgentEngine 主循环（心脏）                               |
| `session.ts`       | ~1800 | Session + SessionManager（会话隔离 + 内存投影 + 工作记忆） |
| `session-persistence.ts` | ~25 | 会话持久化游标与提交回执协议                         |
| `reminder.ts`      | ~228  | 死循环探测 + ToolGuardrail                               |
| `goal-manager.ts`  | ~243  | 长程目标状态机                                           |
| `reporter.ts`      | ~133  | 事件输出接口（I/O 解耦）                                 |
| `budget.ts`        | ~67   | 轮次/Token/成本预算                                      |
| `steer-queue.ts`   | ~47   | 运行时注入引导文本                                       |

---

## 1. AgentEngine 主循环 (`loop.ts`)

### 核心签名

```ts
class AgentEngine {
  constructor(opts: AgentEngineOptions);
  async run(session: Session, runtimeReporter?, runtimeTracer?): Promise<Message[]>;
  async runSub(taskPrompt, readOnlyRegistry, reporter?, opts?): Promise<SubagentResult>; // 子代理
  exitPlanMode(): void; // 审批通过后退出 Plan Mode
  setSteerQueue(q: SteerQueue): void; // host 后注入
}
```

### `run()` 主循环完整流程

每一轮（`for(;;)`）的 8 个步骤：

```
┌─────────────────────────────────────────────────────────────────┐
│ 步骤 0: 预算门禁 + 文件历史钩子                                    │
│   budget.canStartTurn(turn) → 超限则 break 去 Grace Call          │
│   reporter.onTurnStart(turn)                                      │
│   registry.setPreWriteHook → fileHistoryTrackEdit                │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 1: 上下文组装                                                │
│   allTools = registry.getAvailableTools()                        │
│   availableTools = toolDisclosure.pickForLLM(allTools)  // 渐进披露│
│   modelContext = session.getModelContext()       // 完整历史副本  │
│   contextHistory = [systemPrompt, ...modelContext]               │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 2: token 水位整理                                           │
│   < 85%: 原样发送；超水位:旧 ToolResult 投影 → FullCompaction     │
│   切分仅落在完整 toolCalls/results 批次之外                       │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 2.5: Steer A 点(peek 不 drain)                               │
│   pendingSteer = steerQueue.peek()                               │
│   if (pendingSteer) compactedContext.push([STEER] ...)           │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 3: Phase 1 慢思考(可选,enableThinking)                        │
│   reporter.onThinking()                                          │
│   thinkResp = generate(传入空 tools[],模型被迫纯文本规划)          │
│   session.append(thinkResp)                                      │
│   compactedContext.push(thinkResp)  // 供 Phase 2 自回归          │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 4: Phase 2 行动(Action)                                      │
│   responseMsg = generate(传入 availableTools,模型生成 toolCalls)   │
│   session.append(responseMsg)                                    │
│   reporter.onMessage(content)                                    │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 5: 退出/续接判断                                             │
│   toolCalls = responseMsg.toolCalls                              │
│   if (toolCalls.length === 0):                                   │
│     shouldContinueAfterStop?.() → 续接 or onFinish + break       │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 6: 工具执行(资源冲突图调度,maxConcurrency=8)                   │
│   scheduler = new ToolScheduler({maxConcurrency: 8})             │
│   results = Promise.all(toolCalls.map(tc =>                      │
│     scheduler.add({accesses, start: runOneTool(tc)})))           │
│   session.append(...observations)                                │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 7: Steer C 点(drain 落 session)                               │
│   steerTexts = steerQueue.drain()                                │
│   session.append(...steerTexts)  // 下一轮 getModelContext 浮现   │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 8: 每轮收尾                                                  │
│   fileHistoryMakeSnapshot(session.fileHistory, messageId)        │
│   turnSpan.end()                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 两层重试叠加

```
generateWithOverflowRetry (主 Agent)
  ├─ attempt 0: 完整安全投影
  ├─ Provider overflow:更紧 token 目标 FullCompaction 一次
  ├─ attempt 1: 用“摘要 + 完整安全尾部”重试
  └─ 仍失败 → 明确诊断静态提示/当前请求/工具 Schema，再硬重置
      │
      ▼
generateWithRetry (内层:普通重试)
  ├─ 429/5xx/网络错误 → 指数退避(300ms~5s)重试 3 次
  ├─ 429 + onRateLimited → 切 key 跳过退避
  └─ ContextOverflowError → 不重试(冒泡到外层)
```

### 关键常量

| 常量                           | 值                    | 作用                   |
| ------------------------------ | --------------------- | ---------------------- |
| `DEFAULT_AUTO_COMPACT_TRIGGER_RATIO` | 0.85 | 主动整理输入水位 |
| `DEFAULT_RETAINED_CONTEXT_RATIO`     | 0.20 | 主动摘要尾部目标 |
| `EMERGENCY_RETAINED_CONTEXT_RATIO`   | 0.10 | overflow 紧急目标 |
| `MAX_TOOL_CONCURRENCY`                | 8    | 工具并发上限     |
| `maxTurns` 默认                       | 50   | 主循环兜底       |

---

## 2. Session (`session.ts`)

### 核心职责

会话物理隔离（并发 run 不共用 history）+ 完整模型历史的内存投影。持久化事实统一由
`RuntimeEventStore` 写入 workspace 的 `runtime.sqlite`，Session 可随时从事件重建。

### 关键机制

- **`getModelContext()`**:返回完整历史副本并更新 ToolResult 访问元数据；协议清理由请求投影层完成
- **`getWorkingMemory(limit)`**:仅为兼容测试保留，主 Agent 不再调用
- **`append(msg)`**:处理 deferred + toolResultMeta 登记。assistant 带 toolCalls → 登记 pendingToolCallIds；ToolResult 到达 → 从 pending 删除；普通消息且 pending 非空 → 暂存 deferredMessages
- **`serialize(task)`**:per-session 串行执行队列，同一 Session 的 engine.run 必须串行
- **持久化提交**：消息先提交 `RuntimeEventStore`，再更新 Session 内存投影；相同 `eventId` 重试幂等
- **LRU + TTL 双重驱逐**:maxSessions=128，TTL=24h

### RuntimeEventStore (`src/runtime/runtime-event-store.ts`)

SQLite 追加事件表是会话与运行时的唯一事实源：`message.committed`、
`session.state.committed`、`history.rewound`、`session.forked` 与 run/tool/model 事实共享一条全序列。

- **事务提交**：事件内容与全局 sequence 在同一 SQLite 事务中提交
- **Exactly-once**：`(session_id, event_id)` 唯一；同 ID 同 payload 重试复用原 cursor，不同 payload 拒绝
- **可重建投影**：Session history、usage、CLI 会话列表和搜索索引均从事件恢复
- **单一恢复路径**：不再读取或写入 Session JSONL，也不迁移旧 `.claw` 会话数据

---

## 3. 死循环探测 + Guardrail (`reminder.ts`)

### 核心思想

**为什么 System Prompt 拦不住？** 连续同质错误信息占据主导（上下文偏移）+ 近因偏差（模型对末尾信息响应权重高）。

**破局**：在模型做决定的前一刻（Point of Decision），把高优指令伪装成最新 User Message 怼到脸上。

### 三类监控

| 类型            | 说明                               | warn | block |
| --------------- | ---------------------------------- | ---- | ----- |
| exactFailure    | 相同参数失败（MD5 指纹）           | 3 次 | 5 次  |
| sameToolFailure | 同工具不同参失败                   | 3 次 | 8 次  |
| noProgress      | 只读工具连续返回相同结果（SHA256） | 2 次 | 5 次  |

超 block 阈值写入 `blockedReasons`，后续 `beforeCall` 直接阻断。

---

## 4. 其他引擎组件

### Budget (`budget.ts`)

4 维约束：maxTurns / maxTokens / maxCostCNY / maxWallClockMs。`canStartTurn` 检查轮次+墙钟，`consumeUsage/consumeCost` 累加 Token/成本。

### GoalManager (`goal-manager.ts`)

长程目标状态机：active/paused/blocked/complete。**内存单例**（不落盘），host 创建唯一实例注入 registry(3 工具) + engine(PromptComposer)。`buildGoalContext()` 渲染 Markdown 注入 prompt。

### SteerQueue (`steer-queue.ts`)

运行时注入队列。**两阶段浮现**：

- A 点（provider 调用前）：peek 临时拼进上下文，本轮立即看到
- C 点（工具结果后）：drain 落 session，下一轮永久可见

### Reporter (`reporter.ts`)

8 个回调接口：`onStart/onTurnStart/onThinking/onToolCall/onToolResult/onMessage/onFinish/onTextDelta?`。注入不同实现切换展现层（TerminalReporter/TuiReporter/FeishuReporter/AcpStreamCollector）。

---

## 关键设计决策

1. **Compact 不改事实**：字符级压缩只作用于发给 LLM 的临时 Context，`RuntimeEventStore` 保留完整事实
2. **流式能力零侵入**：provider 支持 generateStream 时在构造器包装替换 generate，delta 转发给 reporter.onTextDelta
3. **资源冲突图调度**：工具按文件路径×操作类型声明访问意图，冲突图上最大独立集贪心并行
4. **Point of Decision 注入**：Reminder/Guardrail/Steer/Recovery 四套机制都遵循此范式
5. **单例注入范式**：GoalManager/TodoStore/ToolDisclosure 必须 host 创建唯一实例，杜绝跨实例不可见 bug
