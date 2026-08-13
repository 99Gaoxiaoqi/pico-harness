# pico-harness 架构审计与治理

> 建立日期：2026-08-13
> 标尺：[`19-concepts-map.md`](./19-concepts-map.md) 的 4 条设计原则
> 配套：[`tests/integration/architecture-invariants.test.ts`](../../tests/integration/architecture-invariants.test.ts)（不变量）+ [`scripts/check-architecture-boundaries.mjs`](../../scripts/check-architecture-boundaries.mjs)（门禁）
> 关联：[`09-architecture-debt-remediation.md`](./09-architecture-debt-remediation.md)（D1-D6 旧债，基本已修）

## 0. 一句话

pico 的 4 条设计原则在**叙事态**（账本核心）执行扎实（4/5），但在**调度态**和**机械态**退化为"内存权威 + 补丁驱动"。本文件诊断这些偏离、建立让原则"有牙齿"的治理机制（不变量测试 + 架构门禁 + ADR），并规划统一路径——以**统一网关层**为北极星。

## 1. 4 条原则（标尺）

| 原则 | 含义 | 标尺出处 |
|---|---|---|
| **P1 账本唯一权威** | `session.jsonl` 是唯一 canonical 真源，append-only | 19 文档 1.1-1.2 |
| **P2 一切皆投影** | 可见状态都从账本重算，无第二事实源 | 19 文档 1.4 |
| **P3 两层 CAS** | 高水位 + operationId/指纹 CAS 在文件锁下保证并发互斥 | 19 文档 1.3 |
| **P4 三态分离** | 叙事(canonical) / 投影机械(重算) / 派生+overlay(Memory) | 19 文档 1.5 |

## 2. 三态诊断（2026-08-13 全局审计）

| 态 | 健康度 | 状态 | 最严重问题 |
|---|---|---|---|
| **叙事态**（账本/投影/Session） | **4/5** | 地基扎实 | Memory overlay 复活张力；TaskRunStore 平行账本无跨账本原子写 |
| **调度态**（Graph/委派/工具） | **2/5** | 最乱 | `DelegationManager.records` 内存当事实权威 + 双去重权威倒挂 |
| **机械态**（IPC/daemon/多外壳） | **2.5/5** | 补丁驱动 | 超时无统一抽象 + 多外壳连接状态三套不互通 |

### 三个跨态系统性根因

**根因 A — 内存层承担事实权威（违反 P1/P2）**
该 durable 或非权威缓存的东西，留在了进程内且不能丢。典型：`DelegationManager.records`（`src/tools/delegation-manager.ts:171`）既是活跃工作表又是历史状态表，终态不敢 delete；更糟的是它**设计性不可持久化**——孤儿检测依赖"重启后 records 清空返回空集"这个负信号。这是结构性悖论：**作为事实权威的层恰好是禁止持久化的层**。对比 maka：durable CAS admission 保证"重读重派不变双派"，内存层从一开始就非权威、可丢弃。

**根因 B — 同一职责多套实现（补丁驱动）**
- 超时原语：3 套 `settleWithinDeadline` + 2 套 `withTimeout` + 多处内联 `Promise.race`（→ 阶段 1 收敛为 `raceWithDeadline`/`raceWithDeadlineReject` 2 个原语）。
- 多外壳连接状态机：Desktop（fail-stuck 无恢复路径）/ Mobile（10 次封顶）/ daemon-client（无限重连）三套不互通——daemon 重启后传输层自愈，renderer 却卡"请重启 Pico 应用"。
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
- **known-debt 活体追踪**：`DelegationManager.records` 不可重建 → 标 `test.todo`，阶段 2 修复后转正向断言

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

| 原则 | 不变量测试 | 门禁 | ADR |
|---|---|---|---|
| P1 账本唯一权威 | 账本无 GC、appendBatch 唯一写 | — | 新增持久化须回答"是否第二事实源" |
| P2 一切皆投影 | 投影/压缩不写账本 | — | 新增内存状态须回答"崩溃如何重建" |
| P3 两层 CAS | — | — | 状态变更须走 appendBatch CAS，不得绕过 |
| P4 三态分离 | records known-debt 追踪 | 横切唯一性 | tools 层不得承载 graph 调度（review 守护） |

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

**问题**：pico 多外壳不一致（根因 B）的根因是**缺统一接入层**。maka 的所有外壳（Desktop/TUI/CLI/bot）都经由同一个 `RuntimeHostConnection` 契约（`packages/runtime-host/src/client/connection.ts:156`）连接到同一个 `RuntimeHostKernel` 守护进程——连接状态机、重连、transcript 分页/连续性、超时全部在网关层收口，外壳只做展示。maka 全仓只有**一套**连接状态机、**一个** transcript 分页实现。pico 则是 mobile 有网关、desktop 直连 daemon IPC、TUI 进程内装配——三条不同构路径。

**目标**：引入统一 `RuntimeHostConnection` 契约，所有外壳经由它接入，状态/重连/transcript/连续性在网关层统一。

**借鉴 maka**：
- 契约可直接借鉴：`RuntimeHostConnection`（单一状态机：握手、pending 请求、存活检测、订阅复用）+ `ClientSurface` 枚举 + `ClientSessionSubscription.loadTranscript`（统一分页 + `snapshot_expired`）+ `SessionContinuityService`（重连状态）。
- **决定性差异**：maka 的 TUI 是经 socket 连接的客户端（`surface: 'tui'`），**不是进程内装配**。pico 的 TUI 需同样改为客户端。

**不照搬（传输）**：maka 只有本地 socket（`node:net`），无移动/远程。pico 的 mobile 是网络远程，需 WS + 重连 + 移动认证。所以 pico 的网关要支持**双传输**：本地 socket for Desktop/TUI，安全 WS for Mobile。外壳代码（及状态/transcript/连续性逻辑）传输无关。

**迁移路径**（顺序）：
1. 把 `src/mobile-gateway/` 升级为通用网关（支持本地 socket + WS 双传输），定义 `RuntimeHostConnection` 契约 + `ClientSurface`。
2. 统一连接状态机、重连策略、transcript 分页（吸收 `loadGeneration`/`conversationLoadGenerationsRef` 到网关客户端）。
3. Desktop 改为经网关客户端接入（取代直连 daemon IPC + 自维护 ConnectionState）。
4. TUI 从进程内装配改为 socket 客户端（最大改动，最后做）。

## 6. 架构债清单（本轮新增，对接 09）

09 的 D1-D6（CLI transcript 恢复、Markdown 统一、AgentRuntime 窄拆等）基本已修。以下是本次审计新增的债：

| 编号 | 债务 | 态 | 级别 | 阶段 |
|---|---|---|---|---|
| **D7** | `DelegationManager.records` 内存事实权威 + 双去重倒挂 | 调度 | P0 | 阶段 2 |
| **D8** | 超时原语全栈散落（3+2+多处） | 机械 | P0 | 阶段 1 ✅ |
| **D9** | 多外壳连接状态/重连三套不互通（缺网关层） | 机械 | P0 | 阶段 3 |
| **D10** | Graph 无真 DAG、无内容级熔断、DelegationManager 职责错位 | 调度 | P1 | 阶段 2/3 |
| **D11** | Memory overlay 复活链（forgetFact 后账本保留原始来源，派生重建绕过 forget postcondition） | 叙事 | P1 | 后续 |
| **D12** | `DesktopRuntimeService.close` 截止线外推 + transcript 同步双实现 | 机械 | P1 | 阶段 3 |
| **D13** | `history.rewound`/`branchId` schema 化石、fork 预校验缺口、graph-reducer 注释漂移 | 叙事/调度 | P2 | 清理 |

## 7. 积极面

叙事态（代码核心）确实干净：账本 append-only 无 GC、两层 CAS 完整、投影无第二事实源、Memory 派生层可重建、压缩边界与文档吻合、owner-lease 是 fence 非事实源。**地基是稳的，乱的是上层两层的"贯彻纪律"**。治理机制（不变量测试 + 门禁）的目的就是冻结地基、强制上层回到原则。
