# pico-harness 架构审计与治理

> 文档状态：阶段性审计与治理记录。本文的差距评分和路线是建立时快照，后续已经发生
> runtime-host、SQLite 和 EventLog 收敛；Graph v1 相关符号只是历史叙述，对应代码与兼容层已删除。
> 不要把未勾选项直接当作当前待办。

> 建立日期：2026-08-13
> 标尺：[`19-concepts-map.md`](./19-concepts-map.md) 的 4 条设计原则
> 配套：[`tests/integration/architecture-invariants.test.ts`](../../tests/integration/architecture-invariants.test.ts)（不变量）+ [`scripts/check-architecture-boundaries.mjs`](../../scripts/check-architecture-boundaries.mjs)（门禁）
> 关联：[`09-architecture-debt-remediation.md`](./09-architecture-debt-remediation.md)（D1-D6 旧债，基本已修）

## 0. 一句话

pico 的 4 条设计原则在**叙事态**（账本核心）执行扎实（4/5），但在**调度态**和**机械态**退化为"内存权威 + 补丁驱动"。本文件诊断这些偏离、建立让原则"有牙齿"的治理机制（不变量测试 + 架构门禁 + ADR），并规划统一路径——以**统一网关层**为北极星。

## 1. 4 条原则（标尺）

| 原则                | 含义                                                    | 标尺出处        |
| ------------------- | ------------------------------------------------------- | --------------- |
| **P1 账本唯一权威** | `session.jsonl` 是唯一 canonical 真源，append-only      | 19 文档 1.1-1.2 |
| **P2 一切皆投影**   | 可见状态都从账本重算，无第二事实源                      | 19 文档 1.4     |
| **P3 两层 CAS**     | 高水位 + operationId/指纹 CAS 在文件锁下保证并发互斥    | 19 文档 1.3     |
| **P4 三态分离**     | 叙事(canonical) / 投影机械(重算) / 派生+overlay(Memory) | 19 文档 1.5     |

## 2. 三态诊断（2026-08-13 全局审计）

| 态                              | 健康度    | 状态     | 最严重问题                                                   |
| ------------------------------- | --------- | -------- | ------------------------------------------------------------ |
| **叙事态**（账本/投影/Session） | **4/5**   | 地基扎实 | Memory overlay 复活张力；TaskRunStore 平行账本无跨账本原子写 |
| **调度态**（Graph/委派/工具）   | **2/5**   | 最乱     | `DelegationManager.records` 内存当事实权威 + 双去重权威倒挂  |
| **机械态**（IPC/daemon/多外壳） | **2.5/5** | 补丁驱动 | 超时无统一抽象 + 多外壳连接状态三套不互通                    |

### 三个跨态系统性根因

**根因 A — 内存层承担事实权威（违反 P1/P2）**
该 durable 或非权威缓存的东西，留在了进程内且不能丢。典型：`DelegationManager.records`（`src/tools/delegation-manager.ts:171`）既是活跃工作表又是历史状态表，终态不敢 delete；更糟的是它**设计性不可持久化**——孤儿检测依赖"重启后 records 清空返回空集"这个负信号。这是结构性悖论：**作为事实权威的层恰好是禁止持久化的层**。对比 maka：durable CAS admission 保证"重读重派不变双派"，内存层从一开始就非权威、可丢弃。

**根因 B — 同一职责多套实现（补丁驱动）**

- 超时原语：3 套 `settleWithinDeadline` + 2 套 `withTimeout` + 多处内联 `Promise.race`（→ 阶段 1 收敛为 `raceWithDeadline`/`raceWithDeadlineReject` 2 个原语）。
- 多外壳连接状态机：Desktop（fail-stuck 无恢复路径）/ daemon-client（无限重连）两套不互通——daemon 重启后传输层自愈，renderer 却卡"请重启 Pico 应用"（移动端已于 2026-08 移除，不再计入）。
- 去重：durable CAS 被降级为 best-effort、内存层升为 load-bearing 权威（权威倒挂）。

**根因 C — Graph Mode 架构欠账**
无真 DAG、无法预声明；`DelegationManager`（tools 层）承载 graph/plan 调度职责（`onGraphWorkSettled`/graphWorkId 去重），职责错位；子代理自报完成掩盖失败，无内容级熔断。**最讽刺的发现**：pico 的 `CronRuntimeScheduler.claim`（`src/tasks/cron-runtime-scheduler.ts:123`）和 `TaskRunStore.claims`（`src/tasks/task-run-store.ts:170`）**已经实现了 maka 式 durable claim admission**，但 graph/delegation 层没复用，而是另起"内存权威"炉灶。

## 3. 治理机制（让原则有牙齿）

漂移的根源是**原则只活在文档里、没有强制力**——补丁一急就绕过。治理的核心是反转成本结构：让违反原则的补丁在 CI 就失败。

### 3.1 不变量测试（`tests/integration/architecture-invariants.test.ts`）

把 19 文档的关键断言变成可运行测试，文档与实现双向锁定：

- 事件账本无事件级 GC
- `appendBatch` 是 RuntimeEventStore 内唯一写原语
- 投影入口（`RuntimeProjectionService`）/压缩器（`Compactor`）不直接写账本（无第二事实源）
- **known-debt 活体追踪**：`DelegationManager.records` 不可重建等 P0/P1 债（D7/D9/D11/D12）是**普通测试**，断言"债务表征当前存在"——债务在 → 测试绿；债务被修复 → 表征消失 → 测试红，提醒开发者删除/反转断言。`test.todo` 的 body 永不执行、追踪全靠人记，已被弃用；修复落地时由红测试强制显式处理

### 3.2 架构门禁（`scripts/check-architecture-boundaries.mjs`）

复用现有范式（导出 scan 函数 + fixture 注入 + baseline + `lint` 串联 + CI 双跑）。本轮新增：

- **横切唯一性**（`scanCrossCuttingDefinitions`）：`settleWithinDeadline`/`withTimeout` 等超时原语不得本地重定义，统一用 `src/util/race-with-deadline.ts`。
- 既有的 import 边界规则（engine→runtime、provider→input 等）继续生效。

> **职责边界（DelegationManager 错位）不门禁化**：它是语义级耦合（IoC 回调 `onGraphWorkSettled`），import 级检查抓不到且会误伤合法的 `graph-tools.ts`。这类靠 ADR + review 守护。

### 3.3 ADR（架构决策记录）

每个跨层改动 / 新增状态机 / 新增持久化，PR 须填一行：

```
本次改动 [遵守/影响/违反] 原则 P_（账本权威/投影/CAS/三态），理由：__
若是新增进程内状态：崩溃后从 <durable源> 重建 / 标 @process-local-cache 非权威缓存
```

这不是官僚——它逼补丁作者**显式承认**是在强化还是绕过抽象。`records` Map 当年若有这一行，"我正让内存层变事实权威"就会被看见。

### 3.4 原则 → 机制映射

| 原则            | 不变量测试                    | 门禁       | ADR                                        |
| --------------- | ----------------------------- | ---------- | ------------------------------------------ |
| P1 账本唯一权威 | 账本无 GC、appendBatch 唯一写 | —          | 新增持久化须回答"是否第二事实源"           |
| P2 一切皆投影   | 投影/压缩不写账本             | —          | 新增内存状态须回答"崩溃如何重建"           |
| P3 两层 CAS     | —                             | —          | 状态变更须走 appendBatch CAS，不得绕过     |
| P4 三态分离     | records known-debt 追踪       | 横切唯一性 | tools 层不得承载 graph 调度（review 守护） |

## 4. 统一路径（阶段路线图）

### 阶段 0：治理护栏 ✅ 本轮落地

- 0a 不变量测试（冻结叙事态 4/5）
- 0b 横切唯一性门禁
- 0c 本文档

### 阶段 1：超时抽象 ✅ 本轮落地

全栈 12 处手写超时（`connectWithTimeout` 除外）收敛为 `raceWithDeadline`（resolve-false，排空/截止）+ `raceWithDeadlineReject`（reject，请求/握手）；`connectWithTimeout`（`src/daemon/client.ts`，socket 事件式）不在收敛列，属阶段 3 网关层收口。顺带修 `goal-evaluator.ts` 的 timer 泄漏。

### 阶段 2：claim 推广（调度态 P0，后续立项）

用 `RuntimeStore.acquireLease`（`src/tasks/runtime-store.ts:368`）给 graph work dispatch 套 `graph-work:${workId}` durable lease：

- `DelegationManager.records` 从事实权威降为非权威缓存（dispatch 去重读 lease，不再 O(n) 扫历史）
- orphan 恢复按 lease 活性判定（不再靠"重启清空返回空集"负信号）
- 移除 `settleFinalized` 补丁
- **难点**：异步 delegation 生命周期 + lease TTL 策略（subagent 跑数分钟，非 cron 的 30s）；finish 侧保持 ownerless 幂等（settle 在异步回调/重启后发生）。最小落点不动 graph 事件 schema，外挂 RuntimeStore lease。

### 阶段 3：统一网关层（北极星，multi-round）

## 5. 北极星：统一网关层

**问题**：pico 多外壳不一致（根因 B）的根因是**缺统一接入层**。maka 的所有外壳（Desktop/TUI/CLI/bot）都经由同一个 `RuntimeHostConnection` 契约（`packages/runtime-host/src/client/connection.ts:156`）连接到同一个 `RuntimeHostKernel` 守护进程——连接状态机、重连、transcript 分页/连续性、超时全部在网关层收口，外壳只做展示。maka 全仓只有**一套**连接状态机、**一个** transcript 分页实现。pico 则是 desktop 直连 daemon IPC、TUI 进程内装配——两条不同构路径（移动端已于 2026-08 移除）。

**目标**：引入统一 `RuntimeHostConnection` 契约，所有外壳经由它接入，状态/重连/transcript/连续性在网关层统一。

**借鉴 maka**：

- 契约可直接借鉴：`RuntimeHostConnection`（单一状态机：握手、pending 请求、存活检测、订阅复用）+ `ClientSurface` 枚举 + `ClientSessionSubscription.loadTranscript`（统一分页 + `snapshot_expired`）+ `SessionContinuityService`（重连状态）。
- **决定性差异**：maka 的 TUI 是经 socket 连接的客户端（`surface: 'tui'`），**不是进程内装配**。pico 的 TUI 需同样改为客户端。

**不照搬（传输）**：maka 只有本地 socket（`node:net`），pico 外壳同样只走本地 socket（移动端已于 2026-08 移除，不再需要 WS/远程传输）。外壳代码（及状态/transcript/连续性逻辑）传输无关。

**迁移路径**（顺序）：

1. 由 `packages/runtime-host/` 承载通用网关契约（`RuntimeHostConnection` + `ClientSurface`），本地 socket 单传输（3-A/3-B 已落地）。
2. 统一连接状态机、重连策略、transcript 分页（吸收 `loadGeneration`/`conversationLoadGenerationsRef` 到网关客户端）。
3. Desktop 改为经网关客户端接入（取代直连 daemon IPC + 自维护 ConnectionState）。
4. TUI 从进程内装配改为 socket 客户端（最大改动，最后做——部署模型变更，见下）。

**部署模型变更（TUI 迁移风险评估）**：TUI 改客户端不是纯重构，而是**部署模型变更**——CLI 从"单进程"变成"CLI 客户端 + 宿主进程"。现状：`src/cli/main.ts` 直接 `startTuiRepl`（`src/tui/repl.tsx:1203`）进程内装配，`src/cli/` 无任何 daemon 依赖、无 spawn/headless 逻辑。改客户端后需重设计：

- **进程生命周期**：宿主进程（网关/daemon）由 CLI 常驻派生还是按需 spawn？CLI 退出时宿主如何回收（孤儿进程）？repl 退出/崩溃后连接如何恢复？
- **headless/离线兼容**：现有 CLI 无头可用（纯进程内、无 daemon 依赖）；改客户端后无宿主时如何降级——`pico run`/CI/脚本类调用不能依赖交互式宿主常驻。
- **降级路径**：保留一条不经网关的进程内/直连路径（如 headless 标志走进程内装配），避免 TUI 迁移阻塞其它外壳先拿到网关收益。
- 排序仍放最后，但**工作量不是"改一个组件"而是"重设计部署模型"**，需单独立项评估，不宜与 1-3 混在同一轮。

**与 LocalDaemonHost 的关系（叠加，非替换）**：统一网关层**叠加于 `LocalDaemonHost` 之上**，不是另起炉灶：

- 网关 = `packages/runtime-host/`（本地 socket 单传输）+ 统一契约层（`RuntimeHostConnection`/`ClientSurface`/transcript 分页/连续性），移动端已移除，无 WS 面。
- `LocalDaemonHost`（`src/daemon/runtime-host.ts`，生产装配 `src/daemon/production-host.ts:90`，入口 `src/daemon/main.ts`）保留为 **RuntimeHostKernel 等价物**——外壳/传输层的对端，不随网关升级而消失；daemon IPC 作为网关的服务端后端之一，`connectWithTimeout` 的 socket 事件式语义由网关收口。
- 即 maka 的 `RuntimeHostKernel` ↔ pico 的 `LocalDaemonHost`；maka 的 `RuntimeHostConnection` ↔ pico 新建的网关契约。外壳只与契约层对话，daemon 不感知外壳差异；Desktop 直连 daemon 的旧路径降级保留（`ConnectionState` 由网关客户端接管后仅作降级回退）。

## 6. 架构债清单（本轮新增，对接 09）

09 的 D1-D6（CLI transcript 恢复、Markdown 统一、AgentRuntime 窄拆等）基本已修。以下是本次审计新增的债：

| 编号    | 债务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 态        | 级别 | 阶段        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- | ----------- |
| **D7**  | ~~`DelegationManager.records` 内存事实权威 + 双去重倒挂~~ 已消除（2026-08-13，`8a2fb41c`）：graph work 执行主权去重改 durable lease（`graph-work:id`，RuntimeStore.acquireLease，TTL/心跳协议单一实现于 `src/graph/work-lease.ts`），settle 链 `records.delete` 使 records 降为非权威活跃表，orphan 恢复按 lease 活性（isWorkLeaseLive）判定，liveDelegationIds/settleFinalized 双去重倒挂删除；D7 正向追踪器已反转（architecture-invariants）                                                                                                                                                                                                                                                                                                                                                                                                           | 调度      | P0   | 阶段 2 ✅   |
| **D8**  | 超时原语全栈散落（3+2+多处）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 机械      | P0   | 阶段 1 ✅   |
| **D9**  | ~~多外壳连接状态/重连不互通（缺网关层；移动端已移除）~~ 已消除（3-C，2026-08-15）：连接决策收口在 main runtime-supervisor + 共享 client，renderer 只渲染推送相位；追踪器已反转                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 机械      | P0   | 阶段 3 ✅   |
| **D10** | ~~Graph 无真 DAG、无内容级熔断、DelegationManager 职责错位~~ 已收口（2026-08-16，拆分处置）：①"无真 DAG"经 18-graph-mode 判定为有意设计（record 驱动依赖，无需 DAG 拓扑校验），撤销子债；②lease 协议（TTL/资源键/acquire/heartbeat/release/活性判定）从 tools 层提取到 `src/graph/work-lease.ts` 唯一实现点，DelegationManager 只消费不定义（D10 正向追踪器已反转）；③settle 回调扇出按 §3.2 判定为语义级耦合，维持宿主侧 settle 协调器不引入（扩大 settle 窗口有 graph 死锁教训，session-runtime:864）；④~~内容级熔断转独立 P2 行为债~~（已落地 2026-08-17：runSub 完成出口内容级判定——总结开篇失败宣言（剥引导标签、保守锚定防误伤）把自报 completed 降级 error，SubagentResult 拓宽 error 态，settleGraphWork 铸 graph.work.failed 而非 recorded；FINALIZE 提示词同步要求失败时以「无法完成：原因」开篇。测试 subagent-content-circuit-breaker 3 条） | 调度      | P1   | 阶段 2/3 ✅ |
| **D11** | ~~Memory overlay 复活链（forgetFact 后账本保留原始来源，派生重建绕过 forget postcondition）~~ 已收口（2026-08-17，Source 提取抑制）：forgetFact 在同一事务为 Fact 的 Source 落 `extractionSuppressedAt`（sourceId 由证据内容确定性哈希，同证据恒同 Source）；提取链路双重拦截——engine 在模型调用前查抑制即取消 Job（`memory_source_suppressed`，零模型调用），commitExtraction 事务内权威兜底（并发 forget 竞态窗）。隐私优先取舍：同 Source 其余 Fact 也停止从该证据更新；仅抑制同证据——用户后续对话重新陈述属正常再学习（新 Source）。边界：overlay 整体丢失（state.json 无备份）时抑制标记随之丢失——与其他用户意图（manual fact）同边界，从备份恢复。测试 memory-forget-suppression（版本升级复活路径实盘断言）                                                                                                                                       | 叙事      | P1   | ✅          |
| **D12** | ~~`DesktopRuntimeService.close` 截止线外推 + transcript 同步双实现~~ 双实现实质随移动端移除消解；护栏收编 ConversationLoadTracker，分页算法只在 daemon 服务层；追踪器已反转（3-C，2026-08-15）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 机械      | P1   | 阶段 3 ✅   |
| **D13** | ~~`history.rewound`/`branchId` schema 化石、fork 预校验缺口、graph-reducer 注释漂移~~ 已收口：主体 `f45053dd`（2026-08-13）——fork 语料落账前 reducer 预校验（防御性兜底转 staging_corrupt）、graph-reducer 注释对齐 inputIds 实现、`history.rewound` 转正式 `LEGACY_DECODE_ONLY_KINDS` 守卫（decode-only 有意保留解旧账本，生产被拒）；memory domain availability 已收敛 available/unavailable（守卫测试 memory-rebuild:481）；尾巴清理（2026-08-17）——wire 层死值摘除：`RuntimeMemorySourceMetadata.availability` 的 `"rewound"` 与 `memory.changed.change` 的 `"source_rewound"`（daemon 只产 updated/resolved/source_unavailable，渲染层零消费；source_unavailable 为 deleteSession 失效通知活值，保留）+ Desktop fixture/MemoryPage 死分支；`branchId` 作为历史溯源字段有意保留（旧 memory 文件磁盘解码容忍，无新生产者）                            | 叙事/调度 | P2   | 清理 ✅     |

## 7. 积极面

叙事态（代码核心）确实干净：账本 append-only 无 GC、两层 CAS 完整、投影无第二事实源、Memory 派生层可重建、压缩边界与文档吻合、owner-lease 是 fence 非事实源。**地基是稳的，乱的是上层两层的"贯彻纪律"**。治理机制（不变量测试 + 门禁）的目的就是冻结地基、强制上层回到原则。

## 8. Hook 威胁模型对齐 Claude Code（2026-08-17）

command hook 执行模型从"静态信任钉死"彻底转向"shell 化 + 配置字节审批"，一次三方对比驱动的哲学重构：

|             | 命令形态          | 解析时机        | 威胁假设                                             | 脏 PATH 容忍                    |
| ----------- | ----------------- | --------------- | ---------------------------------------------------- | ------------------------------- |
| Claude Code | 任意 shell 字符串 | 运行时 shell 内 | 命令可信，防"hook 干坏事"（网络沙箱）                | 完全容忍                        |
| maka-agent  | 无 hooks 功能     | —               | —                                                    | —                               |
| pico 旧     | exec-form 单命令  | 绑定时钉死      | 环境不可信，防"hook 变成别的文件"                    | 零容忍（脏 PATH 静默杀死 hook） |
| pico 新     | 任意 shell 字符串 | 运行时 shell 内 | 命令=用户意图，信任锚=配置字节指纹 + workspace trust | 完全容忍                        |

**删除**：PATH 钉死、可执行文件 canonical 身份、shebang 解释器链、引用文件哈希、执行前 TOCTOU revalidate、package-manager/转发器禁令、Windows .exe-only 规则。审计粒度从文件字节降为配置字节（已确认取舍）。

**保留**：环境消毒（剥离 base env 的 loader 注入变量，防第三方篡改用户意图）、handler.env 覆盖全放行（配置即意图）、指纹审批机制、Git Bash 可用性探测（残缺安装的转发 stub 会被拒并回落 PowerShell）。

**新增**：workspace trust 成为 dispatch 信任锚（每次 dispatch 边界复验，撤销信任后 executable hooks 自然失效——memory 同款每边界复验模式；daemon 装配链注入宿主共享实例）。

**代价**：现存 command hooks 的 trusted-hooks.json 记录一次性失配需重新 `/hooks trust`（旧死记录自动迁移剪除，`d4f38f1d`：判据=scriptHashes 非空，读取即剪除落盘）；批准后 npm/git 本体被掉包不再被抓（运行时 PATH 说什么就是什么）；Windows POSIX 风格 hook 依赖 Git Bash（缺失时落 PowerShell，`&&` 需 pwsh 7+）。

实现：`src/hooks/config/command-shell.ts`（取代 referenced-scripts.ts）+ executor shell spawn + 信任库指纹收缩 + workspace trust 锚。测试：hook-command-shell 套件（含原始 `%AccessAgentLibs%` 脏 PATH 场景）。
