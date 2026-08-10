# Pico 与 Maka 状态管理架构对比分析

> 本文对比 pico-harness 的"四账本事实所有权分离"和 maka-agent 的"log-first, projection-driven"两种状态管理架构，分析各自的设计取舍、优势、代价，以及 Pico 如果要向 Maka 思想对齐可以做什么、应该做什么、不应该做什么。

---

## 一、先纠正一个常见误解

**两个项目都不是"单一存储"。**

| 项目 | 物理 Store 数量 | Store 列表 |
|------|----------------|-----------|
| Pico | 4 | RuntimeEventStore、TaskRunStore、RuntimeStore、MemoryRepository |
| Maka | 5+ | RuntimeEventStore、SessionStore、AgentRunStore、MessageReceiptStore、(可选)InteractionStore，且按 interactive/headless 二分 |

差异不在 Store 数量，而在**Store 之间的关系模型**：

- **Pico**：四个账本是**并列的独立真源**，各有自己的锁、CAS、commit 协调器，通过弱外键引用
- **Maka**：一个 canonical semantic log（RuntimeEventStore）是**唯一真源**，其他 Store 是**投影或 operational index**，通过单向 ref 指向 log

---

## 二、两种架构模型

### 2.1 Pico：事实所有权分离（四账本）

```
RuntimeEventStore (sessions/)     ← 会话叙事事实（append-only JSONL）
        │                          ← 独立锁 .storage/lock
        │  弱外键引用
        ├─────────── MemoryRepository (memory/)
        │            ← 跨会话事实记忆（JSON 快照 + revision + 审计）
        │            ← 独立锁 memory/lock
        │
        ├─────────── TaskRunStore (task-runs/)
        │            ← 显式可恢复任务（append-only JSONL）
        │            ← 共享锁 .storage/lock
        │
        └─────────── RuntimeStore (control/)
                     ← 控制面（jobs/leases/usage/outbox）
                     ← 共享锁 .storage/lock
```

核心原则（`ARCHITECTURE.md:96-118`）：

> 四类 Store 各自有明确的所有权边界。RuntimeEventStore 是会话事实的唯一真源；TaskRunStore 是任务事实的唯一真源；RuntimeStore 是控制面的唯一真源；MemoryRepository 是结构化长期记忆的独立 authority。

**每个账本都是自己领域的权威**，不承认其他账本是自己的上位真源。跨账本一致性靠显式协调（2PC 模拟、lifecycle Job、全量重扫恢复）。

### 2.2 Maka：Log-first, Projection-driven

```
RuntimeEventStore (runtime-events.jsonl)  ← 唯一 canonical semantic log
        │
        ├── 投影 → SessionStore (StoredMessage)      ← UI/兼容投影
        ├── 投影 → AgentRunStore (run.json + events)  ← operational index
        ├── 投影 → model history                      ← 下一次模型调用看到的 messages
        ├── 投影 → compaction checkpoint              ← 有损压缩投影
        ├── 派生 → MemoryItem (SQLite)                 ← 从 log 提取的派生事实
        └── 派生 → tool_operations (SQLite)            ← 从 log 重建的投影
```

核心原则（`runtime-core-architecture-draft.zh-CN.md:49`）：

> Runtime Event Log 才是 Agent 交互的语义事实源。系统在某一时刻的状态，是这段有序日志经过某种投影之后的结果。
>
> `State(t) = Project(RuntimeEvents[0..t], policy, runtime configuration)`

**RuntimeEventStore 是全局唯一真源**。其他 Store 回答不同问题（UI 展示什么、Run 当前状态、压缩后的工作上下文），但**不是并列真源**——它们要么是投影（可从 log 重建），要么是 operational index（加速诊断）。

---

## 三、设计决策对比

### 3.1 rewind 语义

这是两种架构差异最大的地方。

| 维度 | Pico | Maka |
|------|------|------|
| rewind 是什么 | 追加 `history.rewound` 事件 + 切换 branchId + **文件回滚** | 创建新 Session（fork），**旧 ledger 永不修改** |
| canonical log | 事件仍在但 active branch 切换 | 完全 immutable，从未修改 |
| 其他账本怎么响应 | 需要显式协调（Memory lifecycle Job 标记 Source 为 rewound；TaskRunStore **不感知 rewind**） | 天然安全——旧 Session 的投影不变，新 Session 是新对象 |

**Pico 的 rewind 风险**：

- Memory 和运行态账本用**不同的物理锁**（`memory/lock` vs `.storage/lock`），永远不可能原子提交——rewind 中途崩溃会产生部分态
- TaskRunStore **完全不处理 `history.rewound`**（grep 在 `src/tasks/` 零命中）——checkpoint 引用的 terminal 事件在 rewind 后可能已不可达，任务被静默 park

**Maka 为什么没有这个问题**：rewind 是 non-destructive fork（`session-manager.ts:5032` `reviseBeforeTurn`），旧 Session 的 RuntimeEvent ledger 从未被修改。所有指向旧 Session 的 ref（Task Ledger 的 sessionId/runId、Memory 的 MemoryItemSource）仍然有效——因为旧数据还在，没动过。

### 3.2 跨账本一致性

| 维度 | Pico | Maka |
|------|------|------|
| 原子提交边界 | 运行态三账本可共享 `.storage/lock` 做串行互斥，但各自独立 commit；Memory 完全隔离 | RuntimeEventStore 一次 append 全有或全无 |
| 跨域操作 | rewind/delete/fork 需要 2PC 模拟 + fail-closed 补偿 | 不存在跨域——所有状态投影自同一 log |
| 悬空引用 | Memory Source 的 eventIds、TaskRun boundary 的 terminalEventId 都是弱外键 | 不可能——rewind 不修改旧 log，ref 永远有效 |

### 3.3 schema 演进

| 维度 | Pico | Maka |
|------|------|------|
| 版本管理 | 每个账本独立 schemaVersion（Memory 已到 v2，其他 v1） | RuntimeEvent **无版本字段**，靠 closed-domain key/value 校验 + 可选字段 |
| 加字段的影响范围 | 只影响本账本 | 影响 RuntimeEvent + 所有投影消费者 |
| 演进独立性 | ✅ 强——Memory v1→v2 不碰 RuntimeEvent | ❌ 弱——加字段要检查所有投影 |
| 兼容策略 | 每个账本的 `decodeXxx` 严格校验本账本 schemaVersion | V1/V2 共存 fallback（如 compaction checkpoint V1→V2）+ diagnostics |

### 3.4 故障隔离

| 维度 | Pico | Maka |
|------|------|------|
| 一个账本损坏 | 只影响本账本，其他不受影响（`StorageDoctor` 按账本独立 repair） | canonical log 损坏 → 所有投影失效 |
| Memory 损坏 | 可从 RuntimeEvent 重新提取 evidence | Memory 是 SQLite 派生存储，损坏可从 RuntimeEvent 重新提取 |
| RuntimeEvent 损坏 | TaskRun 可独立恢复（有自己的 ledger） | 全部投影失效，但有 `backfillMissingRuntimeEvents` 兜底 |

### 3.5 性能隔离

| 维度 | Pico | Maka |
|------|------|------|
| 锁竞争 | `.storage/lock` 三账本共享（串行瓶颈）；Memory 独立锁（不竞争） | 取决于 SQLite + JSONL 的实现 |
| 大查询阻塞 | Memory 大查询不阻塞 RuntimeEvent 写入（不同锁） | 同一 RuntimeEventStore 的读写竞争取决于实现 |

---

## 四、Pico 如果要对齐 Maka 的思想

### 4.1 不应该做的：合并四个账本为单 log

这是最激进的对齐方式，但代价远大于收益：

1. **放弃 schema 独立演进**：Pico 的 Memory 已经从 v1 演进到 v2，没有碰 RuntimeEvent。合并后改一个字段要检查所有投影
2. **放弃故障隔离**：一个账本损坏不再只影响自己
3. **改动量巨大**：~14,000 行核心状态管理代码要重写
4. **Maka 自己也没有真正"单 log"**：它有 5 个物理 Store，只是把它们定位为"投影/operational index"而非"并列真源"

### 4.2 应该做的：对齐"真源唯一性"思想

**核心思路**：不合并物理 Store，但在逻辑层面确立 RuntimeEventStore 的 canonical 真源地位，让其他账本成为"有独立存储的投影"而非"并列真源"。

#### 改进 1：让 TaskRunStore 感知 rewind（高优先级）✅ 已通过改进 3 消除

改进 3 把 rewind 改为 non-destructive fork 后，旧 Session 不变，TaskRun 的 checkpoint ref 永久有效——这个问题从根源上消除了，不再需要单独修复。

#### 改进 2：确立 Memory 为"有独立存储的派生投影" ✅ 已落地

已在 `ARCHITECTURE.md` 中把 Memory 从"独立 authority"改述为"RuntimeEvent 派生投影 + 用户编辑 overlay 的复合 authority"。派生层（Source）可从 RuntimeEvent 重建，overlay 层（Settings/manual-fact/state 变更/裁决）需从备份恢复。

#### 改进 3：rewind 从"破坏性回滚"向"non-destructive fork"演进 ✅ 已落地

已把 rewind 改为 non-destructive fork——旧 Session 完全不变，创建新 Session 继承切片后的状态。从根源消除跨账本悬空引用：旧 Session 的 Memory Source 和 TaskRun checkpoint ref 永久有效。旧 rewind 方法和 branchId 解码逻辑保留（向后兼容存量 `history.rewound` 事件），但新代码不再写入。

#### 改进 4：统一投影重算入口 🔄 待落地

Maka 有 `RuntimeReadModel.getSessionView()` 作为统一的投影入口，每次 read 即时从 RuntimeEvent ledger 重算。Pico 的投影分散在 `SessionMessageLedger`（一次性内存投影）、`Session`（运行态投影）、各 UI 投影中，没有统一的"从 RuntimeEvent 重算"入口。

**Pico 的改进方向**：引入一个 `RuntimeProjectionService`，封装"从 RuntimeEventStore 重建指定状态"的逻辑，作为所有投影的 canonical 恢复路径。当投影损坏时，从 RuntimeEvent 重建而非报错。

### 4.3 可以做的：渐进改进

#### 改进 5：删除死代码 ✅ 已落地

`src/context/plan-store.ts`（144 行）已删除。`new PlanStore` 在生产代码中零调用，已被事件溯源版 PlanCoordinator 完全替代。

#### 改进 6：抽象 withStoreLock 模板 🔄 待落地

四个账本的 `withStoreLock` 骨架（root identity 断言 + boundary 断言 + recover + 包装错误）逐行克隆约 120 行。可抽象为泛型基类，但保留各自的 integrity error 类型。

#### 改进 7：补全 ARCHITECTURE.md 的 Memory 隔离域声明 ✅ 已落地

已在 `ARCHITECTURE.md` 补充 Memory 使用独立 `memory/` 目录和 lock、跨域操作采用两阶段提交模拟 + fail-closed 失效的声明。

---

## 五、总结：两种架构的本质取舍

| 维度 | Pico 四账本 | Maka log-first |
|------|------------|----------------|
| **一致性简单度** | 低（需要显式协调） | **高**（投影自动一致） |
| **schema 演进** | **独立**（各管各的） | 耦合（全局影响） |
| **故障隔离** | **强**（一个坏不拖累） | 弱（log 坏全部投影失效） |
| **理解成本** | 高（~14K 行，4 个账本） | 中（一个 log + N 个投影） |
| **rewind 安全性** | 有风险（需显式协调） | **天然安全**（non-destructive fork） |
| **适合阶段** | 成熟系统（需独立演进） | 快速迭代（需一致性优先） |

**Pico 的架构不是"有问题"，而是"用一致性简单度换 schema 独立演进和故障隔离"。** 最值得借鉴 Maka 的不是合并账本，而是：

1. **rewind 改为 non-destructive fork**——从根本上消除跨账本悬空
2. **确立 RuntimeEventStore 的 canonical 真源地位**——让其他账本成为"有独立存储的投影"而非"并列真源"
3. **补齐 TaskRunStore 对 rewind 的感知**——最紧迫的具体缺陷

这三点能让 Pico 保留四账本的物理隔离优势（schema 独立、故障隔离、性能隔离），同时获得 Maka 式的跨账本一致性保证。

---

## 附录：关键代码对照

| 概念 | Pico 位置 | Maka 位置 |
|------|----------|----------|
| 状态真源声明 | `ARCHITECTURE.md:96-118` | `runtime-core:49, 308-333` |
| canonical log | `src/storage/runtime-event-store.ts` | `packages/core/src/runtime-event-store.ts` |
| rewind 实现 | `desktop-runtime-service.ts:3191-3244` | `session-manager.ts:5032` (`reviseBeforeTurn`) |
| 跨账本协调 | `desktop-memory-service.ts:335-650` (lifecycle Job) | 不存在（不需要） |
| Memory provenance | `src/memory/domain.ts:65-81` (Source) | `long-term-memory.ts:87-92` (MemoryItemSource) |
| 投影入口 | `src/engine/session-message-ledger.ts`（分散） | `runtime-read-model.ts:77` (`getSessionView`，统一） |
| 压缩语义 | `src/context/full-compactor.ts`（摘要替换前缀） | `history-compact-checkpoint.ts`（checkpoint 是投影） |
| schema 版本 | 各账本独立 schemaVersion | RuntimeEvent 无版本（closed-domain 校验） |
| 故障恢复 | `src/storage/storage-doctor.ts`（按账本独立 repair） | 从 RuntimeEvent 重建投影 |
