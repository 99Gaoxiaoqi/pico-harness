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
   - INSERT（UNIQUE 冲突 → 返回类型化冲突，不抛裸错）；
   - **孤儿 claim 幂等改绑（2026-08-20 对抗审查 Finding 1 修订）**：同 target 重复
     claim → `already_claimed`（纯幂等）；异 target 且旧 target 在账本中无 `run.started`
     （claim 成功但 target 起跑前崩溃）→ 改绑到新 target，返回 `claimed` +
     `rebound:true`，锚点身���/digest/high_water/created_at 不变——否则该崩溃窗口会
     不可逆烧死 source 封口与 target 槽位。旧 target 已起跑则不可换绑。**调度接入
     契约：目标 run 须以 claim 的 targetRunId 起跑（RuntimeRun.start 传入 runId）。**
3. **目标 run 关联**：`run.started` 事件 data 增加
   `continuationOf?: { runId, highWater, prefixDigest }`（复用既有 kind，data 扩展）。
   模型上下文无需特判——同 session 事件流天然包含前缀；跨 session 续跑不在本决策。
4. **源的不可追改（claim-scoped，2026-08-19 实测修订）**：原设计"对一切已终态 run
   拒收后续 append"被全量回归否决——fork 工作流（`SessionForkService.publishForkWorkflowEntries`）
   与记忆仓储（`readCanonicalRecoveryRefs` 构造路径）存在合法的终态后写入路径，且 digest
   覆盖的是前缀 [1..high_water]，终态后追加不改变前缀、不影响 claim 完整性。修订为：
   **仅对已被 continuation claim 的 source run 拒收非恢复类 append**（claim 存在 ⇒ claim
   时已终态，fail-closed）；未被 claim 的终态 run 保持历史开放语义。
5. **定位与接入**：本协议做"确定性续跑锚"（防双续跑 + 前缀完整性 + 源封口）。
   **executor 级自动接入已落地（2026-08-20）**：`RuntimeRunExecutor` 在 reconcile/
   repair 之后、`RuntimeRun.start` 之前自动锚定最新未 claim 的 interrupted run
   （`findLatestInterruptedUnclaimedRun` + `claimContinuation`），本次 run 以 claim
   的 targetRunId 起跑并携带 continuationOf——前台 send、goal、cron 统一生效；
   调用方显式 `continuationOf` 与 `prestartedRun` 优先于自动锚定；claim 失败/无候选
   则普通起跑（info 日志）。goal/cron 上层若需差异化续跑策略（如选择性续跑、
   跨会话），届时在调用方显式声明路径上扩展。
   **终态新鲜度门（2026-08-20 对抗审查 F2 修订）**：自动锚定要求 interrupted 终态
   距今超过 `continuationTerminalMinAgeMs`（缺省 10 分钟，测试可传 0）。动机：run
   活性检测是进程内的，跨进程并发执行同一会话时 reconcile 可能把存活 run 误判补
   interrupted 终态——立即 claim 会封死对方（连终态都写不进）。门内不 claim，
   未 claim 的终态 run 保持开放语义、存活方继续可写；代价是真实崩溃后的锚定延迟到
   窗口期后的下一次 run 起跑（锚定是簿记，延迟无害）。已知残留：超长存活 run
   （>窗口）仍可能被误封口——根治需 reconcile 的跨进程活性检测，另立决策。

## 验收不变量

- C1 同一 source run 至多一个 claim（DB UNIQUE 约束，冲突返回类型化结果）；
  孤儿改绑（§决策 2 修订）只改 target_run_id，锚点唯一性不破。
- C2 claim 成功隐含：claim 时刻源为 interrupted 终态、digest 与账本一致。
- C3 claim 事务只读源账本，只写 claims 行（含改绑 UPDATE）；目标关联只经 run.started。
- C4 已 claim 的源 run 追加非恢复类事件被拒（源封口，claim-scoped）；未 claim 的终态
  run 保持开放（fork/记忆通道兼容）；幂等重放不受影响。**批内语义**：同一 append 批内
  `run.terminal` 插入后，同 run 的后续新事件同样被拒（终态必须是该 run 批内最后一条
  新事实）——2026-08-20 对抗审查补记，现有批形天然满足。

集成测试：interrupted run → claim 成功（digest/high_water 正确）→ 二次 claim 冲突 →
源追加被拒 → 目标 run.started 携带 continuationOf。

## 弃案

- **digest 覆盖投影（复算消息投影）**：投影逻辑随版本演进，只 digest 原始事件
  （与 maka 同一理由）。**附注（对抗审查 Finding 9）**：`canonicalJson` 本身也是代码、
  可随版本演进——未来任何 digest 验证者必须对**库内已存 payload_json 字节**计算/比对，
  禁止对事件重新 canonical 化后再摘要，否则跨版本会误判旧库。
- **continuation 物化全部祖先事件**：链长增长 O(n²) 存储 + 身份重复。弃。
- **活跃 run 可被 claim（软中断续跑）**：与"终态事实先于终态状态"冲突，仅终态可续。弃。

## 代价与已知局限

- claim 一次全前缀读 + digest 计算 O(n)：数万事件约数十 ms，接受；更大规模复评增量 digest。
- sessions scope migration +1；run.started data 扩展（旧读者忽略未知字段，兼容）。

## 复评条件

- goal/cron 差异化续跑策略（选择性续跑、`prestartedRun` 与 `continuationOf` 的交互边界）
  → 复评。基础 executor 级自动锚定已落地（2026-08-20，§决策 5），前台/goal/cron 统一生效；
  可恢复任务走 `prestartedRun` 路径时显式跳过自动锚定（事实已定形），该交互如有新需求再议。
- 前缀 digest 成为启动瓶颈 → 复评缓存/增量 digest。
