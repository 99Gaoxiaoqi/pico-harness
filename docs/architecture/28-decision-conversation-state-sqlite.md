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
- **迁移失败分类（2026-08-20 对抗审查 Finding 6 修订）**：解析损坏/导入约束冲突属
  永久失败——error 日志 + 原文件改名 `.failed` 隔离（数据保留）后放行，store 空态
  起步，消除"每次重启首个会话操作必抛"的 poison-pill；瞬态失败（IO/锁）保留原 JSON
  维持重试。多分片场景下永久失败隔离时已提交分片保留导入。
- **分片键与行键归一化口径不对称（对抗审查 Finding 7，记录为陷阱）**：库路由用
  realpath+normalize+win32 小写，行键用 resolve+NFC 保留大小写——大小写变体进同一库
  但成不同行。单 daemon + workspace registration 统一拼写下不触发；多入口写入成为
  现实时须先收敛（store 落列前过 canonicalizeWorkspacePath 或行键同口径小写）。
- **队列同刻 tie-break 与 JSON 版漂移（Finding 8，接受）**：同毫秒入队顺序在
  localeCompare（ICU）与 SQLite BINARY 排序间可能不同；排队语义对同刻 tie 无依赖。

## 复评条件

- desktop 多客户端并发成为现实 → 复评表粒度与争用，并一并处理分片/行键口径收敛。
