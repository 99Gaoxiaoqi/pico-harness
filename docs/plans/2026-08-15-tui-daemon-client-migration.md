# 3-D TUI：daemon 客户端迁移立项

> 日期：2026-08-15
> 用途：阶段 3-D 单独立项（北极星方案 §3.4 预留——"部署模型变更最大，单独立项"）。
> 前置：3-A/3-B（runtime-host kernel 承载 + 硬切）+ 3-C（Desktop fail-stuck 恢复 + D9/D12 反转）均已完成。
> 关联：`docs/plans/2026-08-13-north-star-gateway-and-claim.md`（北极星方案）、`docs/plans/2026-08-14-runtime-host-phase3-handoff.md`（3-B/3-C 交接）

## 一、终态架构（用户拍板）

**交互 TUI = daemon 瘦客户端**：`pico` 经 `LocalRuntimeClient`（kernel 模式，`surface: "tui"`，协议已预留）连上/拉起常驻 daemon；引擎执行唯一在 daemon 侧（session.send → startForegroundRun）。TUI 进程只保留展示层（Ink 组件 + TuiReporter 投影）与本地 UI 命令。

- **交互进程内路径最终退役**（用户拍板 2026-08-15）：Phase 5 删除 repl.tsx 装配链，不保留 `--local` 逃生门。
- **headless 永久直连**：`internal:headless`（headless-one-shot-runner → executeAgentRuntime 直调，SilentReporter）零 daemon 依赖，CI/benchmark 路径永不迁移。
- 会话独占从进程内 `globalSessionManager.getOrCreatePinned` 变为 daemon 侧持有；TUI 客户端不触碰引擎装配。

## 二、现状盘点（2026-08-15 两轮侦察）

### TUI 体量与分割

`src/tui` 共 16,306 行 / 55 文件：

- **~75% 纯展示层（保留）**：app/input-box/tool-card/approval-panel/inspector/session-browser/terminal-grid 等。
- **~25% 运行时编排（替换面，≈4k 行）**：repl.tsx（3,916 行）中的 bundle 装配（buildSessionBundle + model router + MCP + fork）、runAgent/runTuiAgentPrompt 闭包、plan control、wake coordinators、line-mode。
- **数据/投影层（改造后保留）**：tui-reporter.ts（884 行）——append-only TranscriptEventStore + 投影 + 33ms 渲染合流，天然是事件驱动模型；迁移本质是"输入源从引擎回调换成 events.subscribe + session.transcript"。

### daemon 协议能力矩阵（交互外壳所需）

| 需求 | 协议面 | 状态 |
|---|---|---|
| 发起会话轮 | `session.send`（启动即返回 + disposition started/steered/queued/replaced；idempotencyKey） | ✅ |
| 流式文本 | `run.live`（thinking/assistantMessage append/complete/clear，块级 delta，streamId/turnId 身份） | ✅（ephemeral 不回放） |
| 工具/步骤进度 | durable `run.timeline`（含 run.started/finished） | ✅ |
| **工具实时卡片/子代理活动** | —（run.live 仅两种文本流；DesktopReporter 有回调但未路由） | ❌ **Phase 1 补** |
| 历史回填/重连恢复 | `session.transcript`（revision 分页 + queuedInputs + planProjection） | ✅ |
| 审批 | `approval.requested/resolved` 事件 + transcript 兜底 + `approval.respond`（幂等/作用域断言） | ✅ |
| 计划 | `plan.updated` + `plan.respond`（TUI 控制形状 1:1 映射） | ✅ |
| 中断/steer/排队 | `run.cancel`（协作式，清队列）/ `run.steer`（仅文本）/ behavior queue/replace | ✅ |
| 会话 CRUD/fork/compact/rewind/changes/memory/jobs | `session.*` / `rewind.*` / `changes.*` / `memory.*` / `jobs.*` | ✅ |
| 订阅重连 | `events.subscribe` 重连环（游标续传/失效重置/去重环；每订阅独占连接） | ✅ |
| **自由文本 ask-user** | `prompt.requested/respond` 仅选项（optionId/label） | ❌ Phase 3 扩展 |
| **非 UI session driver** | 逻辑困在 Desktop renderer 的 React hook（3.7k 行）；叶子 reducer（applyLiveAssistantUpdate/applyLiveReasoningUpdate/applyTimelineNotification）是纯函数 | ❌ Phase 3 提取 |

### 关键约束

- `session.send` / `run.start` 均不在 `KERNEL_RETRY_SAFE_METHODS`（P1-2 非幂等写不自动重发）；session.send 自带 idempotencyKey，手动重试安全。
- run.live 永不回放：重连后在途流文本丢失，靠 `assistantMessage complete` 触发 transcript 回填（Desktop 先例）。
- 现有 `pico run` 已退役（RETIRED_OPTIONS）；`--daemon-stop` 是 CLI 目前唯一 daemon 交互（探测式，绝不拉起）。

## 三、阶段划分（每步独立提交 + 对抗审查）

| Phase | 内容 | 验收标准 |
|---|---|---|
| **1 ✅（08833ce0 + 2eadb002）** | **run.live 扩展 tool/subagent 实时事件**：协议新 kind + production-host 路由 + tool output ~50ms daemon 侧合流 + 分级裁剪兼容 + 未知 kind 前向兼容（旧客户端忽略不报错）；后续补齐 started 项 args（4KB 展示上限） | 桥接集成测试（形状/合流/裁剪/容忍）+ runtime-host 全套回归；Desktop 立即受益于"可选消费" |
| **2 ✅（8b01dd81）** | **TUI 客户端 tracer**：`--client` 旗标；四件套——transcript-item-hydration（RPC items→TranscriptEvent[]）/ daemon-event-reporter（通知→TuiReporter 适配，append-only+reload 对账）/ client-session-runtime（无 Ink 可测核心）/ client-repl（复用 `<App>` 的 Ink 薄壳）；审批走 approval.requested+approval.respond（approval-dialogs 共享模块提取） | 假 client 集成测试驱动客户端环（tui-client-tracer 5/5）；真实 daemon 冒烟延后 Phase 4 |
| 3 | **parity 补齐**：~~plan.respond 接线~~ ✅（95b479d2）；~~wake 订阅渲染~~ ✅（Phase 2 已交付，a20bd320 固化）；~~BYOK 旗标合并~~ ✅（0f10f65f）；~~slash 命令 RPC 化~~ ✅ tier1 29 命令（e79db76a + d7b019ec：客户端注册表 + 可测宿主 + 建议源；前置修复跨会话事件泄漏 eb0f2eb5）。~~剩余三项~~ ✅（Phase 3 收口，2026-08-15）：wire 归一化共享模块（bd308097——终态/审批/activeRun 判定三处收敛，修正 Desktop 非法值 "completed"）、rewind/changes 客户端镜像（5424d72e——rewind.apply mode 参数 + 31 命令）、自由文本 prompt 全链路（d8c708d1——options 可选 0-6 + freeText 声明 + prompt.cancel + 客户端 prompt 事件接入）+ driver 提取按现状证据收口（D14 断言随收口 commit 落地）。**明确不做**（tier2/BLOCKED，Phase 4 不依赖；2026-08-16 渐进项收口后部分闭环）：~~provider/cron~~ 镜像（已闭环：收口 C 段 memory.create + provider.* + jobs.*；cron add/credential 因 automation.create 凭据门维持降级提示）、mcp 控制面（仍 BLOCKED，无 RPC）、model-usage/agents-usage（过期名，已从豁免表删除）；~~memory（协议缺 memory.create）~~（已闭环：收口 C 段）；~~/changes 单文件恢复（fileHistoryRestoreFile 无 RPC 对应，查看型 + /rewind 引导）~~（已闭环：收口 B 段 rewind.changes/restoreFile） | 与进程内 TUI 并排功能对齐；架构 invariants 加"运行时编排唯一在 daemon"的 D9 类正向断言 ✅（D14：客户端四件套零引擎装配 + 连接唯一经共享 client） |
| 4 | **默认切换**：`pico` 默认走客户端路径 | ✅ 4ffc3cbb（入口反转 + --local 过渡逃生门 + 会话旗标三式补齐（-S/--continue/--fork）+ --graph 启动覆盖 + 缺口旗标显式提示 + 冷启动连接提示；e2e 真实模型 1/1 + 真机 --help） |
| 5 | **退役进程内交互路径**：删 repl.tsx 装配链（3,592 行）+ 8 个孤儿模块（hooks-panel / mcp-elicitation-dialog / model-options / query-guard / running-input-queue / schedule-draft-dialog / schedule-draft-review，scheduler+渲染选项提取到 update-scheduler.ts）；--local 入 RETIRED_OPTIONS；line-mode 随路径删除（Phase 4 起默认路径本就无 line-mode，TERM=dumb 环境自 Phase 4 已不覆盖）；headless 不动 | ✅ 2026-08-16（见下方实施记录） |

### Phase 2 实施记录（2026-08-15）

- **架构**：TuiReporter 零改动整体复用（省略 durable sink 即客户端模式）；渲染复用导出的 `<App>`（绕过闭包私有的 ReplApp）；进程内审批对话框工厂提取为 `src/tui/approval-dialogs.tsx` 共享（repl 与 client-repl 双消费，plan 动作经 PlanApprovalControl 结构接口适配 plan.respond）。
- **对账策略**（与 Desktop 同构）：run.live 只消费 append 增量，complete/clear 不落定；`session.transcriptUpdated{reload}` → transcript 重取 → replaceTranscriptEvents 全量重建；重连丢流同理修复。
- **已实现边界**：会话选择支持新会话 + `-S/--resume`（--continue/--fork 提示走进程内）；斜杠命令本地拦截提示；attachments 忽略；审批 wire 缺 providerCallId/diff/sessionScope（2 选项面板降级）。**（2026-08-16 盘点补记）**前三项已随 Phase 3/4 关闭（slash tier1 RPC 化 + 会话旗标三式 4ffc3cbb）；providerCallId 已随 bd308097 wire 归一化补齐（ApprovalRequestedView 结构化读取）；仍开放两项漏账——attachments 忽略、diff/sessionScope 缺失（未做也未正式接受，挂 phase3 handoff 已知边界清单）。
- **测试**：tui-client-tracer 5/5（适配器投影/转换器/客户端环含 send 参数形状、中断、审批映射、scope 采纳、reload 对账）；tui-plugin-capability 的 "daemon endpoint 校验" 失败经 stash 基线验证为既有环境问题。

### Phase 3 slash tier1 实施记录（2026-08-15，eb0f2eb5 + e79db76a + d7b019ec + 68623ff2）

- **前置修复**：DaemonEventReporter 无 scope.sessionId 过滤——同工作区其他会话（wake/cron/另一客户端）的 run/live/审批事件会流入本会话（隐性 bug）；handleNotification 顶部过滤 + switchSession API（订阅不动重定向水化）+ clearTransientState。
- **注册表**：`client-commands.ts` 复用 in-process 解析/建议管线（parseSlashInput + CommandRegistry + processUserInput 全部引擎解耦），29 命令四类（本地/settings/查询/会话/运行时/输入），执行体换 daemon RPC；availability 门在 processClientInput 对等实现（in-process 在 repl.processTuiInput）；builtin /skill 兜底被客户端原生版覆盖（session.send input kind:skill）。
- **宿主**：`client-command-host.ts` 纯函数（message/clear/exit 信号/选择器对话框数据/会话切换），client-repl 接建议源（与 in-process 同语义：disabled 灰显不滤除）。
- **测试加厚（用户要求）**：命令矩阵 6 组（三态/逐 RPC/门/坏值）+ 宿主 5 组 + 真机 slash 链（/status /rename 持久化 /sessions isCurrent /new→resume 水化 /interrupt）+ **e2e 真实模型**（RUN_LLM_E2E 门，用户真实路由完整回合含流式断言 + slash 真实链路 + interrupt；实跑 3 次 2 过，首败疑环境）。
- **已知坑**：真机 idle-only 命令须等 run 终态（死端点引擎重试有窗口）；e2e 重定向往日志会把日志文件卷进 node --test 发现。

### Phase 3 剩余收口实施记录（2026-08-15，bd308097 + 5424d72e + d8c708d1）

- **现状修正**（侦察纠偏，立项时两处过期认知）：① "driver 叶子提取"大部分已达成——applyLiveAssistantUpdate/applyLiveReasoningUpdate（apps/desktop/src/renderer/conversation/items.ts）与 applyTimelineNotification（timeline.ts）**已是独立纯函数且有专测**，困在 hook 的只剩调用 glue；TUI 侧走 TuiReporter 回调、策略刻意"同构不同码"（append-only+reload 对账 vs liveTerminal+水化覆盖），强统一属过度工程——按证据关闭，交付物改为 D14 架构断言。② parity 豁免清单的 discovery 注释过期（协议方法已被 daemon 下线 METHOD_NOT_FOUND 且 in-process 无此命令）——已修正。
- **wire 归一化共享模块**（bd308097）：`packages/protocol/src/runtime-normalize.ts` 唯一来源——isTerminalRunStatus/isActiveRunStatus（水化对账口径，含 paused/cancelling）/isStreamingRunStatus（相位灯口径）/isInterruptedRunStatus + parseApprovalRequestedPayload（approval.requested 开放 JsonObject 的结构化读取）。此前终态判定四套实现两处分叉（Desktop 含非枚举值 "completed"）；TUI 修正的 planId 不回退 approvalId 语义经共享解析回流 Desktop。activeRun 对账只统一谓词不合并流程（两侧视图架构不同）。
- **rewind/changes 客户端镜像**（5424d72e）：协议 rewind.apply 加 mode 参数（daemon 透传 forkFromCheckpoint，此前硬编码 both）；客户端 31 命令（+ /rewind /checkpoint /changes）；`rewind-client-bridge.ts` 逆向映射（checkpointId→messageId 等）；local-ui-dialog-host rewind 分支升级 RewindCommandDialog 交互三相版；client-repl 接 preview 指纹缓存 + apply 后回填原 prompt（App.inputReplacement 桥）+ switchSession 切 fork。/changes 为查看型（单文件恢复无协议对应，提示走 /rewind）。
- **自由文本 prompt 全链路**（d8c708d1，统一方案=用户选项）：options 改可选 0-6 + freeText?: boolean 声明（纯开放问题免编凑选项）；AskUserAnswer 加 {kind:"text"}；handler.submitText（仅声明请求接受）；broker 选项优先、freeText 未命中按文本提交；新增 **prompt.cancel** 协议方法（Esc 取消链路此前无 RPC 对应，幂等入 KERNEL_RETRY_SAFE_METHODS）；客户端四件套此前 prompt.* 全忽略→接 onPrompt/onPromptResolved（resolved 前置不受 scope 过滤）+ respondPrompt；AskUserDialog 共享组件加文本输入态（t 进入/纯文本直达/Enter 提交/Esc 回列表），createAskUserDialogRequest 泛化 AskUserDialogActions（同步 handler 与异步 RPC 统一）——in-process bindAskUserDialogs 零改动受益。Desktop 不动（字段向后兼容）。
- **D14 架构断言**（收口 commit）：客户端四件套零引擎装配（负向：无 engine value import/globalSessionManager；type 契约除外）+ 连接唯一经 LocalRuntimeClient（正向）——北极星"全仓连接状态机实现数=1"验收经此固化；Phase 5 退役 in-process 后扩展到整个 src/tui。
- **验证基线**：typecheck 0 + invariants 9/9 + 客户端层 33/33 + 门禁 0 + e2e 真实模型 1/1。

### Phase 4 默认切换实施记录（2026-08-15，4ffc3cbb）

- **入口反转**：无旗标 `pico` → startClientRepl（客户端瘦 TUI）；`--local` 过渡逃生门走进程内（Phase 5 删除，终态不留）；`--client` 兼容保留 no-op（已是默认）。HELP_TEXT 同步。
- **会话旗标三式补齐**（默认切换后体验不降级）：`--continue` 采纳 resolveCliSession 解析出的具体 sessionId（等价 resume——mode "continue" 本就带 latest id）；`--fork <id>` 经 ClientReplOptions.forkFrom——runtime.start() 连接后 `session.fork` RPC 切新会话（原会话不动）；`-S/--resume` 照旧。
- **--graph**：ClientSessionRuntimeOptions.orchestrationModeOverride 并入 BYOK 启动覆盖桥（与 model/thinking 共用单次闩 + 重试触发点，session.settings.update 一次应用）。
- **缺口旗标显式提示**：--mcp-config/--add-dir（MCP 归 daemon 侧装配）与裸 --provider 提示用 --model——不静默丢弃。
- **冷启动预算复核**：render 先于 runtime.start()（UI 立即出现）+ 连接前系统消息"正在连接本地 Runtime（冷启动拉起 daemon 可能需要数十秒）…"——慢环境 connectOrSpawn 选举��连可达 24s 不再黑屏。选举预算本身维持既有（45s 窗口 + 3-B-4 候选封顶）。（2026-08-17 注：候选封顶已退役，对齐 maka 无上限形态，仅保留 250ms 节流。）
- **验证**：cli-entry-dispatch 5 条（fake CliRuntime 断言分派/旗标传递/快速路径）+ 相关回归 41/41 + typecheck 0 + 门禁 0 + e2e 真实模型 1/1 + 真机 `pico --help`。真机交互冒烟（默认 pico 跑完整回合）待用户实跑。

### Phase 4 全矩阵真机实测闭环（2026-08-15，aa617504）

用户要求"全方位真实大模型实测"。新增 `tests/e2e/tui-client-full-matrix.real-llm.test.ts` 四场景（每场景独立临时工作区 + 完整清理链）：①BYOK --model/--graph 真实落地；②--continue 水化与 --fork 保源（内容一致断言）；③/rewind 全链路（list → preview 指纹 → conversation fork → switchSession 水化，user 消息边界断言"一号在二号不在"）；④ask_user 自由文本（模型真实调用工具 → respondPrompt 文本回流 → prompt.cancel）。**单轮 4/4 验证**。

**逮到并修复 3 个真 bug（fake 层永远看不到）**：
1. **P0 fork ALS 重入**：SessionForkService.fork 直调 `source.serialize()`——daemon rewind.apply 在 withSession serialize task 内调 forkFromCheckpoint→fork 必抛 "re-entrant serialized execution"；in-process repl 不包 withSession 从未暴露。修复=改 `withSerializedExecution`（嵌套安全设计用途，外部调用行为不变）。
2. **P1 启动覆盖 CONFLICT 竞态**：sendText 返回后 run 注册存在窗口，BYOK/--graph 的 session.settings.update 间歇撞"仍有活动 Run"，单 send 场景覆盖**永久丢失**。修复=onRunStateChanged(false)（回合终态）重试 pending 覆盖（applied 单次闩防重复）。
3. **P1 冷启动窗口**：e2e 轮次间 daemon idle 自退后 connectOrSpawn 拉起慢（19-31s），非幂等 register/trust 直接失败。修复=workspace.register/trust 入 KERNEL_RETRY_SAFE_METHODS（幂等写；unregister 重复执行形态未证伪保守不入）+ e2e harness 首动作 ping 排水（ping 在白名单内 30s 时间预算自动重试）。

**真机实测方法论沉淀**（已入记忆）：
- **常驻 daemon 是旧代码**——改引擎侧后单测全绿 ≠ daemon 生效，必须 `--daemon-stop` 重启再测（ask_user 新 schema 那次模型亲口答"工具要求至少 2 个选项"才暴露）。
- **断言别锁模型字面输出**——"请只回复 ok"模型会回"好的。"；确定性锚点=发送的 user 文本/RPC result 字段/事件到达。分诊警惕 `JSON.stringify(item).includes()` 假阳性（匹配到 userMessage 的 prompt）。
- e2e 排水条件别用 `!running && sessionId 存在`（send 返回瞬间两者都满足=假 idle）；等投影 assistant + idle 双信号。runtime.ping 是 EmptyParams。

**验证**：全矩阵单轮 4/4 + 客户端/ask-user/kernel/invariants 回归 34/34 + 门禁 0 + typecheck 0。

**实测暴露的遗留（高优先）**：多轮高频 e2e 下 daemon 间歇死锁——连接 terminal（RUNTIME_DISCONNECTED）、稍后 ping 可恢复但窗口不定；当前 launcher 不落盘 daemon stderr，崩溃零证据——**先做 stderr 落盘基础设施再定位**。本机另有 3 个 temp-root 孤儿 daemon 进程（runtime-host 测试遗留）待清理。

**（2026-08-16 补记）死锁已根因定位并修复**，实为三连击（详见 phase3 handoff 同日章节）：① e2e 用默认 `LocalRuntimeClient()` 打**用户真 home daemon**，失败轮次的清理链同样失败 → 真 home 注册表累积 118 条 e2e 工作区（54 个 %TEMP% 目录真实存活）→ reconcile 全量物化 cron runtime（~30% CPU 忙循环）+ workspace.list 物化全部 runtime 超操作 deadline → 连接拆断；② 安全 agent 环境下 registration 发布 rename 间歇 EPERM 直接崩候选（修复：renameWithRetry 有界重试）；③ 首候选崩溃后兄弟候选被其残留 legacy 锁拒绝，3 个选举名额烧光（修复：活满 5s 后死亡的候选不占名额；2026-08-17 注：名额机制已随无上限化整体退役）。**e2e 已改每场景独立 pico-home + 专属 daemon + 结束优雅关停**（不再碰真 home），修复后全矩阵单轮 4/4（127s）。

### Phase 5 实施记录（2026-08-16）

- **删除**：`repl.tsx`（3,592 行装配链）+ 7 个零引用孤儿模块（hooks-panel / mcp-elicitation-dialog / model-options / query-guard / running-input-queue / schedule-draft-dialog / schedule-draft-review，共 ~745 行）。依赖图机械验证（全仓 import 扫描）后删除；`session-hydration.ts` 与 `rewind-runtime.ts` 保留（仍有测试覆盖活语义、engine 侧仅 type import，D14 兼容）。
- **提取**：`createTuiUpdateScheduler` + `TUI_RENDER_OPTIONS` → `src/tui/update-scheduler.ts`（client-repl 唯一消费者）。
- **入口**：`--local` 入 RETIRED_OPTIONS（明确报错），cli/main 删 startTuiRepl 分支与 defaultModelForKind；HELP_TEXT 同步。line-mode（TERM=dumb 逃生）随 in-process 路径删除——Phase 4 起默认路径已无 line-mode，如需要可后续针对客户端壳重建。
- **测试处置**：cli-entry-dispatch 改断言 "--local 退役报错 + help 不再列出"；plan-mode-host-admission 删 TUI admission 用例（daemon 侧同语义用例保留）；tui-plugin-capability 删 5 个 in-process 生命周期用例、保留 2 个纯 plugins 模块用例（fixture 收敛）。
- **D14 扩展**：architecture-invariants 的 D14 从"客户端四件套"扩到**整个 src/tui 目录**（目录枚举 + 逐文件断言：engine/runtime value import 禁止，唯一豁免 `engine/tool-result-contract.js` wire 契约工厂；globalSessionManager 全目录禁止；正向 client-repl 经 LocalRuntimeClient）。
- **验证**：typecheck 0 + invariants/cli-dispatch/plan-admission/plugin-capability/tui-transcript 30/30 + tui-client-* 24/24 + runtime-host 39/39（含 stderr 落盘新用例）+ 门禁 0 + 真机 `pico --help`。session-fork-runtime-port 3 个失败经 stash 基线验证为**预存**（与本次无关）。

### 3-D 渐进项收口（2026-08-16 追加，3898ba42 + 后续 commit）

**A 客户端 UX 三件套**（纯装配缺失，管线本就存活）：keybindings（loadPicoConfig → App.keybindings，用户自定义键位恢复）；@ 文件补全（FileIndex 本地实例 + fileMentionSuggestions，run 终态与 rewind 应用后 markDirty）；动态参数补全（/resume /fork /skill /agent 接 RPC 候选源，5s TTL 缓存 + 失败静默降级 + 包含式匹配）。

**B /changes 单文件恢复**（原协议缺口闭环）：协议新增 `rewind.changes`（checkpoint 维度逐文件 diff + 当前指纹 + 512KB patch 截断）与 `rewind.restoreFile`（idle 门 + display 路径还原 + 指纹守卫）；daemon 侧 listRewindFileChanges/restoreRewindFile；客户端 ChangesDialogHost（异步模型 + 恢复后自动重载）+ changes 桥 + changes 对话框 kind + 数据源守卫降级；/rewind 支持可选 message-id 预选（changes 面板 w 跳转）。

**C tier2 命令镜像**：协议新增 `memory.create`（sanitize + 幂等 createFact + 非 active 再激活，DesktopMemoryService.create + handler 链）；/memory 全镜像（remember/status/off/on/undo——undo token 客户端解码 + memory.update）；/provider 镜像（list/import-env 两阶段预览+confirm 走 provider.importEnvironment/default set 走 config.user.update/delete 带 revision）；/cron 部分镜像（list/status/runs/enable/disable/delete → jobs.*；add/credential 因 automation.create 凭据注入门明确降级提示）。豁免表清理：memory/provider/cron 移入镜像集，model-usage/agents-usage 为过期名删除，剩 BLOCKED=mcp 控制面/context/operations/snapshots/add-dir/plugin/hooks。

**D 旧 socket server 退役**（-server.ts + RuntimeConnection + LocalDaemonHost 旧传输分支）：LocalRuntimeClient 唯一承载 kernel（显式 endpoint 注入面删除并报错）；LocalDaemonHost 只编排 service+cron 生命周期（endpoint/instance-lock/LocalRuntimeDaemon 字段与 releaseInstanceLockWhenSafe 删除）；assembleProductionDaemonHost 去 servicesOnly 参数；测试迁移——runtime-client-replay 重写为 kernel 承载（in-process kernel + 真实 LocalRuntimeClient + host 重启重订全链，含"动态注册表 spec/handler 必须成对"与"kernel.close 消费 owner lease 重启需重选主"两个新坑）；daemon-ownership-races/lifecycle-races 裁剪锁保留断言（保留 cron 关闭失败传播/fence 排空/有界 stop/重启语义）；local-daemon-ping-hard-cut 随 LocalRuntimeDaemon 删除。desktop-plugin-parity 的 3 个 Windows 预存失败随清理消失。

**E 91 方法 spec 化——维持渐进（决策记录）**：runtime.request 通用桥已有单源严格校验（parseStrictRuntimeParams 入 service 前 + 协议类型化结果 + kernel 帧预算与 operation deadline 覆盖整个桥接操作）；spec 化的增量价值只在"某方法需要 kernel 层差异化语义"（独立 deadline/错误码精细映射/非桥接事件流）时成立，成对注册约束（spec 与 handler 必须同时在场，replay 迁移实测踩坑）使批量 spec 化的维护成本大于收益。结论：按需 spec 化，不批量。

## 四、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 流式 UX 降级（工具卡片/子代理活动无实时事件） | 高 | Phase 1 先补（本 session）；Desktop 也受益（替代 25ms 防抖重水化） |
| socket 洪泛（per-chunk 通知无节流） | 中 | daemon 侧 tool output ~50ms 合流；文本流维持块级（客户端 33ms 渲染合流已有） |
| 重连在途流丢失 | 中 | 接受（Desktop 同款）；complete 触发回填 + "reconnected" 提示 |
| 会话双主（TUI 与 daemon 同时触碰会话） | 中 | Phase 2 起 TUI 客户端零引擎装配；迁移期按会话选路径，不并行 |
| prompt 自由文本缺失（TUI ask-user 有文本输入） | 中 | Phase 3 协议扩展（prompt.requested 加输入模式 + respond 放行文本） |
| BYOK 旗标（--model/--provider）与 daemon 配置所有权冲突 | 中 | Phase 3 客户端合并（config.effective.get + 本地覆盖），不改 daemon 权威 |
| CLI 部署模型认知（用户习惯单进程） | 低 | Phase 4 默认切换前保持 `--client` 可选；常驻 daemon 语义与 Desktop/cron 一致 |
| 慢环境冷启动（候选 19-31s） | 低 | 已有 45s 选举窗口 + 3-B-4 封顶；Phase 4 复核首请求预算（2026-08-17 注：封顶已退役，仅余 250ms 节流 + 45s 窗口，慢环境窗口内可积数十在途候选为已知接受代价） |

## 五、与北极星方案验收标准的对齐

- "全仓连接状态机实现数 = 1"：Phase 3 共享 driver 提取后达成（TUI 不新增自有状态机，直接消费共享环）。
- "headless 模式不受影响"：永久直连，不在迁移面。
- "Desktop 断连自动恢复"：3-C 已交付。
- TUI 迁移完成即北极星阶段 3 收口。

## 六、本 session 范围（Phase 1 之外的明确不做）

- TUI 侧任何改动（Phase 2 起）。
- Desktop 转向消费 live 工具事件替代 25ms 重水化（Phase 3 优化项）。
- 自由文本 prompt、BYOK 合并、driver 提取（Phase 3）。
