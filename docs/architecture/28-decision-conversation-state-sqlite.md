# 决策记录 28：desktop conversation-state 收编 SQLite control scope（2026-08-19）

> 分支：`scratch/maka-gap-analysis`（调研依据：`.scratch/pico-vs-maka-flow-gaps.md` §2 P2；
> 对照系 maka：`core_message_receipts` + `core_root_source_message_proofs` + `admitRootTurn`）。

## 背景与实证

请求级幂等 key、首条消息 claim、steer/queue 消息队列存于
`$PICO_HOME/desktop/conversation-state.json`（src/daemon/desktop-conversation-state.ts，
writeJsonAtomic）：原子性靠 rename 不靠 WAL，daemon 崩溃窗口无事务保护——与决策 24
"事实全部进 SQLite"方向相悖。maka 对应状态全部库内事务（receipt/proof/admission）。

## 决策

1. **control scope 新增表**承载三类状态（列细节以现有数据形状为准，实现期定）：
   - `desktop_idempotency`：幂等 key 点查（热路径），主键 = key；
   - `desktop_input_queue`：排队/steer 消息（workspace + session + 顺序键）；
   - `desktop_first_send_claims`：首条消息 claim（workspace 维度唯一）。
2. **接口不变**：`DesktopConversationStateStore` 对外形状保持，调用方零改动；新增 SQLite
   实现 + 装配切换（production-host 侧）。
3. **一次性迁移**：首次打开若存在 legacy JSON → 单事务导入 → 原文件改名
   `conversation-state.json.migrated`（保留不删）。单向：存在 `.migrated` 标记则不再回读
   JSON。导入幂等（以标记防双导入）。
4. 并发经既有 lease 串行；不引入新锁。

## 验收不变量

- B1 断电/崩溃后状态与 WAL 一致（无半写 JSON 窗口）。
- B2 迁移恰好一次；legacy 数据不丢失、不重复。
- B3 幂等 send / 队列 / claim 行为与 JSON 版等价（既有测试口径平移）。

## 弃案

- **保留 JSON + 强化 fsync**：不解决事务性，且与迁移方向背道而驰。弃。
- **泛用 KV 表（第八 scope）**：为单一消费者开新 scope，面扩大无收益。弃。

## 代价与已知局限

- control scope migration +1；旧 JSON 成为一次性兼容读取面。
- 多客户端并发写竞争现阶段不存在（单 daemon），分表粒度从简。

## 复评条件

- desktop 多客户端并发成为现实 → 复评表粒度与争用。
