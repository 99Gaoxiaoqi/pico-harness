# pico-harness 核心概念地图

> 大模型是 CPU，上下文是内存，工具是外设，RuntimeEventStore 是可恢复的运行事实账本。
> 整个项目的命脉可以用一句话概括：**一条 append-only 账本 + 一切皆投影 + 两层 CAS 互斥**。

本文是给新读者的「一眼看懂」全景图，把事件驱动/账本（核心中枢）与四条辐射主线（Graph 调度、上下文组装、进程架构、工作区记忆）压成一张可检索的地图。所有断言附 `file:line` 锚点，便于回源核对。

---

## 0. 一张图看懂整体

```text
                         ┌──────────────────────────────────────┐
                         │   RuntimeEventStore  ← 唯一 canonical │
                         │   sessions/<sha256>/session.jsonl     │
                         │   append-only · 事件溯源 · 不可改写    │
                         └──────────────────┬───────────────────┘
                                            │ appendBatch()  ← RuntimeEventStore 内唯一写入原语
                     ┌──────────────────────┴──────────────────────┐
            withLedgerStoreLock（文件锁 + 原子重命名 commit-marker + fsync）
                     │
                     ├── 高水位 CAS  → 串行追加，防并发写错位
                     └── operationId + 指纹 CAS → plan/graph 状态机 exactly-once
                                            │
        ┌──────────┬──────────┬───────────┼────────────┬──────────────┐
        ▼          ▼          ▼           ▼            ▼              ▼
    Messages    Transcript   Plan       Graph        Memory        Usage
    (喂 LLM)    (UI 视图)   (状态机)   (DAG 投影)   (派生投影)     (计费统计)
        │
   Messages / Transcript / UI / Usage 是 RuntimeProjectionService 重算的派生投影；
   Plan / Graph 各有独立 reducer，也从同一账本折叠；Memory 是派生 + overlay 复合体。
   没有任何一个投影升级为「第二事实源」。
```

**一句话**：所有发生的事都先记进 `session.jsonl` 这个不可变账本；你看到的对话、界面、计划、DAG、记忆，都是从账本「投影」出来的派生视图，坏了随时能重算。

---

## 一、核心中枢：事件驱动 + 账本

### 1.1 RuntimeEvent（事件）

带信封的判别联合类型：`eventId / sessionId / invocationId / runId / turnId / at / kind / data / visibility / partial`（`src/engine/session-runtime-event.ts:36`）。

`kind` 共 **32 种**，全部收录在 `RUNTIME_EVENT_KINDS`（`src/storage/runtime-event.ts:62`）内：13 个 plan 事件（来自 `PLAN_EVENT_KINDS`，`src/plan/events.ts:8`，spread 而入）+ 5 个 graph 事件（直接字面量）+ 14 个运行 / 消息 / 工具 / 审批 / 模型调用 / 检查点 / 会话类。整体分运行 / 消息 / 工具 / 审批 / 模型调用 / 检查点 / 会话 / 计划 / 图 **九类**。注意别遗漏 `approval.requested/settled` 与 `model.call.started/settled` 这两类。

**持久化铁律**：

- 已写入的 `eventId` 不可变——同 `eventId` 换 payload 会被拒绝（`runtime-event-store.ts:452` 抛 `RuntimeEventStoreIntegrityError`）。
- **完整行**（带合法换行）若 JSON 非法或校验失败 → 让操作**抛错**，不静默修复。
- **未提交的撕裂尾部**（末行无换行，崩溃半写）→ 默认 `repairIncompleteTails=true`（`runtime-event-store.ts:253`）会在下次加载时**静默截断**回上一条完整记录（`local-file-storage.ts:381`）。这不算「破坏不可变」：按 commit-marker 协议，没有合法换行的尾部本就未发布。`readOnly` / 诊断模式（`repairIncompleteTails:false`）才改为抛错。

### 1.2 appendBatch：账本的唯一写入原语

在 `RuntimeEventStore` 内，`appendBatch`（`src/storage/runtime-event-store.ts:362`）是 `session.jsonl` 的唯一写入原语；`append / appendSessionState / appendTranscriptEvent / appendPlanOperation / appendGraphOperation` 全是它的包装。它在 `withLedgerStoreLock`（`src/storage/ledger-store-lock.ts:59`）文件锁内，把一批事件封成一条 `event-batch` JSONL，用「临时文件 → fsync → 原子重命名」提交（底层原语 `commitFileTransactionSync`，`local-file-storage.ts:426`）。

> 注意：`TaskRunStore` 是另一套**独立账本**（`task-runs/`），有自己的 `appendBatch`（`task-run-store.ts:317`），与 RuntimeEventStore 平行，不互相委托。所以「唯一写原语」是限定在 RuntimeEventStore 内的。

### 1.3 两层 CAS 互斥（账本之所以叫账本）

不用数据库，纯靠 CAS 在共享文件锁下保证并发安全：

| CAS 层                     | 防什么                         | 机制                                                                                            |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| **高水位 CAS**             | 并发追加串行化                 | `expectedSessionHighWater`，条数不符抛 `HighWaterConflictError`（`runtime-event-store.ts:469`） |
| **operationId + 指纹 CAS** | plan/graph 状态机 exactly-once | 同 operationId 不同指纹抛 `PlanOperationConflictError`（`runtime-event-store.ts:412`）          |

高水位 CAS 是**可选**入参（`:382`），且当整批全是重复事件（`!hasNewEvent`）时在 `:458` 提前返回、跳过校验。锁模板 `withLedgerStoreLock` 被 RuntimeEventStore 与 TaskRunStore 共用。

### 1.4 投影（Projection）：账本的读模型

`RuntimeProjectionService`（`src/engine/runtime-projection-service.ts:69`）是消息 / transcript / state / usage / fork-seed 的**统一投影入口**：`getSessionView / getMessages / getState / getUsage / getTranscriptEntries / getForkSeed` 全是「读账本 → 跑纯投影函数」。

注意：**plan / graph 投影不在该 service 内**。plan 走 `PlanCoordinator.project()` → `projectPlanEntries`（`src/plan/reducer.ts:12`）；graph 走 `graph-reducer.ts`。但三者都从同一个 canonical 账本折叠，没有第二事实源。

### 1.5 三态模型（log-first 对齐后）

| 态                   | 是什么                         | 代表                                             |
| -------------------- | ------------------------------ | ------------------------------------------------ |
| **叙事态 canonical** | 唯一真相，append-only          | `session.jsonl`                                  |
| **投影 / 机械态**    | 从账本重算的派生视图           | messages / transcript / UI / usage               |
| **派生 + overlay**   | 既可从账本重建，又叠加用户编辑 | **Memory**（派生层可重建，overlay 层是用户意图） |

Memory 的派生层在 `memory/state.json` 损坏时可从账本 `rebuildDerivedFromRuntimeEvent`（`src/memory/memory-rebuild.ts:51`）重建——这是 log-first 对齐重构（commit `ce7f7d8c` 系列）的核心成果。同一重构把破坏性 rewind 改成**非破坏性 fork**（新建 session，原账本永不改，跨账本引用永远有效，`src/engine/session-fork-service.ts:97`），并删除了 `branchId`。

### 1.6 两条独立的「证据」管线（切勿混淆）

项目里有两个名字相近但**完全不同**的概念，最容易混：

**(a) 工具输出证据链** —— 控制大块 tool-result 撑爆上下文。单一规范链：

```text
工具原始输出 ──► tool.result.recorded 事件 ──► 有界投影(1600 字符预览)
                         │                        │
                         └─ body=evidence:        └─ ToolResultEnvelope(喂 Provider)
                            只留 {storage,sha256,sizeBytes}    可调 read_evidence 分页回读
                            + refs.evidence: RuntimeEvidenceReference (内容寻址 CAS, SHA-256)
```

- 不变量：`message.committed` **永不**携带 `toolCallId` 与 `toolResultEvidenceUri`（`runtime-event.ts:184`）——只有 `tool.result.recorded` 能携带工具结果。
- `body=evidence` 只存 `{storage, sha256, sizeBytes}` 三个字段（`runtime-event.ts:539` 强校验 only-keys），**不存 URI**。`pico://evidence/...` URI 由 `ToolResultEnvelope` 投影层在喂 Provider 时现拼（`src/engine/tool-result-contract.ts:87`），不进账本。
- 引用类型是 `RuntimeEvidenceReference`（`src/engine/tool-result-contract.ts:8`，字段 `{schemaVersion, contentHash, sessionId, kind:"tool-exchange"}`）。

**(b) Memory provenance 的 `EvidenceRef`** —— 是 **Memory 层**的零持久化覆盖层契约（`src/engine/evidence-ref.ts:47`）；与工具证据链的差异字段含 `coverage / digest / toolCallId / providerCallId`（完整定义另有 `sessionId / invocationId / runId / turnId / schemaVersion` 等会话身份车道），把离散 eventId 升级成可校验的事件区间游标，服务于 Memory 派生层的溯源，**不持久化、不引入新事实源**。它的全部使用方都在 memory 域（`memory/domain.ts` 等）。

> 一句话区分：工具结果大块输出用 `RuntimeEvidenceReference`（内容寻址 CAS）；Memory 记忆的来源溯源用 `EvidenceRef`（事件区间游标）。两者字段不重叠。

### 1.7 Plan Ledger：账本里的事件状态机

Plan **不是**独立的 PLAN.md 文件，而是 13 种 `plan.*` 事件在账本里折叠出的状态机。`PlanCoordinator`（`src/plan/coordinator.ts:40`）是**用户意图转换**（propose / approve / execute / replan / cancel / ...）的规范入口；每个转换经 `commit()`（`:373`）：重放去重 → 算指纹 → 预校验 reducer → `appendPlanOperation`（CAS）。纯函数 `reducePlanEvent`（`src/plan/reducer.ts:34`）强制「只能一个 pending 提案」「已终止步骤不可重开」等不变量。

> ⚠️ **PlanCoordinator 不是唯一写入者**。fork 重建路径（`src/engine/session-fork-service.ts:477`）在分叉时**直接 `appendBatch`** 写两类事件：`plan.step.recovered`（把继承的 in_progress 步骤重置为 pending）与 `plan.execution.interrupted`（标记继承的执行为中断）。这两类是 fork 语料、不属于用户意图转换，其中 `plan.step.recovered` 在 PlanCoordinator 根本没有对应公共方法。

Graph Mode **复用同一套 CAS**：`appendGraphOperation`（`runtime-event-store.ts:584`）内部走 `planOperation` 信封，注释明说「CAS 契约相同」。

### 1.8 持久化与删除边界

- **事件账本内没有事件级 GC**：`RuntimeEventStore` 对 entries 无 delete / trim / prune。账本在 session 生命周期内永久存在。
- **事件账本内唯一删除方式**是 `deleteSession`（`runtime-event-store.ts:763`）：锁内把整个 session 目录原子重命名为 `.deleted-*` 墓碑名 → 校验 → `rmSync` 物理删。墓碑是瞬时中转态，删完即消失，**不留持久墓碑记录**。
- ⚠️ 但「无删除」**只限定事件账本**。系统其他 store 各有清理：FileHistory 快照超 100 条会裁剪（`src/safety/file-history.ts:37,716`）；Memory 的 `forgetFact` 可把 fact 墓碑化（`src/memory/memory-repository.ts:731`）。这些是各自 store 的独立清理，与事件账本无关。
- **投影域限定**：第 0 章总纲「一切可见状态皆投影」的作用域是 **session 运行时核心**（messages / transcript / plan / graph / memory / usage，见第 0 章图）。workspace 侧另有独立文件 store——FileHistory（文件快照）、TodoStore（`todo.json`，每轮注入 turnTail 但不经账本）——它们会注入 prompt 却无法从事件账本重建，属账本投影域之外的补充事实层，在总纲作用域之外、不挑战总纲。
- 压缩**永不改账本、永不删事件**：只追加 `context.checkpoint.recorded`，投影时用 summary 替换旧前缀（读模型变化）。

---

## 二、辐射主线：Graph Mode（DAG 调度）

把「线性 `delegate_task`（串行阻塞 + 依赖靠主 Agent 手动转述）」升级为显式编排：多个无依赖工作并行派发，`input_ids` 显式声明依赖。默认关闭，由正交于 `collaborationMode` 的 `orchestrationMode`（`"default" | "graph"`）开启。

| 点                      | 说明                                                                                                                                                                                                                                                                                                                                                                                                                         | 锚点                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **依赖建模**            | `GraphWork.inputIds`（字符串数组）引用上游 `recordId`。两个确定性哈希：`workIdFor(graphId, instruction, sorted(inputIds))` 与 `recordIdFor(graphId, workId)`，纯哈希、跨 run 稳定                                                                                                                                                                                                                                            | 定义 `src/graph/contract.ts:38,45`                                                            |
| **无 `dependsOn` 字段** | 全仓 `git grep dependsOn` 在 src + tests 范围零命中（plan-mode 的 `PlanStep` 另有同名概念，仅出现在 `ARCHITECTURE.md` 文档层）                                                                                                                                                                                                                                                                                               | —                                                                                             |
| **无显式拓扑排序**      | 依赖语义简化为「record 存在 = 就绪」：`computeReadyWorks` 过滤 `inputIds` 全到齐且状态 `requested` 的 work                                                                                                                                                                                                                                                                                                                   | `src/graph/graph-reconcile.ts:7`                                                              |
| **增量调度**            | 三条触发：(a) `add_work` 即时就绪派发；(b) `settleGraphWork` 写终态后重读投影、对新就绪下游链式派发；(c) 主 Agent 准备停止时注入 `[Graph continuation]` 自救                                                                                                                                                                                                                                                                 | `src/tools/graph-tools.ts:201 · src/runtime/session-runtime.ts:866 · src/engine/loop.ts:2046` |
| **Orphan 恢复**         | 进程崩在子代理执行期 → work 卡 `dispatched`。关键纠错：早期错误用 `delegationId === runId` 匹配（二者是独立 id 空间永不相等），正确判据是「dispatched 且 delegationId 不在 `liveDelegationIds` 里」。启动序列 `reconcileIncompleteRuns → repairSessionProjection → recoverOrphanGraphWorks → RuntimeRun.start` 跑一次恢复，对 orphan 标 failed + recovered。**不自动 reclaim**（无幂等 claim token，重派会重复 side effect） | `src/graph/graph-recover.ts:38`、`src/runtime/runtime-run-executor.ts:106`                    |
| **零新存储**            | **项目中不存在 `GraphControlStore`**；全仓无该类型，仅 `src/runtime/agent-runtime.ts:1769` 有一个异名局部别名 `graphStore = session.runtimeEventStore`。5 种 `graph.*` 事件写同一 canonical 账本，`projectGraphEntries` 幂等折叠                                                                                                                                                                                             | `src/graph/graph-reducer.ts:195`                                                              |

### Graph Mode 的三个已知边界

多轮真实模型测试发现三个点，定性如下：

1. **`close_graph` 不拒绝带 pending 的关闭**（设计性软报告，非 bug）：返回 `pendingWorks` 清单 + 分级 warning（requested 不会再调度；dispatched 仍会完成写 record 但不触发下游）。对标 maka `finish` 只断言 result_ids。`src/tools/graph-tools.ts:417`。
2. **closed 后 `add_work` 被拒绝**（已修复并锁测试）：`AddWorkTool` 在 `status === "closed"` 时抛 `GraphConflictError`，reducer 额外防御性忽略 added 事件（双层守卫）。`src/tools/graph-tools.ts:160`、`src/graph/graph-reducer.ts:114`、`tests/e2e/graph-mode-multiround.real-llm.test.ts:447`（T6）。
3. **子代理「自报完成」会掩盖失败，且无内容级熔断**（已知边界，风险较高）：子代理遇到不可完成任务时返回 `completed` + summary「无法完成」而非 `error`；`settleGraphWork` 把 `completed/partial` 一律写 `recorded`（`src/runtime/session-runtime.ts:803`）。**graph 调度层不做任何 outputSummary 内容校验**——`computeReadyWorks` 只看 record 是否存在不看内容，于是掩盖的失败 record 会让下游 work 立即 ready 并**自动链式派发**，烧下游预算产垃圾 record 再级联。续行仲裁器（只看 pending 数）和死锁检测器（看 `missingInputIds`）都不读 summary，无法自动熔断。**唯一缓解**是主 Agent 主动调 `view_graph` 人工识别失败文本。详见 `docs/architecture/18-graph-mode.md:222`。

---

## 三、辐射主线：上下文组装 + 渐进式披露 + 压缩

### 3.1 上下文组装公式

每轮喂 LLM = `[systemPrompt] + 历史投影 + ToolResult 投影`，再把 `turnTail` 追加到最后一条普通 user 消息尾部，包在 `<current-turn-context>` 标签里（这个标签对 prompt-cache 命中很重要）。

- 分层：`PromptComposer.buildLayers()`（`src/context/composer.ts:94`）把**静态**进 systemPrompt、**动态**进 turnTail
- 组装主路径：`prepareModelContext`（`src/engine/loop.ts:1184`）+ `appendTurnTail`（`src/engine/loop.ts:285`）
- 协议修复（孤儿 / 重复工具结果）：`sanitizeToolPairs`（`src/context/compactor.ts:526`），只修请求副本、不写回 Session

> 项目里**没有** `assembleContext` / `ContextBuilder` 这类命名——组装器叫 `PromptComposer`，记忆召回器叫 `MemoryContextBuilder`。

**turnTail 每轮注入的运行态**：除工作区记忆外，turnTail 还每轮注入**两层任务运行态**——**Goal**（长程目标 + budget 状态机，`src/engine/goal-manager.ts:113`，属 1.5 三态中的投影态、经 `session.state.committed` 进账本可重放重建）与 **Todo**（原子任务清单，`src/context/todo-store.ts:53`，落在 workspace 独立的 `todo.json`、不经账本，属 workspace store，见 1.8）。两者是 Goal(长程) / Plan(路径) / Todo(原子) 三层任务模型的上下层；中层 **Plan 只活在账本状态机（见 1.7），不进 turnTail**。

### 3.2 渐进式披露 5 系统

统一模式：**默认只给有界摘要，完整层靠显式调用回取，摘要永不丢信息**。

| 系统             | 摘要层（默认给）                  | 回取工具                                              |
| ---------------- | --------------------------------- | ----------------------------------------------------- |
| **工具**         | 10 个 `CORE_TOOLS` 常驻           | `search_tools` 激活扩展（下轮生效）                   |
| **Skill**        | 只注入 name + description         | `skill_view` 读正文                                   |
| **Tool Result**  | 1600 字符 head-tail 预览          | `read_evidence` 分页（全量压缩后旧 ref 失效，见 3.3） |
| **Repo Map**     | 字母序渐进索引，`cursor` 游标推进 | 重复调用直至 `complete=true`                          |
| **explore_repo** | 本身即摘要报告                    | —                                                     |

- `CORE_TOOLS` 恰 10 个（`src/tools/tool-tiers.ts:13`）。披露是**软引导**：未披露工具 registry 仍按全集路由执行。
- Tool Result 预览：单条输出 > **2048 token** 触发归档 Evidence（`src/tools/tool-result-observation.ts:8`），模型只拿 **1600 字符** head-tail 预览（`:7`）。注意 envelope 文本另有 16 KiB 二次裁剪上限。
- `explore_repo` 是**确定性零-LLM DFS 侦察**（`src/tools/explore-repo.ts`），取代了被删的 Discovery 重量级状态机（实删源码约 2133–2531 行，commit `25444369`）。与 repo_map 互补：repo_map 字母序渐进索引适合精确查询，explore_repo DFS 适合一次性侦察。

### 3.3 压缩（Compaction）

账本永不改写，只追加 `context.checkpoint.recorded`，投影时用 summary 替换旧前缀。降阶链：

1. **字符级投影**：旧 ToolResult → 1 行摘要 marker，零成本（`src/context/compactor.ts:83`）。注意这与上文「1600 字符 head-tail 预览」是两套不同机制（前者是 compactor 请求期压缩，后者是 canonical 投影）。
2. **LLM 摘要**：6 段结构化模板（任务目标 / 进展 / 关键决策与约束 / 已尝试失败路径 / 下一步 / 关键上下文，`src/context/full-compactor.ts:57`）。
3. **overflow 重试**：provider 返回 `ContextOverflowError`（`src/provider/errors.ts:21`）时，复用同一个 FullCompactor + 更紧的 `targetRetainedTokens` 重压（是 #2 的触发变体，非独立机制）。
4. **硬重置兜底**：清空历史但保留最近 **8 条**结构化证据快照（`src/engine/loop.ts:3823`）。

触发双水位：轮中 **75%**（`MID_TURN_COMPACT_TRIGGER_RATIO`，`loop.ts:113`）/ 轮前 **85%**（`DEFAULT_AUTO_COMPACT_TRIGGER_RATIO`，`loop.ts:105`）。滚动摘要做**增量更新**（读上一 checkpoint 的 `summaryText` 而非重算，避免「摘要的���要」衰减）；checkpoint 带 `sourceDigest`（对被覆盖事件取 SHA-256，重放校验防篡改）+ `previousCheckpointId`（链式回溯）。压缩 fail-open（失败不抛错，把机会留给 overflow 重试）。

> ⚠️ **evidence URI 与全量压缩的边界**：字符级投影承诺「evidence 引用永不折叠」（`src/context/compactor.ts:369`），但全量压缩（`compact` / `strongerCompact`）会摘要化含 `pico://evidence/...` URI 的 content、使模型丢失可见的句柄（`toolResultEvidenceUri` 字段仍在，但从不回灌给模型）。被折叠的旧证据内容仍在 CAS store（账本未丢），但模型事后**无法再通过 `read_evidence` 回读**——除非 URI 恰被某条仍可见的消息复述。这是渐进披露承诺与激进压缩实现之间的一致性边界。

---

## 四、辐射主线：进程架构 + 工具系统 + 安全

### 4.1 进程边界：「多外壳、单 Runtime、单 daemon」

```text
   TUI ────────────────►  AgentRuntime（进程内直接装配）
   Desktop(Electron) ──┐  默认经 LocalRuntimeClient 连接本机 daemon（candidate）；
                        └──► LocalDaemonHost ──► 真正跑 AgentRuntime 的地方
                                                   (DesktopRuntimeService)
```

- daemon：`LocalDaemonHost`（`src/daemon/runtime-host.ts:28`），文件头注释明确「永不 import 或静默回退到前台 AgentRuntime」。
- IPC 认证：256-bit token，每次启动轮换，第一帧必须是 auth 帧（`src/daemon/ipc-auth.ts:8`、`src/daemon/server.ts:53`）。客户端请求复用一条认证长连接，每个订阅独占一条连接。
- Desktop：`apps/desktop/src/main/index.ts` 持有 `DesktopDaemonController` 托管 host。**Renderer 永不直接加载 Runtime**——经 `preload/bridge.ts` 走 IPC 到 Electron Main 再到 daemon。

### 4.2 Provider 集成

`LLMProvider`（`src/provider/interface.ts:71`）刻意最小化：只有 `generate` 必填，`generateStream` 可选。**Provider 不实现 `generateStream` 时，loop 直接用非流式 `generate`，不合成流式**（`src/engine/loop.ts:876`：无 generateStream 则原样返回 provider）。`maxOutputTokens` 是线上硬上限，reasoning effort 不能覆盖（`src/provider/openai.ts:755`）。

> **整个 provider 层没有跨模型 fallback**（`createProvider` 不读 env、不做 fallback，`src/provider/factory.ts:35`）。容错只在同模型内做凭证轮换：429 切 key（`src/provider/retry.ts:195`）+ 指数退避。

### 4.3 工具系统（中间件执行链）

`ToolRegistry.execute()`（`src/tools/registry-impl.ts:208`）严格顺序：

```text
路由查找 → Hardline/Plan/Trust 安全门(useSafety，不可绕过)
        → PreToolUse Hook(可 deny/改写) → 改写后重过安全门
        → 权限/人工审批 → preWriteHook → ExecutionMiddleware 洋葱 → tool.execute
```

- Registry **不截断结果**（`:326` 原样返回 output），canonical 投影只由 Engine 做一次（`loop.ts:2847`）。
- 同批 toolCalls 按资源冲突图调度（任一方含写且路径归一化后相等 = 冲突），`MAX_TOOL_CONCURRENCY=8`（`loop.ts:1024`，注意 `tool-scheduler.ts` 自身默认 Infinity，是 Engine 传 8 才生效），结果按 provider 原始顺序保序回传。

### 4.4 子代理 = Registry 里的普通工具

`spawn_subagent` / `delegate_task`（`src/tools/subagent.ts`）执行时挂起主循环，拉起匿名一次性子 Engine。**隔离是逻辑级而非 OS 级**：全新 contextHistory + 受限 registry；worker 模式**必须在独立 Git worktree**（缺 `worktreeSupervisor` 直接拒绝，`subagent.ts:554`），但子代理 Engine **仍跑在主进程内**，不存在 Worker/worker_thread/子进程沙箱。爆炸半径：`maxSubTurns` 默认 10（`loop.ts:3453`，可覆盖）、`maxSpawnDepth` 默认 2（`subagent.ts:228`）。委派由 `DelegationManager`（`src/tools/delegation-manager.ts:168`）用 `delegationId` 跟踪。

### 4.5 安全 / Hooks / Plugins

- **审批中枢** `src/approval/manager.ts`：高危操作挂起当前执行流（模型无感）→ 人类裁决 → 唤醒，内置 **30 分钟**超时自动判 Reject（`:83`）。
- **不可绕过底线** `src/approval/bash-hardline.ts`：**只对指向受保护系统路径**（home / `/` / `Windows` / 关键根）的 `rm -rf` / `dd` / `git push --force` / `mkfs` 等不可审批绕过；**工作区内的普通递归删除仍交给 YOLO / 审批正常执行**（文件头注释 `:43`）。这是核心区分，别误以为工作区内 rm -rf 也被 hardline 挡掉。
- `FileHistory`（`src/safety/file-history.ts`）：文件快照 + rewind/fork journal + backup，是 write/edit 原子发布与回退的基础设施。
- Hooks（`src/hooks/service.ts:60`）：每次 dispatch 固定 snapshot，热重载不影响在途事件；PreToolUse 在安全门之后、审批之前，可 deny/ask。
- Plugins 三级 scope（local=3 > project=2 > user=1）+ winner selection（`src/plugins/plugin-scope.ts:73`）。

---

## 五、辐射主线：工作区记忆（Memory）

跨会话事实记忆，四类：preference / correction / project_fact / reference。

- **触发（模型举手）**：`memory_remember`（前台同步）/ `memory_extract`（后台异步），`eco` 模式不注册 → 零成本（注册门控在 `src/runtime/agent-runtime.ts:1476`，`if (... && memoryReviewMode !== "eco")`）。
- **提取**：单独的模型调用，不注入工具（传 `[]`）；有源对话快照时把提取 prompt 追加在其末尾（`src/memory/worker.ts:408`），否则独立 system + user。要求 `Return JSON only`，纯文字无 JSON → 空候选跳过。
- **被动注入（不是主动 recall）**：每次 user 消息，runtime 用 `MemoryContextBuilder.build` 按相关性召回 **top-3 / ≤320 token**（`src/memory/context-builder.ts:5`），但**仅当工作区通过 `memoryTrustStore` 信任校验时**才注入（否则降级跳过，`agent-runtime.ts:1550`），作为 `<current-turn-context>` 块塞进 turnTail（非 system prompt）。整个召回路径全程确定性打分，**无任何 model recall 调用**。
- **相关性打分**：路径命中 ×8 + token 命中 ×4 + CJK bigram（封顶 +4）+ 命令意图（+6）（`context-builder.ts:204`）。`pinned` / `correction` 仍被 `relevanceScore` 计分，但在 `compareCandidates` 中由 `isStrongCandidate` 强候选层前置——其分数不决定是否入选（强候选整体排在非强候选之前，`context-builder.ts:245`）。

---

## 六、容易误解的点（已逐条限定边界）

| 误解                               | 真相                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 有 `GraphControlStore`             | **不存在**（全仓仅一个局部别名 `graphStore`），5 种 graph 事件全架在 RuntimeEventStore 上                                                              |
| Graph 用 `dependsOn` 字段          | **不存在**（src + tests 零命中），靠 `inputIds` 引用 `recordId`；plan-mode 的 `PlanStep` 另有同名文档概念                                              |
| 有事件 GC                          | 事件账本内无 GC；**事件账本内唯一删除**是整 session 目录级联删除。FileHistory 快照超 100 裁剪、Memory `forgetFact` 是各自 store 的独立清理，与账本无关 |
| Memory 是独立权威                  | log-first 对齐后是「派生投影 + 用户 overlay」复合体，可从账本重建                                                                                      |
| TodoStore 是账本投影               | **否**——独立 `todo.json`，每轮注入 turnTail 但不��账本（见 1.8）                                                                                       |
| 压缩会删事件                       | 不会，只追加 `context.checkpoint.recorded`，投影时替换前缀（读模型变化）                                                                               |
| Provider 有跨模型 fallback         | **没有**，只同模型凭证轮换                                                                                                                             |
| Memory 主动 recall                 | **被动注入**，runtime 按当前 user 消息确定性打分召回 top-3                                                                                             |
| 有显式拓扑排序                     | 没有，依赖语义简化为「record 存在 = 就绪」                                                                                                             |
| rewind 改写历史                    | log-first 对齐后 rewind = **非破坏性 fork**（新建 session，原账本永不改）                                                                              |
| loop 把 generate 包成流式          | **方向反了**：Provider 不实现 generateStream 时直接降级用非流式 generate，不合成流式                                                                   |
| 子代理有 Worker 沙箱               | **没有** OS 级沙箱；子代理 Engine 同进程，靠 worktree + 受限 registry 做逻辑隔离                                                                       |
| hardline 拦所有 rm -rf             | **不**：只拦指向受保护系统路径的；工作区内递归删除走 YOLO/审批                                                                                         |
| PlanCoordinator 是唯一写入者       | **不是**：fork 重建路径直接 appendBatch 写 `plan.step.recovered` / `plan.execution.interrupted`                                                        |
| 账本损坏一律抛错                   | 已提交完整行非法→抛错；崩溃撕裂尾部→默认静默截断（commit-marker 协议本就未发布）                                                                       |
| 工具证据链 = Memory 的 EvidenceRef | **两个不同概念**：工具大块输出用 `RuntimeEvidenceReference`（内容寻址 CAS）；Memory 溯源用 `EvidenceRef`（事件区间游标）                               |

---

## 七、概念速查表

| 概念                           | 一句话                                                        | 锚点                                          |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------------- |
| **RuntimeEventStore**          | 唯一 canonical 账本，append-only JSONL                        | `src/storage/runtime-event-store.ts:362`      |
| **appendBatch**                | RuntimeEventStore 内唯一写原语                                | 同上                                          |
| **withLedgerStoreLock**        | 共享文件锁 + 原子重命名模板（两个 Store 共用）                | `src/storage/ledger-store-lock.ts:59`         |
| **高水位 CAS**                 | 串行追加互斥（throw `:469`）                                  | `runtime-event-store.ts:469`                  |
| **operationId + 指纹 CAS**     | plan/graph exactly-once（throw `:412`）                       | `runtime-event-store.ts:412`                  |
| **RuntimeProjectionService**   | 消息/transcript/state/usage 统一投影入口（不含 plan/graph）   | `src/engine/runtime-projection-service.ts:69` |
| **RuntimeEvidenceReference**   | 工具大块输出的内容寻址 CAS 引用                               | `src/engine/tool-result-contract.ts:8`        |
| **EvidenceRef**                | Memory provenance 的事件区间游标（零持久化）                  | `src/engine/evidence-ref.ts:47`               |
| **PlanCoordinator**            | plan 用户意图转换规范入口（非唯一写入者）                     | `src/plan/coordinator.ts:40`                  |
| **reducePlanEvent**            | plan 纯函数 reducer（强制不变量）                             | `src/plan/reducer.ts:34`                      |
| **GoalManager**                | 长程目标 + budget 状态机，每轮注入 turnTail                   | `src/engine/goal-manager.ts:113`              |
| **TodoStore**                  | 原子任务清单，每轮注入 turnTail（独立 todo.json，非账本投影） | `src/context/todo-store.ts:53`                |
| **session-fork-service**       | 非破坏性 fork + 写 recovered/interrupted 事件                 | `src/engine/session-fork-service.ts:477`      |
| **GraphWork / inputIds**       | maka 式 record-id 依赖                                        | `src/graph/contract.ts:6`                     |
| **workIdFor / recordIdFor**    | 纯哈希确定性 id（跨 run 稳定）                                | `src/graph/contract.ts:38,45`                 |
| **computeReadyWorks**          | 「record 存在 = 就绪」调度                                    | `src/graph/graph-reconcile.ts:7`              |
| **recoverOrphanGraphWorks**    | 崩溃孤儿恢复（标 failed + recovered）                         | `src/graph/graph-recover.ts:38`               |
| **PromptComposer.buildLayers** | system(静态) / turnTail(动态) 分层                            | `src/context/composer.ts:94`                  |
| **sanitizeToolPairs**          | 协议修复（孤儿/重复工具结果）                                 | `src/context/compactor.ts:526`                |
| **explore_repo**               | 零-LLM 确定性 DFS 侦察                                        | `src/tools/explore-repo.ts`                   |
| **MemoryContextBuilder**       | 被动 top-3 召回注入（需信任门控）                             | `src/memory/context-builder.ts:5`             |
| **LocalDaemonHost**            | daemon 内部生命周期所有者                                     | `src/daemon/runtime-host.ts:28`               |
| **ToolRegistry.execute**       | 中间件执行链（不截断结果）                                    | `src/tools/registry-impl.ts:208`              |
| **DelegationManager**          | 子代理委派跟踪                                                | `src/tools/delegation-manager.ts:168`         |
| **bash-hardline**              | 只兜受保护系统路径的破坏性命令                                | `src/approval/bash-hardline.ts:43`            |

---

> **记住三件事，这个项目 80% 的设计就通了**：① 一条 append-only 账本是唯一真源；② 一切可见状态都是它的派生投影；③ 两层 CAS 在文件锁下保证并发互斥。剩下 20% 是围绕上下文窗口这个稀缺资源做的渐进式披露 + 压缩，以及把账本哲学延伸到调度（Graph Mode）和多外壳进程边界。
