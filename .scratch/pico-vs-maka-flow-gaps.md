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
> 验证：六文件 29/29 绿+守护 1/1；typecheck 曾因整机内存耗尽（tsc Zone OOM）阻塞，**2026-08-20 内存缓解后已补跑通过（含全部审查修复+调度接入）**。
>
> **P3 调度接入落地（2026-08-20）**：executor 级自动锚定——reconcile 后自动 claim 最新未 claim 的 interrupted run，新 run 以 targetRunId 起跑携带 continuationOf（前台/goal/cron 统一生效；显式声明与 prestartedRun 优先）。store 新增 findLatestInterruptedUnclaimedRun。测试 continuation-auto-wiring.test.ts（claim→起跑→源封口→二次不重复锚定，1/1）；executor 面 33 过 4 挂全为预存 Memory 调度家族（stash 对照逐条复现）。ADR 29 §5 已更新。
>
> **第二轮对抗审查（2026-08-20，审 4df98341..3af702af 四笔）**：主攻面（自动封口×fork/记忆）攻不破（fork 写目标会话 bootstrap run/记忆写自有表/恢复写走独立 run 或幂等豁免；cancel≠interrupted 分界安全）；2 major 已修——
> F1 迁移隔离误吞瞬态 IO（readFileSync 在 try 内，EBUSY/EPERM 会永久隔离好文件）→ 4aa2f41f：读取移出 try，永久分类=SyntaxError+"Desktop conversation*"形状错，附 F4 .failed 不覆盖历次副本（9/9 绿）；
> F2 调度接入把跨进程 reconcile 盲区升级为致命封口 → a709f479：终态新鲜度门（缺省 10 分钟，门内不 claim 不封口、存活方继续可写；真实崩溃锚定延迟到窗口后），超长存活 run 残留记录 ADR 29（根治需 reconcile 跨进程活性检测，另立决策）。
> minor 未修：F3 claim→start 跨进程窗口锚点脱钩（无生产读方，账面失真）、F5 LIMIT 32 滑窗死区（≥33 同批 interrupted 才触发）。审查者事故（junction 误删 node_modules）已恢复，desktop 依赖缺失后经 npm ci 补全，typecheck 全量通过。
>
> **推送（2026-08-20）**：main 已推送远端（96cb5cae..e4da9ccf，114 提交），与 origin 同步。
>
> **六维差距审计轮（2026-08-20）**：只读审计子代理盘点，结论分级见对话；本轮已落地——
> B-2 C4 批内封口三场景测试（0b4e60c5，6/6 绿）；m-5 ADR 编号消歧，session-catalog 让号 24a、24 归 SQLite 迁移总纲（098edeea，源码"ADR 24 §4.x"均指总纲无需改）；i-5 ADR 29 复评条件精确化（goal/cron 差异化策略仍挂账，基础锚定已落地）；扫跑器加固（36c0e94d：保留 -prev.log/拒绝非清单入参/trim）。
> **m-4 JSON 版 conversation-state store 退役并入族C**：该类耦合两个模块私有 helper（retainFirstSendClaims/emptyState），且被 desktop-conversation-state / desktop-runtime-close / desktop-memory-lifecycle-ordering 三个测试引用，后两者正是族C 清理对象——族C 重写这两个测试时一并把类降级为 tests fixture 或改用 SQLite 实现，避免现在动它打架。
> 审计遗留（未动）：B-1 全量回归未扫完（换机）、M-1 reconcile 跨进程活性检测（待立 ADR 30）、M-2 ARCHITECTURE.md 漂移、M-3 daemon 全局并发闸门无书面出处、M-5 provider fallback/compaction fail-open 需对账（文档显示已拍板）、m-1/m-2/m-3 挂账、findOrphanGraphWorks 已接入（旧记忆有误，审计 i-4 实证）。
>
> ## 预存红集中清理计划（未执行，2026-08-20 本机过卡中断，换机续跑）
>
> 验证法已备好：`node .scratch/run-integration-sweep.mjs .scratch/all-tests.txt`（逐文件扫跑器，单文件 300s 超时防 Windows hang；all-tests.txt 用 `dir /b tests\integration\*.test.ts > .scratch\all-tests.txt` 重新生成）。失败集经三次全量扫跑交叉验证，稳定 27 文件。按五族并行派工（文件面不相交），已知根因线索：
>
> - **族A 过时/结构性**：architecture-invariants（2 挂=ENOENT 读已删的旧 runtime-event-store.ts，断言迁到 sqlite-runtime-event-store.ts，口径反映新架构）、projection-diagnostics-evidence-ref（21/1）、session-runtime-dispose（3/1）、plugin-runtime-snapshot-registry（3/1）、plugin-hook-trust（0/1）、workspace-runtime-consistency（11/1，git rev-parse 正斜杠 vs realpath 反斜杠的 Windows 路径断言）。
> - **族B memory 家族**：memory-quality（1/1）、memory-runtime-quality（2/3）、memory-runtime（**300s 挂起**）、runtime-run-executor 的 Memory 调度 4 条（其余用例绿）。历史实锤：过时 toolCall fake，修法=JSON content 形状；engine 门控变更。源面 src/memory/**。
> - **族C desktop 环境族**：desktop-runtime-close（2/1）、desktop-plugin-parity（3/1）、desktop-memory-lifecycle-ordering（0/4）、desktop-memory-ui（6/1）。线索：隔离 fixture 报"没有可用模型路由"（基座就挂，与 ADR 28 无关）；~/.pico/config.json 有 lez-claude。源面 src/daemon/desktop-*，不动 src/memory。**附加任务 m-4**：重写 desktop-runtime-close / desktop-memory-lifecycle-ordering 时，把 src/daemon/desktop-conversation-state.ts 里的 JSON 版 DesktopConversationStateStore 类（生产零实例化）一并降级为 tests fixture 或删除（它耦合私有 helper retainFirstSendClaims/emptyState，迁移时同搬）。
> - **族D terminal-bench 族（8 文件）**：normalizer（0/**33**，优先查——像 schema/快照漂移非环境）、container-policy（3 挂）、captured-process（2）、runtime-controls（2）、docker-cleanup（2）、bundle-lock（1）、task-timeout-preflight（1）。先探 `docker --version`。源面 scripts/terminal-bench/**。
> - **族E 杂项**：hook-full-flow（0/3，137s）、path-read-boundaries（0/4）、file-write-safety（5/2）、user-config-temp-recovery（1/3）、lifecycle-races（18/3，负载敏感恶化）、headless-one-shot-runner（**300s 挂起**，bootstrap 同类是绿的可对照）。线索：hooks 08-17 shell 化后现存 hooks 需 re-trust；win32 bash 语义须 skip。
> - 规矩：单文件测试禁全量；每条失败分类可修/环境依赖（有 env-gate 先例才 skip）/真缺陷；不许为绿删断言；逐族提交。

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
