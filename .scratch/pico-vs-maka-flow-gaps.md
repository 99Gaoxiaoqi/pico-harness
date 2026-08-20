# pico vs maka：写入路径与故障流程差距（2026-08-19 调研落盘）

来源：三个只读子代理调研（maka 全链路 / pico 全链路 / maka 文档考古）+ Crossref 文献检索，全部基于 2026-08-19 的两仓代码实况（pico = 19cca177 SQLite 迁移后；maka = main 工作区）。
定位：scratch 调研记录，供后续实施会话直接引用；不是 ADR。若某项立项实施，须另写 ADR（模板见 §6）。

> **决策状态（2026-08-19）**：P0-P3 四项全部实施完成（用户指令扩围至 P2/P3）。
> 落地顺序：ADR 27/28/29（53a3961a）→ P1（2c7f4477）+ P2（69bb4bdc）并行 → P0（ec58298e）→ P3（914da1c6）→ seal 收窄修订（8c29c6c5）。
> 各项落地记录见 §2 对应小节。全量集成回归：166 文件扫跑 + 基座 19cca177 对照，27 预存/2 回归，回归已由 8c29c6c5 清零。
> e2e 真机（RUN_LLM_E2E=1，lez-claude）：runtime-consistency 4/5、graph-mode 0/3（hookFailed）、tui-matrix 0/6——三文件失败均在基座 19cca177 完整复现（缓存计因断言漂移/hook 环境失败），零新增回归。
>
> **对抗审查轮（2026-08-20，main 上直审 17a6cb83）**：无 blocker；2 major + 6 minor + 5 info，"必须先修"三项已全部落地——
> F2 写序守护（4df98341，真实引擎账本序测试+ADR 27 决策 4 兑现+子代理盲区补记）、F6 迁移 poison-pill（6780b568，永久失败隔离 .failed）、F1 孤儿 claim 改绑（5965bbd8，ADR 29 修订+调度契约）。
> info 级已记 ADR：digest 验证者必须摘要库内字节（ADR 29 弃案附注）、批内 terminal 拒收语义（C4 补记）、分片/行键口径不对称+tie-break（ADR 28 已知局限）。
> 未修遗留（minor，后续迭代）：P1 HighWater 豁免/lease 丢失不仲裁测试缺口、P0 已终态 run 重复检测效率债、P2 poison-pill 已修但裁剪竞态等未动。
> 验证：六文件 29/29 绿+守护 1/1；**typecheck 因整机内存耗尽（8GB 云桌 ~1GB 空闲，tsc Zone OOM）未能完成全量跑**——改动已逐文件人工类型复核（refs 可选链实错已修，b46b9a00），内存释放后需补跑 `node node_modules\typescript\lib\tsc.js -p tsconfig.json`。

---

## 0. 先行更正（推翻本项目此前记忆的三点，后续引用以本文为准）

1. **maka 是单库**：`runtime_events` 与 `session_messages` 同在 `runtime.sqlite`、同一条 `DatabaseSync` 连接（`packages/storage/src/execution-stores.ts` 全部 store 指向同一 `lease.canonicalPath`；`agent-graph-control-store.ts:13` 注释 "Session messages and graph state share runtime.sqlite as one authority"）。此前"跨库缝合"的说法应改为**同库跨表缝合**——maka 技术上完全可以同事务原子写，没做是代码路径遗产，不是物理约束。
2. **maka payload = 完整事实**：完整 args / result / text / thinking signature，写侧**无**类型级字节预算。裁剪只发生在上游（`runtime/src/tool-output.ts` head/tail 截断，默认 2000 行/50KB，进事件前已裁）和读侧（`storage/src/bounded-evidence.ts` EvidenceReadBudget）。此前"maka payload=投影增量+类型级预算"是误记。
3. **两家都是 log-first**：事实本体都是事件账本（maka 文档原话 "Runtime Event Log is the canonical source"；`State(t) = Project(RuntimeEvents[0..t])`）。`session_messages` 在 maka 是产品投影（可从事件重建，`transcriptLedgerVersion` 标记收敛），非 canonical。真正的分歧只在**投影的托管方式**：pico 同事务原子派生 vs maka 独立事务双写+缝合协议。

---

## 1. 写入链路速览（用户输入一句话 → 落库）

### maka（~15 事务/turn，同库跨表）

```
turn.message.submit → HostMessageCoordinator.submit
  ① core_message_receipts（幂等 receipt，TX）
  ② core_root_turn_admissions + source_message_proofs（准入，TX）
  ③ AgentRun.begin()：四个独立事务——
     core_agent_runs（TX）→ session_messages 用户消息（TX）
     → session_messages turn_state=running（TX）→ runtime_events 初始事件（TX，id=消息id）
  ④ 模型循环：完成态事件逐条 TX；流式 partial 攒批 runtime_partial_snapshots/segments
     （mutable，最终事件到达时级联删）；token_usage 写 session_messages
  ⑤ 工具：T1 commitToolPrepared 单 TX（call+dispatch 事件 + tool_journal_events(prepared)
     + tool_operations）→ 执行（输出 head/tail 截断）→ T2 commitToolOutcome 单 TX
     （response 事件 + journal + operations 更新）
  ⑥ 终态：终态事件落账本即 seal（assertRunNotSealed 拒后续 append）
     → ensureTerminalRuntimeEventDurable barrier → run header 更新（TX）
     → turn_state 终态消息（TX）
恢复：RuntimeLedgerRepair 双向对账（事件补消息 / 消息回填事件），歧义写读回 eventLandedInLedger 去歧义
```

### pico（~10 事务/turn，投影恒同事务）

```
session.send（idempotencyKey）→ DesktopRuntimeService.sendSession
  ① conversation-state.json（JSON 文件！幂等 + steer/queue 队列，writeJsonAtomic）
  ② sessions + catalog 初始行（TX）
  ③ 用户消息以事件入账：mini-run 三事件（run.started → message.committed → run.terminal）各一 TX
  ④ startForegroundRun：daemon_commands（TX）+ daemon_events/daemon_runs（TX，control scope）
  ⑤ 执行器开场：reconcileIncompleteRuns（补 interrupted 终态+悬空 tool call 合成 result）
     → RuntimeRun.start（run.started）→ ReAct 循环
  ⑥ 事件写入：逐事件 TX；唯一攒批点 commitMessages（assistant+tool result 同批保配对）；
     partial 直接进账本（无 mutable 中间表）
  ⑦ appendBatchLocked 单事务＝runtime_events INSERT + session_messages 物化
     + sessions 水位（last_event_seq/event_count/storage_bytes）+ catalog 增量折叠
     + 写前水位一致性断言（fail-closed）+ event_id 幂等（同 id 异 payload 抛错）
  ⑧ 工具：tool.started（TX）→ 执行（全文 inline，超 MAX_TOOL_RESULT_BYTES 拒绝为合成错误）
     → tool.result.recorded（先 registerToolResult，随下条 commitMessages 同批）
  ⑨ run.terminal（TX）；写失败 → markWriteUncertain → write_uncertain 封会话停写
```

**核心结构差异一句话**：maka＝两本账（消息+事件）独立事务+身份缝合+修复器；pico＝一本账+同事务派生投影（`appendBatchLocked`，src/storage/sqlite/sqlite-runtime-event-store.ts:1094）。

---

## 2. pico 缺失清单（全部集中在故障路径）+ 优先级

### P0 工具半执行的诚实恢复（indeterminate 状态机）【已完成 ec58298e】

> **落地记录（2026-08-19）**：轻量方案（无新表），悬空 tool call 按 tool.started 派发事实分类 indeterminate/not_dispatched，data.recovery 标记 + 如实模型文案；schema 最小扩展（storage/runtime-event.ts）。测试 tests/integration/tool-recovery-classification.test.ts（I1-I5，6 条）。偏差：I1 以账本零派发断言替代 spy registry；F1 仍合成 transcript 配对事件（UI 机制非执行声明）。

- **现状**：`RuntimeRun.reconcileIncompleteRuns`（src/runtime/runtime-run.ts:362）对悬空 tool call 直接**合成 tool.result**——把 unknown 定形为失败。副作用可能实际已发生（文件已写/请求已发），合成结果会从账本上抹掉这一点。graph 多轮实测"子代理失败被自报完成掩盖"是同类问题的变体。
- **maka 对应**：`tool_journal_events`（append-only 状态迁移日志）+ `tool_operations`（当前状态表，T1/T2 各更新一次）+ 恢复决策表：call+dispatch+response=completed；call+dispatch 无 response=**indeterminate（reconcile or park，绝不自动重跑）**；仅 call=definitely_not_dispatched；orphan/冲突=corruption fail-closed。决策表实现在 `packages/core/src/tool-ledger-scanner.ts`（ToolLedgerIssueCode）+ `recovery-resolver.ts`。
- **实施提示**：pico 已有 tool.started/tool.result.recorded 事件形状（等价 T1/T2 的信息含量），缺的是 journal/operations 两张表 + 恢复时的状态判定。最小改动可在 reconcileIncompleteRuns 里区分"有 started 无 result"→ 标记 indeterminate（如引入 run 级 pending 标记或事件 kind），而非无条件合成失败。需要新事件 kind 时记得同步 assertRuntimeEvent（surface 重构教训）。
- **契约文档模板**：maka `docs/architecture/runtime-resume-phase0-crash-contract.md`（P0–P11 failpoint 表：每个崩溃位置→最后完整提交前缀→恢复动作）。

### P1 写失败的读回仲裁【已完成 2c7f4477】

> **落地记录（2026-08-19）**：仲裁包装在 append 调用边界（等价"插在 markWriteUncertain 之前"，session 链路零改动）；三类确定性契约拒绝（Integrity/PlanOperationConflict/HighWater）不仲裁原样重抛。测试 tests/integration/write-recovery-arbitration.test.ts（A1-A3，4 条）。未接入面（保守维持）：fork 发布路径、恢复 claim append（自带高水位校验）。ADR 27。

- **现状**：任何 durable 写失败或 owner lease 丢失 → `markWriteUncertain`（src/engine/session.ts:1614）→ write_uncertain 生命周期，**封会话停写**。保守正确（绝不双写），但一次瞬时失败废掉整个会话。
- **maka 对应**：`requireDurableWrite` 失败后 `eventLandedInLedger(id)` **读回账本**判"已落地/未落地"——已落地则继续，未落地才判失败（packages/runtime/src/agent-run.ts:988-1007）。
- **实施提示**：pico 的 event_id 是库级主键且幂等（同 id 同 payload 返回原 seq），读回仲裁有现成基础。可在 markWriteUncertain 之前加一步"回读该批 event_id"，全部落地则恢复可写。

### P2 conversation-state.json 收进 SQLite【已完成 69bb4bdc】

> **落地记录（2026-08-19）**：control scope migration 2 三表（desktop_idempotency/desktop_input_queue/desktop_first_send_claims）；DesktopConversationStateStore 契约抽取，装配默认切 SQLite 实现；legacy JSON 按 workspace 分片各自单事务导入，双层防双导入。测试 tests/integration/conversation-state-sqlite.test.ts（B1-B3，6 条）。偏差：PK 为 (workspace_path, key) 复合键；removeQueued 加 workspacePath 参数（唯一调用方）。ADR 28。

- **现状**：请求级幂等 key、首条消息 claim、steer/queue 消息队列全在 `$PICO_HOME/desktop/conversation-state.json`（JSON 文件 + writeJsonAtomic），src/daemon/desktop-conversation-state.ts。与"事实全部进 SQLite"的迁移方向矛盾：原子性靠 rename 不靠 WAL，daemon 崩溃窗口无事务保护。
- **maka 对应**：`core_message_receipts`（submit/retract/interrupt 幂等 receipt）+ `core_root_source_message_proofs`（一条 messageId 只能绑一个 turn）+ `admitRootTurn` 持久准入（防双 root turn），全部库内事务。
- **实施提示**：pico 七 scope 里 control scope 是自然归置点；需考虑与现有 desktop-conversation-state.ts 的迁移/兼容（旧 JSON 读取一次性导入）。

### P3 continuation claim 协议（跨 run 续跑）【已完成 914da1c6 + 8c29c6c5】

> **落地记录（2026-08-19）**：sessions scope migration 3 runtime_continuation_claims；claimContinuation 单事务（interrupted 校验+前缀 digest sha256）；run.started data.continuationOf；run seal 防线为本次新增，**全量回归后收窄为 claim-scoped**（8c29c6c5：全量终态封口误拦 fork 工作流/记忆仓储的合法终态后写入，且 digest 覆盖前缀不受终态后追加影响——ADR 29 §4 已修订）。测试 tests/integration/continuation-claim.test.ts（C1-C4，4 条，digest 手工对账；C4 为 claim-scoped 口径）。偏差：UNIQUE 组合键 (session, run)；调度接入（goal/cron）为预留（executor continuationOf 入参尚无生产调用方）。

- **现状**：run 中断只补 `run.terminal(interrupted)`，无"从安全边界续跑"协议；长任务中断=上层重来。
- **maka 对应**：`runtime_continuation_claims`（claim 事务内重读 boundary + high_water + prefix_digest 校验；claim 成功 seal source ledger）+ continuation-start 事件缝合 target run。设计文档 `docs/architecture/runtime-resume-phase3-phase4-workspace-checkpoint-design.zh-CN.md`。
- **评估**：收益集中在长 goal/cron 任务；复杂度高（digest 协议+seal 语义），优先级最低，建议等 P0-P2 落地后复评。

### 次要

- 外部会话导入：maka 有 importer（Claude Code/Codex → StoredMessage → 反向物化账本）；pico 无。
- 崩溃 failpoint 契约文档：pico 恢复逻辑只有代码无契约（与既有"决策文档债"记录一致）。

---

## 3. 明确不抄清单（已论证，勿重开）

1. **消息/事件事务分离**：无文献支持（物化视图文献全在研究如何保持一致；eventual consistency 文献只在分布式约束下论证），maka 自己零文档论证（begin() 四事务从未出现 "transaction" 一词），属迁移遗产。maka ADR 自己承认"事务一致不能消除两套状态机的解释漂移"。
2. **用户消息先落消息表再落事件**：同上，且制造"消息有事件无"中间态。
3. **partial 攒批 mutable 中间表**：pico partial 直接进账本更简单诚实；maka 那套省空间但引入可变状态+删除协议。
4. **T1/T2 事务形状**：pico 已有同形状（tool.started/tool.result.recorded）；缺的只是台账表与恢复状态机（见 P0）。

**文献依据**（可引）：Kreps "The Log" 2013（日志主权+投影可重建）；Stonebraker "One Size Fits All" CIDR 2005 + C-Store VLDB 2005（读写形状分离）；Bailis PBS VLDB 2012（一致性窗口定价）。CQRS/Event Sourcing 学术实证基本空白（Crossref 扫描结论：全在低级期刊）。

---

## 4. maka 文档考古结论（为什么抄它的文档方法论）

- **论证充分**（达到可引用级）：T1/T2 边界（"Why the tool does not run inside one long transaction"专节）；终态两段式（terminal fact before terminal state）；continuation claim 事务。
- **零论证**（纯代码事实）：begin() 四事务；消息/事件双写粒度（一致性表述仅一句 "must cooperate"）。
- **规律**：maka 在"删掉边界会产生正确性缺陷"处有系统论证，在"边界只是遗产"处零文档——文档覆盖模式与代码考古结论互证。
- **可借的文档模板**：failpoint 表（P0-P11）+ 崩溃状态机 + 被否决方案 + 验收不变量四件套（maka recovery-resolver ADR）。

---

## 5. 关键文件索引

**pico**（19cca177）：
- 投影同事务核心：`src/storage/sqlite/sqlite-runtime-event-store.ts:1094`（appendBatchLocked）
- 事件构造/恢复：`src/runtime/runtime-run.ts`（commitMessages:927 / commitExternalMessageOnce:780 / reconcileIncompleteRuns:362 / finish:1268）
- ReAct 循环：`src/engine/loop.ts`（tool result inline shaping:2943 / checkpoint:1246）
- 写失败：`src/engine/session.ts`（markWriteUncertain:1614）
- 幂等/队列（JSON 文件）：`src/daemon/desktop-conversation-state.ts`、`src/daemon/desktop-runtime-service.ts`（sendSession:1377）
- daemon 账本：`src/storage/sqlite/sqlite-runtime-control-store.ts:1312`（daemon_events+daemon_runs 同事务）

**maka**（main）：
- run 生命周期：`packages/runtime/src/agent-run.ts`（begin:650 / acceptMappedEvent:600 / 写失败仲裁:988）
- 工具台账：`packages/runtime/src/tool-runtime.ts`（T1/T2）、`packages/storage/src/sqlite-runtime-store.ts`（commitToolPrepared:1645 / commitToolOutcome / seal:2594）
- 消息投影：`packages/storage/src/sqlite-session-metadata-store.ts`（appendMessages:1352，64KB 分块）
- continuation：`packages/storage/src/sqlite-runtime-store.ts`（claimContinuation:828）
- 恢复：`packages/runtime/src/runtime-ledger-repair.ts`、`packages/core/src/tool-ledger-scanner.ts`
- 文档：`docs/architecture/runtime-resume-architecture.md`（Ch.8）、`runtime-resume-phase0-crash-contract.md`、`runtime-recovery-resolver-adr.zh-CN.md`、`runtime-core-architecture-draft.md`（注意其 file-backed 布局描述已过时，以 SQLite 代码为准）

---

## 6. 后续动作

1. **先写 ADR**：一份合并覆盖 P0+P1（同属"写路径故障恢复协议"），套 maka 四件套模板（failpoint 表+状态机+否决方案+验收不变量）。P0 的关键设计决策=轻量方案（事件流内判定+indeterminate 标记）vs maka 式 journal/operations 两张表，ADR 里定。
2. **P1 先行交付**（小而独立）：markWriteUncertain 前加"回读该批 event_id"仲裁步；验收=写失败注入集成测试（失败→回读全部落地→会话恢复可写；回读缺事件→仍走 write_uncertain）。
3. **P0 跟进**：涉及恢复语义变更，验收须含崩溃注入集成测试；若引入新事件 kind 须同步 assertRuntimeEvent（surface 重构教训）。
4. 每项独立交付，走 AGENTS.md 流程；完成后在本文对应小节补落地记录（commit hash）。
5. 本 worktree（scratch/maka-gap-analysis）承载调研与实施；勿 junction node_modules 进 worktree（2026-08-16 事故教训）。
