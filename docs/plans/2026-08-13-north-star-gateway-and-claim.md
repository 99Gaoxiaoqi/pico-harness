# 北极星实施：统一网关层 + Claim 推广

> 状态：**待实施**（方案已定稿，由新 session 执行）
> 建立日期：2026-08-13
> 关联：`docs/architecture/20-architecture-audit-and-governance.md` §4-5（诊断与设计）、`09` D7/D9/D10 债
> 活体追踪器：`tests/integration/architecture-invariants.test.ts` 的 D7（records）、D9（三套状态机）、D10 相关
> 约束：提交信息遵循 Conventional Commits（中文），不提其它项目名；每个阶段独立提交、独立验收；改动前先跑相关集成测试固定基线

## 0. 一句话

pico 的 4 条设计原则在叙事态执行扎实，但调度态（2/5）和机械态（2.5/5）退化为"内存权威 + 补丁驱动"。北极星 = 两个结构性修复：**阶段 2 把 graph 调度的去重权威从内存 records 下沉到 durable lease（治根因 A）**；**阶段 3 引入统一网关层让所有外壳经由同一连接契约（治根因 B 的多外壳不一致）**。

## 1. 目标与不变量（完成后必须成立）

1. **内存层非权威**：`DelegationManager.records` 从"事实权威"降为"非权威缓存"——崩溃后从 durable lease 重建判定，records 可安全 delete（活跃表与历史表分离）。
2. **去重靠 durable 不靠内存扫描**：同一 graphWorkId 的双重派发由 durable claim/lease 幂等拦截，不是 `[...records.values()].find(...)`。
3. **多外壳单一接入**：Desktop/TUI/Mobile 经由同一 `RuntimeHostConnection` 契约接入，连接状态机、重连、transcript 分页/连续性在网关层统一收口（每外壳不再自维护状态机）。
4. **D7/D9 活体追踪器转正向断言**（修复后测试由"债务表征存在"反转为"债务已消除"）。

## 2. 阶段 2：Claim 推广（调度态 P0，D7）

### 2.1 目标

消灭 `DelegationManager.records` 的"内存事实权威"悖论（孤儿检测依赖重启清空返回空集的负信号）。把 graph work 的"执行主权"（dispatched → settle 之间的活主权）持久化。

### 2.2 设计：`graph-work:${workId}` durable lease 协议

```
dispatch(workId):
  acquireLease("graph-work:"+workId, ownerId=delegationId, ttlMs)   ← durable 主权
  CAS 冲突（lease 已被他人持有）→ 拒绝派发（幂等，不双重 spawn）

delegation 运行期:
  heartbeatLease(..., leaseEpoch)   ← 周期性续租（TTL 策略见 2.5）

settle（recorded/failed 写入）:
  releaseLease(..., leaseEpoch)     ← 释放主权

orphan 恢复（进程重启后）:
  查 lease：活（TTL 未过）→ delegation 真在跑；死/不存在 → 孤儿 → 标 failed+recovered
```

- **复用同仓正解**（先读，不发明）：
  - `src/tasks/runtime-store.ts`：`acquireLease(resourceKey, ownerId, ttlMs)`（:368）、`heartbeatLease`（:407）、`releaseLease`（:435）——文件锁 + owner/epoch/expiresAt 校验，跨进程安全。
  - 参考消费方：`src/tasks/cron-runtime-scheduler.ts:123`（claim + heartbeat + finish 带 expectedVersion CAS）。
- **不动 graph 事件 schema**：`graph.work.*` 事件无 owner/lease 字段（扩展 schema 会牵动 reducer/decode），lease 外挂在 RuntimeStore 控制面（`control/state.json`）。
- **finish 保持 ownerless 幂等**：`settleGraphWork` 的 recorded CAS 幂等短路（`session-runtime.ts:818`）**不动**——settle 发生在异步回调/重启后，无法 gate owner；lease 只补 execute 窗口的主权。

### 2.3 实施步骤（每步独立提交 + 验证）

| 步 | 改动 | 验证 |
|---|---|---|
| 1 | 读 `runtime-store.ts` 的 acquireLease/heartbeatLease/releaseLease 签名与 `cron-runtime-scheduler.ts:123` 用法，确认接口契约 | — |
| 2 | `DelegationManager.dispatch` 去重改读 lease：`acquireLease("graph-work:"+graphWorkId, delegationId, ttl)`，冲突（`RuntimeConflictError`）→ 返回 rejected（不再 `[...records.values()].find`） | `delegation-graph-dedup.test.ts` 全绿（现有 running 窗口 + settle 链窗口测试） |
| 3 | delegation settle 链完成时 `releaseLease`（onGraphWorkSettled 之后） | 同上 |
| 4 | orphan 恢复改按 lease 活性：`src/graph/graph-recover.ts` 从"`liveDelegationIds` 空集负信号"改为"lease 活/死判定" | 崩溃恢复集成测试（kill 进程 → 重启 → orphan 标 failed） |
| 5 | `settleFinalized` 标志移除（durable lease 覆盖了它防的 I/O 窗口）；`records` 可安全 delete（settleFinalized 后移除记录，活跃表/历史表分离——历史查询 `delegate_status` 改走 TaskRegistry 或记录归档） | 门禁 + typecheck + graph 集成测试 |
| 6 | **活体追踪器反转**：`architecture-invariants.test.ts` D7 测试由"债务表征存在"反转为"records 有 lease 回源路径"的正向断言 | 测试绿 |
| 7 | e2e：`graph-mode-multiround.real-llm.test.ts`（需真模型 + `RUN_LLM_E2E=1`）验证多轮图调度无回归 | e2e 绿 |

### 2.4 难点与决策点（执行时拍板，记录在 commit body）

1. **TTL 策略**：cron 用 30s TTL + 10s heartbeat；graph subagent 跑数分钟——TTL 设多长？建议 `GRAPH_WORK_LEASE_TTL_MS`（如 10 分钟）且 delegation 运行期每 ~TTL/3 心跳一次；或复用 cron 的 lease 机制参数化。
2. **多进程语义**：daemon 单例（单进程）下 lease 主要防"进程崩溃后重启误判"——崩溃后 heartbeat 停止 → TTL 过期 → 恢复时判定孤儿 ✓（这是 lease 相对内存 records 的核心收益）。
3. **`delegate_status` 历史查询**：records delete 后历史查询数据源（TaskRegistry 已 `complete/kill/fail` 记录终态——评估是否足够；不够则加轻量归档）。
4. **`liveDelegationIds` 的去向**：orphan 恢复不再需要它（改 lease 判定），但其它消费方（若有）需核对。

### 2.5 验收标准

- dispatch 去重不扫 records（grep 确认 `find` 消失或改索引）
- 进程崩溃重启后，orphan 判定准确（真在跑的 delegation 不误杀、真孤儿不遗漏）
- `settleFinalized` 全仓零引用
- D7 活体追踪器转正向断言且绿
- typecheck 0、门禁 0 违规、delegation-graph-dedup + 崩溃恢复测试全绿

## 3. 阶段 3：统一网关层（机械态 P0，D9）

### 3.1 目标

消灭多外壳不一致（Desktop fail-stuck 无恢复路径 / Mobile 10 次封顶 / daemon-client 无限重连三套状态机不互通；transcript 同步双实现）。所有外壳经同一连接契约接入，状态/重连/transcript/连续性在网关层统一。

### 3.2 设计：`RuntimeHostConnection` 契约 + 双传输

```
外壳（Desktop/TUI/Mobile）── 统一契约 ──► 网关层（由 mobile-gateway 升级）──► LocalDaemonHost（保留为 kernel 等价物）
         │                          │
         │  ClientSurface 枚举      │ 连接状态机/重连/transcript 分页/连续性/超时 全部收口
         └── 双传输：本地 socket（Desktop/TUI）+ 安全 WS（Mobile）
```

**契约抽象**（借鉴 maka 的 runtime-host，仅契约与分层，不照搬传输）：
- `ClientSurface` 枚举（`"desktop" | "tui" | "mobile"`）+ `RuntimeHostConnection` 接口：握手、pending 请求队列、存活检测、订阅复用——**全仓唯一的连接状态机实现**
- `ClientSessionSubscription.loadTranscript`：统一 transcript 分页（吸收 Desktop `conversationLoadGenerationsRef` 与 Mobile `loadGenerationRef` 双实现）+ `snapshot_expired` 语义
- `SessionContinuityService`：重连后的会话连续性（投影状态 + 订阅者 + 序列号）
- 超时统一用 `src/util/race-with-deadline.ts` 原语

**与 LocalDaemonHost 的关系（叠加，非替换）**：网关 = `src/mobile-gateway/` 升级 + 统一契约层，叠加于 `LocalDaemonHost`（`src/daemon/runtime-host.ts`）之上；daemon 保留为 RuntimeHostKernel 等价物；Desktop 直连旧路径降级保留。

### 3.3 实施步骤（迁移顺序，每步独立提交）

| 步 | 改动 | 验证 |
|---|---|---|
| 1 | 定义契约：`ClientSurface` + `RuntimeHostConnection` 接口 + transcript 分页协议（新模块，如 `src/gateway/` 或升级 `src/mobile-gateway/`） | typecheck + 契约单测 |
| 2 | `mobile-gateway` 升级为通用网关：本地 socket + WS 双传输适配同一契约 | mobile gateway 既有测试 + 新 socket 传输测试 |
| 3 | Mobile 迁移：`session.tsx` 从自维护状态机改为经契约订阅（吸收重连/退避/认证逻辑进网关客户端） | mobile client 测试（4/4）+ 真机冒烟 |
| 4 | Desktop 迁移：renderer 从直连 daemon IPC + 自维护 `ConnectionState` 改为经网关客户端；**加自动恢复路径**（transport 恢复 → 自动 re-bootstrap，消除 fail-stuck 错误页） | desktop-runtime-close + 断连恢复测试 |
| 5 | TUI 迁移（最大，最后）：从进程内装配改为 socket 客户端 | 见 3.4 风险 |
| 6 | **活体追踪器反转**：D9（三套状态机）/D12（transcript 双实现）测试反转为"外壳只留展示层"的正向断言 | 测试绿 |

### 3.4 风险与降级（TUI 迁移，已在 20 文档 §5 评估）

- **部署模型变更**：TUI 是 CLI 主入口（`src/cli/main.ts` 进程内装配 `startTuiRepl`，零 daemon 依赖）。改 socket 客户端意味着 CLI 部署模型从"单进程"变"CLI + 宿主进程"：
  - 进程生命周期：常驻 vs 按需 spawn（`connectOrSpawn` 语义）、孤儿回收、repl 崩溃后恢复
  - headless/离线：`pico run`/CI 不能依赖交互宿主——**保留不经网关的进程内降级路径**（headless-one-shot 走直连）
  - **单独立项**，不做完前不合并步骤 5
- 网关层上线期间旧路径（Desktop 直连、TUI 进程内）**并行保留**，逐步迁移，每步可回滚。

### 3.5 验收标准

- 全仓连接状态机实现数 = 1（grep 确认 Desktop `ConnectionState` / Mobile `MobileRealtimeState` 不再自维护，只剩网关客户端）
- Desktop 断连后自动恢复（不再永久卡错误页）
- transcript 分页实现数 = 1（`conversationLoadGenerationsRef` / `loadGenerationRef` 消失）
- D9/D12 活体追踪器转正向断言且绿
- headless 模式不受影响（降级路径测试绿）

## 4. 执行顺序与依赖

1. **阶段 2 先做**（独立、收益明确、活体追踪器已就位）——建议作为第一个 PR。
2. 阶段 3 的步骤 1-4（契约 + mobile-gateway 升级 + Mobile/Desktop 迁移）可作第二个 PR。
3. TUI 迁移（步骤 5）单独立项（部署模型重设计）。
4. 每个阶段/步骤独立提交，commit message 中文 + Conventional Commits。

## 5. 相关追踪器（执行时同步维护）

- `architecture-invariants.test.ts`：D7（records）、D9（三套状态机）、D12（transcript 双实现）——修复后反转断言，**不要只删测试**（反转 = 债务消除的机械证明）。
- `check-architecture-boundaries.mjs`：`delegation-manager-scheduling-leak` 规则保持（阶段 2 后 delegation-manager 更不应 import graph/runtime 调度模块）。
