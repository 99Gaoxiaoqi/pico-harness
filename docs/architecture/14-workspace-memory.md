# Pico 原子长期记忆

> 文档状态：当前事实。依据 2026-09-08 的当前实现核对。生产链路已从
> Fact/Proposal/Worker 切换到原子 Item；本文替代旧“提案式事实记忆”说明。

## 1. 记忆分成什么

| 层次         | 职责                                             | 存储与读取                                                              |
| ------------ | ------------------------------------------------ | ----------------------------------------------------------------------- |
| 会话历史     | 保存用户消息、助手回答、工具结果、Run 和压缩边界 | workspace `pico.sqlite` 的 RuntimeEvent；模型历史与 Transcript 是其投影 |
| 上下文压缩   | 控制当前模型请求大小                             | 写入 checkpoint，改变后续读取视图，不改写原始对话事件                   |
| 原子长期记忆 | 跨会话保存稳定偏好、背景、知识等                 | 用户级 `$PICO_HOME/memory.sqlite`；按当前问题召回少量 Item              |

长期记忆不等于聊天全文或压缩摘要。自动提取的内容来自受约束的用户证据；手动保存、编辑、
归档和删除属于独立用户意图，不能靠重跑模型可靠恢复整个记忆库。

同一 `PICO_HOME` 共用一个原子记忆库。`global` 条目可以在该用户的受信工作区中使用；
`workspace` 条目只对匹配的工作区 key 可见。开关按工作区保存，不同 `PICO_HOME` 相互隔离。

## 2. 写入和召回流程

```mermaid
flowchart TD
  U[用户对话] --> R[memory_remember：同步等待]
  U --> E[memory_extract：仅登记本轮意图]
  E --> T[正常 completed 终态持久化]
  C[压缩 checkpoint 持久化] --> Q[Session 后台队列]
  T --> Q
  R --> X[用户证据投影与候选提取]
  Q --> X
  X --> N[独立模型规范化与再次校验]
  N --> DB[(用户级 memory.sqlite)]
  M[手动保存或编辑] --> S[本地校验，无模型调用]
  S --> DB
  DB --> K[当前问题的关键词和路径匹配]
  K --> P[最多 3 条 / 320 token 的低信任参考]
```

### 触发入口

| 入口                                                 | 实际行为                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 模型工具 `memory_remember({})`                       | 用户明确要求记住时使用；必须独占一个工具步骤，同步完成提取和提交后返回实际保存结果                    |
| 模型工具 `memory_extract({})`                        | 仅返回 accepted 并记录本 Run 的提取意图；正常 completed 事件落盘后才排入后台，accepted 不表示已经保存 |
| Compaction hook                                      | checkpoint 落盘后按被冻结的覆盖边界触发后台提取，不等待当前 Run 结束，也不要求先调用 `memory_extract` |
| `/memory remember <text>` / 管理接口 `memory.create` | 不调用模型；通过本地安全校验后直接建立当前工作区的 `note` 条目                                        |

两个模型工具都严格无参，不能让主模型直接提交任意正文。失败、取消或恢复生成的 terminal
不会触发 `memory_extract`；但此前同步 remember 或 checkpoint 提取已提交的内容不会随 Run
后来失败而回滚。

Runtime 分别控制召回和提取，均要求受信工作区；提取还检查
Session 存在且未归档。Plan 可以召回，不装配提取工具；旁路对话和后台 Automation
不因会话类型单独关闭记忆。后台记忆工具进入可授权列表，仍须满足各 Job 的 `allowedTools`，
不会自动扩大既有任务权限。Graph operator、普通子代理及隔离 headless 不注入或提取记忆。
Responses Provider 保留两个触发工具，但调用返回 `provider_unsupported`，不发起提取模型调用，
也不执行压缩提取；符合条件时仍可以召回已有记忆。召回读取原子记忆库，三个记忆开关按工作区生效。

### 提取与证据

1. Host 固定 workspace/session/run/turn 身份、事件序号和边界。记忆内部的 Session key 包含
   workspace key，避免不同工作区同名 Session 混用游标。
2. 从稳定用户文本构造证据；有 Provider 请求快照时，优先使用 RuntimeEvent 到请求消息的索引，
   避免重复传入正文。引文仍须同时存在于原始事件和请求可见文本中；无索引时才回退到文本匹配。
   工具结果、thinking、隐藏控制消息和附件不作为正式用户证据；助手文本只能辅助解释指代。
3. 辅助模型生成候选，程序验证 JSON、字段枚举、时间范围、来源与引文。引文必须能在对应
   用户证据中找到；需要定位历史指代时可进行一次受限的历史定位，最多覆盖 7 个历史轮次、
   每条 2000 字符、总计 12000 字符。
4. 另一次模型调用负责规范化，只接收候选 ID、用户引文、观察时间和可选指代上下文；不接收
   候选正文、keys、scope 或整段源会话。规范化结果再次校验，scope 由模型选择，workspace key
   由程序绑定，不能由模型指定别人的工作区。
5. 合法结果直接入库，没有人工 Proposal 审批队列。密钥或不合法候选会被拒绝或过滤；手动
   保存、编辑复用本地清洗器，只接受 `allow`，不会建立 PII 待审提案。

每个证据处理段最多 **3 次辅助模型调用**，包含提取、定位后的提取、规范化及重试；每次调用
有 60 秒期限。补齐多个 checkpoint、处理 pending 范围或把过大范围拆成两段时，一次触发可能
处理多个段，因此不能把 3 次当作整个用户请求的总上限。记忆调用独立计入 `memory_review`
用量，默认沿用当前 Provider 和模型配置，不保证使用更便宜的模型。每次辅助请求在发送前
检查源消息、实际发送的工具定义、提取提示词、输出预留和安全余量；已知模型窗口时，过大
范围仅尝试在完整轮次边界拆成两段，两段均通过预算检查后才执行，不递归拆分。模型返回
窗口溢出时不原样重复请求。未知模型容量仍以 Provider 结果为准。旧 eco/balanced/quality
的 24 小时 review 预算不是当前生产策略。

引文匹配能证明来源存在，不能单独证明模型对含义的解释正确；规则过滤也不等于覆盖所有敏感
信息。记忆按低信任参考使用，不能把通过校验等同于事实绝对正确。

## 3. Item 和持久化

正式模型是 `MemoryItem`，关联 `keys` 和 `sources`：

- `kind`：`preference / identity / context / knowledge / failure / note`。
- `statementType`：`fact / plan / prediction`；`temporalType` 描述无日期、时间点或区间。
- `scopeType`：`global / workspace`；`origin`：`agent_extracted / user_requested`。
- `lifecycleState`：`active / archived`；内容上限为 2000 个 Unicode code point。
- 版本、内容 hash、观察时间、事件时间和来源身份与正文一起保存。

`failure` 是可保存的内容分类，不代表已经接入“失败 Run 自动蒸馏/失败日记”。

独立 SQLite 库通过事务同时提交 Item、keys、sources、提取游标、operation 和 extraction
receipt。修改用 expected version，提取覆盖推进用 cursor CAS；operation ID 与请求 hash
保证同一操作重放幂等。内容 hash 不是唯一键：不同操作可以保存相同内容，当前没有语义去重、
冲突裁决或自动覆盖旧记忆。手动重复创建相同正文有单独的幂等处理，不能推广成通用去重能力。

### 后台与恢复边界

- 同一 Session 使用进程内串行队列；前台 remember 优先于尚未开始的后台请求，不抢占正在
  执行的后台工作。SQLite CAS 负责跨连接的提交一致性。
- daemon 本身常驻；记忆任务另外持有宿主引用，覆盖快照准备、排队、模型调用和资源释放。
- 正常退出先停止 remember/extract 准入，再等待已登记任务及模型资源释放，最后关闭存储与
  宿主。退出期间的压缩回调仍可写入“记忆已关闭”的策略拒绝记录；仅因退出中断的范围
  不推进 cursor、不记为提取失败，留给下次触发。
- 后台队列本身不持久化，崩溃或强制终止不能保证收尾。后续触发根据持久化的 cursor、
  pending failure 和 checkpoint 补齐未覆盖范围，而非启动时扫描所有 completed Run。
- 处理失败先记录 pending，下一次不同操作触发时重试原覆盖范围；再次失败可记录 discard
  并推进范围。存储不可用、策略变化等情况不能伪报保存成功。
- 自动压缩在写入 checkpoint 的同一事件中保存记忆准入结果：`eligible` 可在后续触发时恢复，
  `policy_denied` 表示当时策略不允许，不会在重新开启后静默补采；不依赖写入后的回调成功。
- 补齐历史范围时按该范围的实际触发类型重新检查开关；显式 remember 不会放行被关闭的
  自动提取范围。没有记忆标记的手动压缩、旧 checkpoint 和 fork 引导摘要不独立触发提取。

## 4. 召回

每轮组装动态 turn tail 时，用当前用户问题生成路径、词项和 CJK 双字查询。SQLite 对 keys
进行 exact/prefix 匹配，只查询 global 和当前 workspace 的 active Item；不使用 embedding、
向量库或模型检索。中文复合关键词另在最近 500 条候选内补充匹配：至少命中两个不同的非停用
双字词，例如“验收报告”可以命中“项目验收报告”；仍按工作区和归档状态过滤。

路径匹配权重高于普通词项，CJK 双字得分封顶，同分时优先最近更新的条目。还有一个有限补位
规则：从最近的候选窗口中补充最多一条未匹配的通用 `preference`。不会把所有未匹配知识都
当作常驻上下文，也没有旧版 pinned/correction 强制优先机制。

最终最多注入 **3 条、320 token**，正文与 XML 安全包装一并计入预算；单条放不下就跳过。
内容进行 XML escaping，并放在 `<atomic-memory-reference trust="low">` 中，明确它只是参考，
不能授予权限或改写当前用户、安全策略、AGENTS.md、Provider、凭据和工具授权。

召回开关关闭、不受信或查询失败时不注入；失败会降级记录，不阻断普通对话。

## 5. 用户控制与删除

“添加记忆”表单直接调用 `memory.create` 保存当前工作区笔记，不调用模型。保存失败时保留输入；
相同正文复用已有条目，已归档的相同正文会恢复。保存后仍按相关性和召回开关选取，不保证每轮注入。

桌面记忆页提供手动添加、已保存/已归档列表、正文编辑、范围和来源展示、归档/恢复、删除，以及三个
按工作区生效的开关：

| 存储字段        | 含义                                                     | 兼容协议字段       |
| --------------- | -------------------------------------------------------- | ------------------ |
| `enabled`       | 总开关                                                   | `enabled`          |
| `autoExtract`   | 控制后台 extract 和 compaction 提取，不阻止显式 remember | `autoPropose`      |
| `recallEnabled` | 是否注入已有记忆                                         | `injectionEnabled` |

开关默认均开启。`/memory off` 同时关闭总开关和召回；`on` 将两者打开，但保留原自动提取
设置。常用命令：

```text
/memory remember <text>   手动保存工作区记忆，不经模型
/memory status            查看工作区记忆状态
/memory off | on          关闭或启用记忆与召回
/memory undo <token>      版本仍匹配时归档刚保存的条目
```

归档停止召回但保留正文，可恢复；undo 也是归档。删除记忆会清除当前 Item、keys、sources
及有关回执中的正文，删除操作统一记录到 `memory_write_operations`，不保存旧来源黑名单。
原始聊天仍会保留；用户之后重新提供信息或明确要求记住旧聊天中的信息，可以重新保存。
这不删除原始会话、旧数据库或外部备份，也不是磁盘介质擦除。

为防止删除前已在途的提取把内容写回来，Snapshot 在捕获/请求入队前保存删除代次，
提交及失败结算在 SQLite 事务中复核该代次。代次来自操作表中已提交的 `delete` 记录数，
重复删除请求不会增加代次，不依赖时间戳。当前采用整个记忆库的代次：一次删除会使该库
所有旧代次任务失效，新任务正常运行。待重试失败范围也记录代次；旧代次范围以
`skipped / memory_deleted` 空结算并推进游标，不重新执行删除前的显式保存请求。

Session 删除不删除已提交 Item；删除后不再为该 Session 新提取。当前管理协议只投影第一条
来源，未实时验证原事件是否仍可打开，不能把显示的来源等同于永久可用的证据链接。

global 条目在同一用户的受信工作区可管理，其他 workspace 的局部条目即使按 ID 访问也会被
拒绝。当前 UI 不提供任意修改 scope 的入口。

协议仍保留 `fact`、`proposal`、`autoPropose` 等过渡名称；真正的类型和范围在 `fact.atomic`
中。旧审核列表返回空，审核操作及 reviewMode/autoCommit 更新明确拒绝。TUI daemon 客户端
的 `/memory status` 仍显示旧 Review/Pending 字段，undo 提示仍写 disabled；实际后端已经是
直接保存/归档语义。这是尚待对齐的界面措辞，不是旧审核机制仍在运行。

## 6. 数据库结构与备份

原子记忆库 Schema 为 v9，共 9 张业务表。工作区开关继续保存在 `memory_settings`。
其余八张表保存条目、关键词、当前来源、写入操作、提取游标、回执、失败范围和压缩策略拒绝记录。
运行时不再检查或导入旧 Fact/Proposal 数据，也不从旧库读取记忆设置或回退召回。

新库直接在一个事务中创建当前 9 张表和索引，不执行历史版本升级脚本。
已有当前版本库只校验结构并打开；其他版本或非空且未标记版本的库明确拒绝打开，
不自动升级或清空。版本号仅用于识别结构是否兼容。

备份需同时考虑 `$PICO_HOME/memory.sqlite` 和各 workspace `pico.sqlite`；前者保存
长期记忆，后者保存会话证据。运行中的库须用一致的 SQLite 备份方式，不能只复制主文件而
遗漏 WAL。旧备份可能包含后来已删除的记忆，恢复时需留意备份的时间范围。

## 7. 代码与验证入口

| 关注点                                   | 代码                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 生产装配、召回注入与 Profile 门禁        | [agent-runtime.ts](../../src/runtime/agent-runtime.ts)                                                                                                                                                                   |
| Snapshot、终态/checkpoint 接线、模型适配 | [atomic-memory-runtime.ts](../../src/runtime/atomic-memory-runtime.ts)                                                                                                                                                   |
| 提取、引文校验、规范化与恢复             | [extraction-engine.ts](../../src/memory/atomic/extraction-engine.ts)、[extraction-evidence.ts](../../src/memory/atomic/extraction-evidence.ts)、[extraction-proposal.ts](../../src/memory/atomic/extraction-proposal.ts) |
| Item 契约与 SQLite 存储                  | [contracts.ts](../../src/memory/atomic/contracts.ts)、[sqlite-memory-item-store.ts](../../src/storage/sqlite/sqlite-memory-item-store.ts)                                                                                |
| 关键词召回与预算                         | [context-builder.ts](../../src/memory/atomic/context-builder.ts)                                                                                                                                                         |
| 管理与开关                               | [desktop-atomic-memory-service.ts](../../src/daemon/desktop-atomic-memory-service.ts)                                                                                                                                    |
| 命令入口                                 | [client-commands.ts](../../src/tui/client-commands.ts)、[memory-command.ts](../../src/memory/memory-command.ts)                                                                                                          |

确定性覆盖见 `tests/integration/memory/atomic-memory-*.test.ts`、
`desktop-atomic-memory-service.test.ts` 和 `memory-runtime-quality.test.ts`；真实模型场景见
[atomic-memory-behavior.real-llm.test.ts](../../tests/e2e/atomic-memory-behavior.real-llm.test.ts)。历史验证数字
只保存在任务记录中，不作为当前模型准确率保证。

旧 Proposal/Worker/Scheduler/Recovery、旧记忆管理服务和 `SqliteMemoryRepository` 已退役。
原子记忆所需内容校验独立位于 `src/memory/atomic/content-safety.ts`；保留旧 wire 字段和
workspace schema 兼容校验，不意味着双写或双套记忆流程。
