# 核心引擎层 (`src/engine/`)

> 引擎是微型 OS 内核：Session 驱动的 Two-Stage ReAct 循环。自身不维护状态，靠外部 Session 推理。

## 文件总览

| 文件 | 行数 | 职责 |
|------|------|------|
| `loop.ts` | ~1316 | AgentEngine 主循环（心脏） |
| `session.ts` | ~853 | Session + SessionManager（会话隔离 + 持久化 + 工作记忆） |
| `session-store.ts` | ~265 | JSONL 事件日志读写器 |
| `reminder.ts` | ~228 | 死循环探测 + ToolGuardrail |
| `goal-manager.ts` | ~243 | 长程目标状态机 |
| `reporter.ts` | ~133 | 事件输出接口（I/O 解耦） |
| `budget.ts` | ~67 | 轮次/Token/成本预算 |
| `steer-queue.ts` | ~47 | 运行时注入引导文本 |

---

## 1. AgentEngine 主循环 (`loop.ts`)

### 核心签名

```ts
class AgentEngine {
  constructor(opts: AgentEngineOptions);
  async run(session: Session, runtimeReporter?, runtimeTracer?): Promise<Message[]>;
  async runSub(taskPrompt, readOnlyRegistry, reporter?, opts?): Promise<SubagentResult>;  // 子代理
  exitPlanMode(): void;  // 审批通过后退出 Plan Mode
  setSteerQueue(q: SteerQueue): void;  // host 后注入
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
│   workingMemory = session.getWorkingMemory(20)  // 滑动窗口       │
│   contextHistory = [systemPrompt, ...workingMemory]              │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 2: 压缩触发                                                 │
│   compactedContext = compactor.compactToBudget(contextHistory)   │
│   失败(ContextCompactionError) → 硬重置兜底(清空历史只留本轮)      │
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
│   session.append(...steerTexts)  // 下一轮 getWorkingMemory 浮现  │
├─────────────────────────────────────────────────────────────────┤
│ 步骤 8: 每轮收尾                                                  │
│   fileHistoryMakeSnapshot(session.fileHistory, messageId)        │
│   turnSpan.end()                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 两层重试叠加

```
generateWithOverflowRetry (外层:响应式压缩降级)
  ├─ attempt 0-2: 渐进字符级降级
  │   ├─ WorkingMemory 条数 × [1.0, 0.7, 0.5, 0.3]
  │   ├─ maxChars 预算 × [1.0, 0.6, 0.4, 0.25]
  │   └─ compactor.compactToBudget(newContext, newBudget)
  ├─ attempt 3: 模型摘要压缩(仅 1 次,防死循环)
  │   └─ fullCompactor.compact(session, retainLastN) → 真改 Session
  └─ 仍失败 → 抛 ContextOverflowError → run() 硬重置兜底
      │
      ▼
generateWithRetry (内层:普通重试)
  ├─ 429/5xx/网络错误 → 指数退避(300ms~5s)重试 3 次
  ├─ 429 + onRateLimited → 切 key 跳过退避
  └─ ContextOverflowError → 不重试(冒泡到外层)
```

### 关键常量

| 常量 | 值 | 作用 |
|------|------|------|
| `MAX_OVERFLOW_RETRY` | 3 | 响应式压缩最大重试 |
| `OVERFLOW_BUDGET_FACTORS` | [1.0, 0.6, 0.4, 0.25] | 字符预算降级系数 |
| `OVERFLOW_MEMORY_FACTORS` | [1.0, 0.7, 0.5, 0.3] | WorkingMemory 条数降级 |
| `MAX_TOOL_CONCURRENCY` | 8 | 工具并发上限 |
| `DEFAULT_WORKING_MEMORY_LIMIT` | 20 | 滑动窗口大小 |
| `maxTurns` 默认 | 50 | 主循环兜底 |

---

## 2. Session (`session.ts`)

### 核心职责
会话物理隔离（并发 run 不共用 history）+ WorkingMemory 滑动窗口 + 事件溯源持久化。

### 关键机制

- **`getWorkingMemory(limit)`**:截取最近 N 条，**丢弃断头孤儿 ToolResult**（切片首条若是孤儿 ToolResult，发出它的 assistant 已被截断，API 直接 400）
- **`append(msg)`**:处理 deferred + toolResultMeta 登记。assistant 带 toolCalls → 登记 pendingToolCallIds；ToolResult 到达 → 从 pending 删除；普通消息且 pending 非空 → 暂存 deferredMessages
- **`serialize(task)`**:per-session 串行执行队列，同一 Session 的 engine.run 必须串行
- **`pendingWrites`**:truncate 落盘前必须 await earlier appends，否则乱序导致崩溃恢复历史丢失
- **LRU + TTL 双重驱逐**:maxSessions=128，TTL=24h

### SessionStore (`session-store.ts`)
JSONL 事件日志：`message`/`truncate`/`undo`/`rewind_to`/`meta`（schema 版本）。
- **末行撕裂容忍**:崩溃 append 写一半正常，末行 parse 失败 break
- **中间行损坏跳过**:旧 throw 会全量丢失有效记录
- **按 seq 排序**:解耦写入顺序与逻辑顺序

---

## 3. 死循环探测 + Guardrail (`reminder.ts`)

### 核心思想
**为什么 System Prompt 拦不住？** 连续同质错误信息占据主导（上下文偏移）+ 近因偏差（模型对末尾信息响应权重高）。

**破局**：在模型做决定的前一刻（Point of Decision），把高优指令伪装成最新 User Message 怼到脸上。

### 三类监控

| 类型 | 说明 | warn | block |
|------|------|------|-------|
| exactFailure | 相同参数失败（MD5 指纹） | 3 次 | 5 次 |
| sameToolFailure | 同工具不同参失败 | 3 次 | 8 次 |
| noProgress | 只读工具连续返回相同结果（SHA256） | 2 次 | 5 次 |

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

1. **Compact 不碰 Session**：字符级压缩只作用于发给 LLM 的临时 Context，写入 Session 的永远是全量真实数据
2. **流式能力零侵入**：provider 支持 generateStream 时在构造器包装替换 generate，delta 转发给 reporter.onTextDelta
3. **资源冲突图调度**：工具按文件路径×操作类型声明访问意图，冲突图上最大独立集贪心并行
4. **Point of Decision 注入**：Reminder/Guardrail/Steer/Recovery 四套机制都遵循此范式
5. **单例注入范式**：GoalManager/TodoStore/ToolDisclosure 必须 host 创建唯一实例，杜绝跨实例不可见 bug
