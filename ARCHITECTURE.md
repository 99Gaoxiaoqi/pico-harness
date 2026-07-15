# pico-harness 全景图

> 一个用 TypeScript 实现的工业级 Agent Harness 引擎。"大模型是 CPU,上下文是内存,工具是外设"——本引擎在一个极简的 ReAct Main Loop 中自主规划与行动。
>
> 本文档按当前主线源码整理。会话与 Agent 运行事实统一写入 workspace
> `runtime.sqlite`；Session 内存状态与 `sessions.db` FTS5 均为可重建投影。

---

## 一、四层架构总览

```
┌────────────────────────────────────────────────────────────────���────┐
│  入口层 (cli / feishu / eval)                                        │
│    CLI 终端 · 飞书 Bot · Benchmark 评估                              │
├─────────────────────────────────────────────────────────────────────┤
│  引擎层 (engine)                                                     │
│    Main Loop(ReAct) · Session(隔离+持久化) · Compactor(降级)        │
│    Reporter(解耦输出) · Reminder(死循环斩断) · Budget(预算)        │
├─────────────────────────────────────────────────────────────────────┤
│  能力层 (provider / tools / memory / context)                        │
│    Provider(模型抽象) · Tool(外设) · Memory(FTS5检索)            │
│    Context(预算+压缩+技能+计划) · Approval(审批)                  │
├────────���────────────────────────────────────────────────────────────┤
│  基座层 (schema / observability / os)                                │
│    Message 协议 · Logger · Tracker(成本) · Trace(决策) · Shell    │
└─────────────────────────────────────────────────────────────────────┘
```

四层各司其职:**入口** 负责把外部请求转成 Session;**引擎** 负责 ReAct 循环与状态管理;**能力** 负责模型通信、工具执行、记忆检索、上下文工程;**基座** 是被所有人依赖的通用原语。

---

## 二、核心:Main Loop(ReAct 循环)

`src/engine/loop.ts` 是整个引擎的心脏。每一轮(turn)做这几件事:

```
┌─ run(session, reporter) ─────────────────────────────────────────┐
│                                                                   │
│  ① 组装 System Prompt                                             │
│     composer.build(turnCount)                                     │
│       = AGENTS.md(身份/红线)                                     │
│       + Skills(外挂技能清单)                                     │
│       + PlanStore(PLAN.md/TODO.md 进度)                          │
│       + MemoryNudger(每 10 轮注入历史摘要)                        │
│                                                                   │
│  ② 读取模型历史                                                   │
│     RuntimeEvent read model                                       │
│       → 严格校验 ToolCall/ToolResult 配对 + 应用 checkpoint       │
│                                                                   │
│  ③ 调用大模型(generateWithRetry)                                 │
│     LLMProvider.generate(messages, tools)                         │
│       → 重试层:429/5xx 退避,ContextOverflow 冒泡                │
│       → 跟踪层:CostTracker 无侵入计费                             │
│                                                                   │
│  ④ 执行工具(单轮并行调度)                                        │
│     ToolScheduler 冲突图调度                                      │
│       → read+read 同文件并行 / write 不同文件并行                │
│       → maxConcurrency=8 名额闸                                    │
│       → 结果保序返回(provider order)                             │
│                                                                   │
│  ⑤ 上下文溢出处理(响应式)                                        │
│     Compactor.compactToBudget(字符级降级)                         │
│     FullCompactor.compact(模型级摘要,真改 history)              │
│                                                                   │
│  ⑥ 错误自愈 + 死循环检测                                          │
│     RecoveryManager:工具报错→注入排障 SOP                        │
│     Reminder:连续失败→SystemReminder 斩断循环                   │
│                                                                   │
│  ⑦ 持久化                                                         │
│     session.commitMessages(...) → runtime.sqlite RuntimeEvent     │
│     → durable 后刷新 Session/FTS 投影，重启后从事件重建           │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**设计哲学**:Main Loop 极简(就是"想→做→看结果"的循环),所有复杂性下沉到能力层,通过注入(provider/registry/composer/budget)组合出无限可能。

---

## 三、模块速查表(50 个源文件)

### 引擎核心 (engine/)

| 文件                                  | 职责                                                                                       | 关键导出                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| `loop.ts`                             | **Main Loop 心脏**:ReAct 循环、工具调度接入、溢出处理、Tracing                             | `AgentEngine`               |
| `session.ts`                          | **会话隔离 + 投影**:per-session 串行、跨进程 owner lease、RuntimeEvent 恢复、FTS5 投影更新 | `Session`、`SessionManager` |
| `runtime/runtime-event-store.ts`      | **唯一事实源**:SQLite 事务追加、全局顺序、eventId exact-once、Session manifest             | `RuntimeEventStore`         |
| `runtime/runtime-run.ts`              | Agent run 生命周期、消息/工具/审批/终态事实写入与未完成 run 恢复                           | `RuntimeRun`                |
| `runtime/runtime-event-read-model.ts` | 从 RuntimeEvent 严格物化模型历史，校验 ToolCall/ToolResult 协议完整性                      | `materializeRuntimeHistory` |
| `budget.ts`                           | 迭代预算:maxTurns/maxTokens/maxCostCNY 耗尽即停                                            | `IterationBudget`           |
| `reminder.ts`                         | 死循环斩断:连续失败注入 SystemReminder                                                     | `ReminderManager`           |
| `reporter.ts`                         | 输出解耦:统一事件接口(终端/飞书/HTTP 各自实现)                                             | `Reporter`                  |

### 模型抽象 (provider/)

| 文件           | 职责                                            | 关键导出                                    |
| -------------- | ----------------------------------------------- | ------------------------------------------- |
| `interface.ts` | Provider 统一契约                               | `LLMProvider`                               |
| `claude.ts`    | Anthropic Messages API 适配                     | `ClaudeProvider`                            |
| `openai.ts`    | OpenAI Chat Completions 适配(原生 fetch,无 SDK) | `OpenAIProvider`                            |
| `factory.ts`   | 创建路由 + 模型回退(glm→kimi 自动切换)          | `createProvider`、`ModelFallbackProvider`   |
| `profile.ts`   | 模型能力差异(窗口/输出/reasoning/cache)         | `ProviderProfile`、`resolveProviderProfile` |
| `config.ts`    | 环境变量读取(baseURL/apiKey/model)              | `loadProviderConfig`                        |
| `errors.ts`    | 错误分类(溢出/状态码)                           | `ContextOverflowError`、`LLMStatusError`    |
| `retry.ts`     | 指数退避重试(429/5xx 自愈,溢出不重试冒泡)       | `generateWithRetry`                         |
| `thinking.ts`  | 慢思考强度统一抽象(off/low/medium/high)         | `ThinkingEffort`                            |

### 工具系统 (tools/)

| 文件                         | 职责                                                     | 关键导出                               |
| ---------------------------- | -------------------------------------------------------- | -------------------------------------- |
| `registry.ts`                | 工具契约 + Middleware 拦截点                             | `BaseTool`、`Registry`                 |
| `registry-impl.ts`           | 工具实现:read/write/edit/bash + 四级模糊匹配 + edit-hint | `ToolRegistry`、`EditFileTool`         |
| `tool-scheduler.ts`          | **冲突图并行调度**:maxConcurrency 名额闸 + 中断信号      | `ToolScheduler`                        |
| `tool-access.ts`             | 资源访问声明:read/write/readwrite/all 路径重叠判定       | `ToolAccesses`                         |
| `edit-hint.ts`               | 编辑失败自愈:charDice 相似度找候选段                     | `findClosestLines`                     |
| `line-endings.ts`            | 行尾编解码:LF/CRLF/mixed 归一化 + 还原                   | `toModelTextView`                      |
| `subagent.ts`                | 子代理委派:独立上下文 + mapLimit 并发上限                | `SubagentTool`                         |
| `delegation-manager.ts`      | 子代理生命周期管理                                       | `DelegationManager`                    |
| `result-summarizer.ts`       | 工具结果摘要(长输出压缩)                                 | `summarizeToolResult`                  |
| `tool-result-observation.ts` | 工具产物外存处理链                                       | `createToolResultObservationProcessor` |

### 上下文工程 (context/)

| 文件                | 职责                                                     | 关键导出                       |
| ------------------- | -------------------------------------------------------- | ------------------------------ |
| `composer.ts`       | **System Prompt 分层组装**:核心+AGENTS.md+技能+计划+记忆 | `PromptComposer`               |
| `context-budget.ts` | 上下文预算切片(窗口-输出-余量)                           | `createContextBudget`          |
| `compactor.ts`      | **字符级阶梯压缩**:掩码→掐头去尾,不碰 toolCalls          | `Compactor`                    |
| `full-compactor.ts` | **模型级全量摘要**:13-section 结构化,真改 history        | `FullCompactor`                |
| `artifact-store.ts` | 大体积 ToolResult 外存(.claw/artifacts/)                 | `ToolResultArtifactStore`      |
| `skill.ts`          | 外挂技能加载(扫 .claw/skills/SKILL.md)                   | `SkillLoader`、`SkillViewTool` |
| `plan-store.ts`     | Plan 状态外部化(PLAN.md/TODO.md 断点续传)                | `PlanStore`                    |
| `recovery.ts`       | 错误自愈提示模板                                         | `RecoveryManager`              |

### 记忆系统 (memory/)

| 文件                | 职责                                                         | 关键导出                             |
| ------------------- | ------------------------------------------------------------ | ------------------------------------ |
| `fts5-store.ts`     | **FTS5 全文检索**:trigram(中文友好),三表(对话/摘要/技能用法) | `FTS5Store`                          |
| `memory-nudger.ts`  | 周期记忆提醒(每 10 轮注入摘要+技能)                          | `MemoryNudger`                       |
| `skill-registry.ts` | 学到的技能追踪(成败统计+自愈,存 .claw/skills/<id>.json)      | `SkillRegistry`                      |
| `skill-schema.ts`   | 技能数据结构定义                                             | `LearnedSkill`、`createLearnedSkill` |

### 可观测性 (observability/)

| 文件         | 职责                                           | 关键导出                              |
| ------------ | ---------------------------------------------- | ------------------------------------- |
| `logger.ts`  | 统一结构化日志(pino)                           | `logger`                              |
| `tracker.ts` | **成本无侵入追踪**:装饰器包 Provider,AOP 拦截  | `CostTracker`                         |
| `pricing.ts` | 定价表(各模型 USD/CNY 单价)                    | `OFFICIAL_PRICING`、`estimateCost`    |
| `trace.ts`   | **决策路径 Tracing**:Span 树落盘 .claw/traces/ | `Tracer`、`Span`、`exportTraceToFile` |

### 入口与系统 (cli / feishu / eval / approval / os / schema)

| 文件                  | 职责                                            | 关键导出                            |
| --------------------- | ----------------------------------------------- | ----------------------------------- |
| `cli/main.ts`         | CLI 主入口 + 飞书启动                           | —                                   |
| `cli/run-agent.ts`    | 单次跑 Agent 的 CLI                             | —                                   |
| `cli/bench.ts`        | Benchmark CLI(npm run bench)                    | —                                   |
| `feishu/bot.ts`       | 飞书 Bot:WSClient 长连接 + 意图过滤 + 审批卡片  | `FeishuBot`、`FeishuReporter`       |
| `eval/benchmark.ts`   | 隔离 workDir 评估运行器                         | `BenchmarkRunner`                   |
| `approval/manager.ts` | **人工审批 Middleware**:高危命令拦截 + 挂起等待 | `ApprovalManager`、`ApprovalPolicy` |
| `os/shell.ts`         | 跨平台 shell(Git Bash on Windows)               | `execAsync`、`resolveShell`         |
| `schema/message.ts`   | Message 协议(role/content/toolCalls/usage)      | `Message`、`ToolCall`、`ToolResult` |

---

## 四、两条核心数据流

### 数据流 A:一条消息从飞书群到模型再回群

```
飞书群消息
  ↓ FeishuBot.handleMessage(意图过滤 shouldWakeAgent)
  ↓ runAgentAndReport(chatId, text)
  ↓ globalSessionManager.getOrCreate("feishu:<chatId>", workDir)   [异步 recover]
  ↓ session.commitMessages({role:"user", content:text})            [RuntimeEvent durable]
  ↓ session.serialize(() => engine.run(session, reporter))         [per-session 串行]
  ↓
┌─ engine.run ──────────────────────────────────────────────┐
│  composer.build() → System Prompt(AGENTS.md+技能+计划+记忆)│
│  session.getWorkingMemory() → 最近 N 条历史                │
│  CostTracker.generate() → 调用模型(重试层兜底)            │
│  ToolScheduler → 并行执行工具(冲突图 + maxConcurrency=8)  │
│  RecoveryManager → 工具失败注入排障 SOP                    │
│  Reminder → 连续失败斩断死循环                              │
│  session.commitMessages(assistant + toolResults) → RuntimeEvent │
└────────────────────────────────────────────────────────────┘
  ↓ FeishuReporter(events → 卡片/消息回群)
  ↓ 高危命令? → ApprovalManager 挂起 → 飞书审批卡片 → 回调唤醒
飞书群收到回复
```

### 数据流 B:上下文溢出的阶梯降级

```
模型返回 ContextOverflowError
  ↓ loop 捕获,触发响应式压缩
  ↓
┌─ 第一道:字符级 Compactor ──────────────────────────────┐
│  远期 ToolResult → 温和摘要 → 全量掩码                  │
│  保护区 ToolResult → 掐头去尾(保留首尾,中间掩码)      │
│  绝不碰 toolCalls(维系逻辑链)                          │
│  → 用更小预算重试 generate                              │
└──────────────────────────────────────────────────────────┘
  ↓ 仍然溢出?
┌─ 第二道:模型级 FullCompactor ──────────────────────────┐
│  用主 provider 把 history 浓缩成 13-section 摘要        │
│  真改 session.history(不是临时 context)                │
│  → 成功则继续,失败则硬重置(truncateTo)                 │
└──────────────────────────────────────────────────────────┘
```

---

## 五、三大工程支柱

### 支柱一:状态外部化(不依赖内存状态机)

pico 将 workspace 运行状态放在 Pico Home 的稳定目录。`runtime.sqlite` 是唯一会话/运行
事实源；其他数据库和内存结构都只能从它重建:

```
~/.pico/workspaces/<workspace-id>/
├── runtime.sqlite     Session + Agent run 的 canonical RuntimeEvent
├── sessions.db        可删除、可从 RuntimeEvent 重建的 FTS5 检索投影
├── traces/            决策路径 JSON
├── artifacts/         大体积工具产物
├── evidence/          压缩后保留的不可变工具证据
├── tasks/             后台任务控制状态
└── storage-operations/ rewind/fork 等操作日志
```

项目级配置、commands、skills、hooks 等仍位于 `<workDir>/.pico/`，但不承载会话历史。

**好处**:重启可从单一事件链恢复；FTS 损坏或删除不会丢失事实，也不会形成第二套真相。

### 支柱二:上下文物理防 OOM

这是整个 context/ 模块的核心使命——**Context Window 是受限 RAM,必须物理管理**:

- **预算切片**:`context-budget.ts` 算出 input token 预算
- **第一道压缩**:`compactor.ts` 字符级降级(掩码/掐头去尾)
- **第二道压缩**:`full-compactor.ts` 模型级摘要(13-section)
- **单条暴击防护**:`artifact-store.ts` 把大 ToolResult 外存
- **滑动窗口**:`session.getWorkingMemory` 截最近 N 条 + 孤儿防护

### 支柱三:全程可复盘

- **成本透视**:`CostTracker` AOP 装饰器,Main Loop 无感知计费
- **决策透视**:`Tracer` Span 树,每个 turn/工具调用都有 X 光
- **错误透视**:`RecoveryManager` 把冷硬 Error 改写成排障 SOP

---

## 六、与对标项目的定位对比

| 维度           | pico-harness                   | kimi-code          | opencode             | hermes-agent    |
| -------------- | ------------------------------ | ------------------ | -------------------- | --------------- |
| **语言**       | TypeScript                     | TypeScript         | TypeScript           | Python          |
| **工具并行**   | 冲突图 + 名额闸                | 冲突图 + recursive | 流式委托 provider    | 白名单 + 线程池 |
| **持久化**     | SQLite RuntimeEvent 单一事实源 | JSONL + fsync      | SQLite + CQRS        | (未确证)        |
| **上下文管理** | 字符级+模型级双压缩            | wire 折叠          | session_message 投影 | (未确证)        |
| **记忆检索**   | FTS5 trigram                   | (无独立)           | (无独立)             | delegate_task   |
| **审批**       | Middleware 拦截                | (未确证)           | (无)                 | (未确证)        |
| **哲学**       | 极简工具集 + 状态外部化        | wire 事件溯源      | 流式 + 委托          | 保守 + 健壮     |

pico 的差异化:**极简工具原语 + RuntimeEvent 单一事实源 + 可重建检索投影 + 字符级与模型级双压缩**。

---

## 七、22 讲演进脉络

| 讲    | 主题                                    | 对应模块                                                 |
| ----- | --------------------------------------- | -------------------------------------------------------- |
| 01    | 四层架构骨架                            | 整体分层                                                 |
| 02    | Main Loop + Schema                      | loop.ts, schema/message.ts                               |
| 03    | Two-Stage ReAct                         | provider/thinking.ts                                     |
| 04    | Provider 双实现                         | claude.ts, openai.ts                                     |
| 05    | ToolRegistry 路由                       | registry.ts                                              |
| 06    | 极简工具集                              | read/write/bash                                          |
| 07    | edit_file 模糊匹配                      | registry-impl.ts (fuzzyReplace)                          |
| 08    | 单轮并行(Fork-Join → 冲突图)            | tool-scheduler.ts, tool-access.ts                        |
| 09    | Reporter + 多入口                       | reporter.ts, cli/, feishu/                               |
| 10    | 动态 Prompt + Skills                    | composer.ts, skill.ts                                    |
| 11    | Session 隔离 + WorkingMemory            | session.ts                                               |
| 12    | ContextCompaction 防OOM                 | compactor.ts, context-budget.ts                          |
| 13    | Plan Mode 状态外部化                    | plan-store.ts                                            |
| 14    | ErrorRecovery 自愈                      | recovery.ts                                              |
| 15    | SystemReminders 斩断循环                | reminder.ts                                              |
| 16    | Middleware 审批拦截                     | approval/manager.ts                                      |
| 17    | Subagent 任务委派                       | subagent.ts, delegation-manager.ts                       |
| 18    | Token 成本追踪                          | tracker.ts, pricing.ts                                   |
| 19    | Tracing 决策复盘                        | trace.ts                                                 |
| 20    | Benchmark 评估                          | eval/benchmark.ts                                        |
| 21-22 | 实战串讲(CLI + 飞书 AgentOps)           | cli/main.ts, feishu/bot.ts                               |
| +     | **RuntimeEvent + FTS5 投影 + 全量压缩** | runtime-event-store.ts, fts5-store.ts, full-compactor.ts |

---

## 八、一图总览

```
                    ┌───────────┐
                    │  飞书/CLI  │  入口层
                    └─────┬─────┘
                          │
                    ┌─────▼─────┐
                    │  Session   │  隔离 + RuntimeEvent 投影
                    └─────┬─────┘
                          │
        ┌─────────────────▼─────────────────┐
        │          Main Loop (ReAct)         │  引擎层
        │  想 → 做 → 看结果 → 再想          │
        └───┬────────┬──────────┬───────────┘
            │        │          │
     ┌──────▼──┐ ┌──▼────┐ ┌──▼──────────┐
     │ Provider │ │ Tools │ │ Context Eng │  能力层
     │ 模型抽象 │ │ 外设  │ │ 预算+压缩   │
     │ 重试韧性 │ │ 冲突图│ │ 技能+计划   │
     └─────────┘ └───────┘ └─────────────┘
            │        │          │
     ┌──────▼────────▼──────────▼──────────┐
     │  Message · Logger · Tracker · Trace  │  基座层
     │              · Shell                  │
     └──────────────────────────────────────┘
                          │
                    ┌─────▼─────┐
                    │ runtime.sqlite │  canonical facts
                    │ sessions.db    │  rebuildable FTS
                    └───────────┘
```

**一句话总结**:pico 是一个"大模型是 CPU、上下文是内存、工具是外设、RuntimeEvent 是运行日志"的极简 ReAct 引擎——所有复杂性都来自对"上下文受限"和"状态易失"这两个物理约束的工程化应对。
