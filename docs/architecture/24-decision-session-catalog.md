# 决策记录 24：工作区会话目录（session catalog）（2026-08-18）

> 分支：`feat/session-catalog`。本文记录决策动机与边界，实现见
> `src/storage/session-catalog.ts`、`src/storage/runtime-event-store.ts` 的
> catalog 维护点、`src/engine/session-summary.ts` 与
> `tests/integration/session-catalog.test.ts`。

## 背景与实证

**读路径的放大已消除，但常数仍在。** `abf0ed3d`（A+B）把会话读取从"全工作区
扫描 × N 次锁仪式"收敛为"单会话直读 + 单锁批读"后，真实工作区（14 会话 /
1.8MB）实测：列表 ~170ms、单会话直读 ~213ms。CPU profile 显示剩余成本的主体
不是数据读取（`readFileUtf8` 仅 4.1%），而是**每文件叠加的元数据调用**
（`lstat` 17.3% + `existsSync` 12.6% + libuv 线程池调度 ~10.7%）——列表路径
仍要打开每个会话的 ledger 现算摘要，边际 ~5-8ms/会话（慢盘云桌 15-30ms），
会话数增长后"很慢"会回归。

**摘要没有任何持久化形态。** title/messageCount/firstMessage/lastMessage/
updatedAt 每次读取都从事件流全量重算——用三态框架说：叙事态（JSONL ledger）
健全，机械态完全缺位。对照系（maka 的 `session_catalog_projection` 表 +
recency 索引 + 追加时同事务增量维护）验证了"预计算目录"是该问题的标准形状。

## 决策

1. **形态**：工作区级单文件 `control/session-catalog.json`，每会话一行
   （完整 `CliSessionSummary` + `headSequence` + 水位 `ledgerByteLength` +
   纯事件发布 flags）。放 `control/` 是因为文件事务的目标前缀白名单
   （`workspace-storage-layout.ts`）只允许 `sessions/task-runs/control`，
   且 `control/state.json` 已有同事务写入先例。
2. **写侧与 ledger 同事务**：`initializeSession`/`appendBatch` 把 catalog
   整体重写作为额外 replacement 放进**同一个** `commitFileTransactionSync`；
   行内容由**现有 `summaryFromRuntimeSession` 原函数**对内存全量 entries 现算
   （`appendBatch` 本就全量加载被追加会话），全量/增量口径由"同一个函数"保证。
   `deleteSession` 在锁内目录删除后独立原子写清理行。
3. **读侧默认信任 + 结构性重建**：列表 = 无锁读 catalog（原子 rename 保证
   旧/新完整性）+ 一次 `readdir` 过滤幽灵行（deleteSession 崩溃窗口）+
   fork journal 发布过滤；缺失/损坏/schemaVersion 不符 → 锁内从 ledger
   全量重建（可写 store 顺手落盘，readOnly 只重建内存态）。单会话点查
   （`findCliSessionSummary`，17 个 RPC 的存在门）额外做一次 `statSync`
   水位校验，不符回落单会话直读——该回落同时是水位漂移的自愈路径。
4. **发布判定不入 catalog**：`isPublishedRuntimeSession` 的 journal 部分
   （StorageOperationJournal 的 fork 完成态）可在无新事件时变化，只能读时
   补查（实测 ~4ms）；纯事件部分（hasForkFacts/completedBootstrap）作为
   flags 落进行。
5. **summary 口径挪到 engine 层**：`CliSessionSummary`/
   `summaryFromRuntimeSession`/发布 flags 移入 `src/engine/session-summary.ts`，
   cli 与 storage 共用同一实现，消除 storage→cli 的循环依赖。

## 弃案

- **workspace 顶层放 catalog.json**：事务目标前缀白名单拒绝；扩前缀会让
  旧版本恢复含新目标的 pending marker 时 fail-closed，版本兼容代价不值。
- **折叠器式增量维护（本阶段）**：`appendBatch` 已全量加载被追加会话，
  现算即增量，折叠状态持久化没有收益；写路径瘦身后（后续期）再转增量折叠。
- **发布标志整体入 catalog**：需跨 store（StorageOperationJournal）锁协调，
  且状态可无事件���移，读时补查更便宜也更正确。
- **SQLite**：同等读成本模型的收益不抵放弃 JSONL 直读性与既有单 canonical
  结论（见决策记录 12/17 系列与 maka 对照分析）。

## 代价与已知局限

- **写放大**：每��真实追加事务全量重写 catalog（数百会话为几 KB，可忽略；
  数千会话时复评分片或 JSONL 追加式）。
- **append 路径的行现算是 O(会话长度) CPU**：与 `appendBatch` 既有的全���
  加载同阶，不新增量级；写路径瘦身（后续期）一并消除。
- **列表信任语义**：正常路径 catalog 不可能滞后于 ledger（同事务），残余
  漂移仅来自手工篡改或删除崩溃窗口，由 readdir 过滤 + 点查水位兜底。
- **暖态实测**：列表 170ms→~45ms、点查 213ms→~50ms（14 会话）；剩余主体
  是 store 构造（布局准备/realpath）与 journal 查询的进程级常数，
  与会话数解耦的目标准时达成（catalog 读取本身 ~10ms）。

## 复评条件

- 会话数达到数千：重写写放大与文件体积复评。
- 写路径瘦身落地：catalog 行维护转增量折叠（前置依赖，见阶段 2 计划）。
- `-c` 解析改 RPC 后 CLI 不再本地读存储：列表路径的跨进程无锁读约���可放宽。
