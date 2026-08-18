# 决策记录 25：appendBatch 写路径瘦身——事件索引边车（2026-08-18）

> 分支：`feat/session-catalog`（阶段 2）。实现见 `src/storage/session-event-index.ts`、
> `runtime-event-store.ts` 的 `requireSessionAppendContext` 与 `tests/integration/session-event-index.test.ts`。

## 背景与实证

`appendBatch` 每批对每个被追加会话**全量加载 ledger**（`readFileSync` 整文件 + 逐行
JSON.parse + 完整性校验）：1211 事件的会话每批追加付 ~94ms，且随会话长度线性涨
（5 万事件 ≈ 1s）——④ 号债在写路径的镜像。全量加载只服务四件事：sequence 分配
（=manifest 水位 lastSequence）、CAS 高水位（同前）、eventId 去重（需要全部历史
eventId+载荷等价性）、planOperation 查重（需要操作身份索引）。后两件没有持久化索引。

## 决策

1. **事件索引边车** `sessions/<digest>/events.index.jsonl`：每个追加事务一行，
   记录本批事件的 `{sequence, eventId, eventAt, payload 哈希}`（plan/graph 事件
   附带 `{operationId, fingerprint}`）。与 ledger 批行**同一事务的 appends 目标**。
   可丢弃投影：缺失/损坏/与 ledger 水位失配 → 从 ledger 全量重建。
2. **`requireSessionAppendContext`** 替代全量加载：manifest 快路径水位（头行+尾行+
   投影一致性校验，复用 `loadManifestProjectionFast` 同款检查集）+ 索引。
   sequence/CAS/去重/planOp 全部从水位与索引取；**payload 等价性由哈希承载**
   （canonicalizeRuntimeEvent 输出序列化确定，写入与校验两侧自洽）——同 id 异载荷
   仍然 fail-closed，语义不变。
3. **catalog 行转增量折叠**（决策 24 的预留路径）：行内持久化折叠状态
   （`SessionSummaryFold`，schemaVersion 2），追加只折叠新事件；全量口径与增量口径
   共用同一折叠器（`engine/session-summary.ts`），等价性由构造保证。行水位与
   ledger 水位不符时全量重建该行（防漂移阀门）。
4. **W5 语义位移（有意为之）**：追加不再顺带全量校验 ledger 中段完整性——中段
   损坏从"写时 fail-closed"移到"读时兜底"（读路径仍全量校验）。快路径仍校验
   头行+尾行+manifest 一致性。

## 弃案

- **尾窗去重（只查最近 N 条）**：弱化深历史重放的幂等语义，弃。
- **eventId 全集存 manifest**：manifest 每次追加整体重写，O(n) 写放大，弃。
- **折叠器不落行、每次全量重算**：写路径不再有全量 entries，无来源，不可行。
- **保持全量加载 + 加缓存**：跨进程失效复杂度与锁仪式不减，且不解决增长曲线。

## 代价与已知局限

- **索引整读**：每批追加读全量索引（1200 事件 ≈ 170KB ≈ ~15ms；5 万事件
  ≈ 7MB ≈ 数十 ms）——比 ledger 全量低一个数量级以上，但仍是线性项；更大规模
  复评分片/内存驻留。
- **fsync 仪式成为追加的剩余大头**（锁获取/释放 + 事务 WAL 提交，~100ms 级
  常数）：写路径合法持锁，本决策不动锁协议；后续期评估。
- 实测（1200 事件合成会话）：单事件追加的会话加载组件 94ms→~15ms；深历史
  重放 40ms（去重路径无事务）。

## 复评条件

- 单会话事件数到数万：索引读放大复评。
- 追加吞吐成为交互瓶颈：fsync 仪式（组提交/批合并）复评。
