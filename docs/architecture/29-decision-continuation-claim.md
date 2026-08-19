# 决策记录 29：continuation claim 最小协议——中断 run 的确定性续跑锚（2026-08-19）

> 分支：`scratch/maka-gap-analysis`（调研依据：`.scratch/pico-vs-maka-flow-gaps.md` §2 P3；
> 对照系 maka：`runtime_continuation_claims` + prefix_digest/high_water + source seal，
> 设计文档 runtime-resume-phase3-phase4-workspace-checkpoint-design）。

## 背景与实证

pico run 中断只补 `run.terminal(interrupted)`（reconcileIncompleteRuns），上层重发即重来：
无"从安全边界续跑"的存储协议，无防双续跑约束，无前缀完整性校验。长 goal/cron 任务中断
语义粒度粗。maka 有完整 claim 协议（claim 事务内重读 boundary + digest + high_water，
claim 成功 seal source）。

## 决策

1. **sessions scope 新表 `runtime_continuation_claims`**：
   - `claim_id` PK；`source_session_id`、`source_run_id`（**UNIQUE：一个 source run 至多
     被 claim 一次**）、`source_high_water`（源前缀末事件 seq）、`source_prefix_digest`
     （对 seq∈[1..high_water] 的 `{seq, eventId, canonical payload}` 序列化后的 sha256）、
     `target_session_id`、`target_run_id`（UNIQUE）、`created_at`。
2. **claim 过程 = 单个 BEGIN IMMEDIATE 事务**，store 层 API
   `claimContinuation(sourceSessionId, sourceRunId, targetRunId)`：
   - 校验 source run 存在且终态为 interrupted（活跃 run 拒绝被 claim）；
   - 读源 ledger 头水位，计算前缀 digest；
   - INSERT（UNIQUE 冲突 → 返回类型化冲突，不抛裸错）。
3. **目标 run 关联**：`run.started` 事件 data 增加
   `continuationOf?: { runId, highWater, prefixDigest }`（复用既有 kind，data 扩展）。
   模型上下文无需特判——同 session 事件流天然包含前缀；跨 session 续跑不在本决策。
4. **源的不可追改**：依赖"终态事件后拒收后续 append"。若现状无此防线（对照 maka
   `assertRunNotSealed`），本决策在 store 层补齐：对已有 run.terminal 的 run 拒绝非恢复
   类 append（fail-closed）。
5. **定位收窄**：本协议只做"确定性续跑锚"（防双续跑 + 前缀完整性 + 源封口）。调度接入
   （goal/cron 自动续跑）不在本决策内，届时复评 API 形状。

## 验收不变量

- C1 同一 source run 至多一个 claim（DB UNIQUE 约束，冲突返回类型化结果）。
- C2 claim 成功隐含：claim 时刻源为 interrupted 终态、digest 与账本一致。
- C3 claim 事务只读源账本，只写 claims 行；目标关联只经 run.started。
- C4 已 claim 的源 run 追加事件被拒（源封口，若 §4 防线为本决策新增则一并测试）。

集成测试：interrupted run → claim 成功（digest/high_water 正确）→ 二次 claim 冲突 →
源追加被拒 → 目标 run.started 携带 continuationOf。

## 弃案

- **digest 覆盖投影（复算消息投影）**：投影逻辑随版本演进，只 digest 原始事件
  （与 maka 同一理由）。
- **continuation 物化全部祖先事件**：链长增长 O(n²) 存储 + 身份重复。弃。
- **活跃 run 可被 claim（软中断续跑）**：与"终态事实先于终态状态"冲突，仅终态可续。弃。

## 代价与已知局限

- claim 一次全前缀读 + digest 计算 O(n)：数万事件约数十 ms，接受；更大规模复评增量 digest。
- sessions scope migration +1；run.started data 扩展（旧读者忽略未知字段，兼容）。

## 复评条件

- goal/cron 自动续跑接入 → 复评 API 与调度边界。
- 前缀 digest 成为启动瓶颈 → 复评缓存/增量 digest。
