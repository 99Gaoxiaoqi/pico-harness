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
| 3 | **parity 补齐**：~~plan.respond 接线~~ ✅（95b479d2：wire 元数据映射，plan 审批闭环）；~~wake 订阅渲染~~ ✅（Phase 2 已交付，背靠背回归测试固化）；~~BYOK 旗标合并~~ ✅（0f10f65f：--model/--thinking 经 config.effective.get + session.settings.update 生效）。剩余：slash 命令 RPC 化、rewind/changes、自由文本 prompt、共享 session driver 提取（Desktop 纯 reducer 上提） | 与进程内 TUI 并排功能对齐；架构 invariants 加"运行时编排唯一在 daemon"的 D9 类正向断言（预置） |
| 4 | **默认切换**：`pico` 默认走客户端路径 | e2e 真实模型冒烟（tests/e2e）+ 慢环境冷启动预算复核 + 真机 TUI 冒烟 |
| 5 | **退役进程内交互路径**：删 repl.tsx 装配链（≈4k 行）；line-mode 迁客户端或删；headless 不动 | D9 类正向断言转正：交互外壳零引擎装配；typecheck/测试/门禁全绿 |

### Phase 2 实施记录（2026-08-15）

- **架构**：TuiReporter 零改动整体复用（省略 durable sink 即客户端模式）；渲染复用导出的 `<App>`（绕过闭包私有的 ReplApp）；进程内审批对话框工厂提取为 `src/tui/approval-dialogs.tsx` 共享（repl 与 client-repl 双消费，plan 动作经 PlanApprovalControl 结构接口适配 plan.respond）。
- **对账策略**（与 Desktop 同构）：run.live 只消费 append 增量，complete/clear 不落定；`session.transcriptUpdated{reload}` → transcript 重取 → replaceTranscriptEvents 全量重建；重连丢流同理修复。
- **已实现边界**：会话选择支持新会话 + `-S/--resume`（--continue/--fork 提示走进程内）；斜杠命令本地拦截提示；attachments 忽略；审批 wire 缺 providerCallId/diff/sessionScope（2 选项面板降级）。
- **测试**：tui-client-tracer 5/5（适配器投影/转换器/客户端环含 send 参数形状、中断、审批映射、scope 采纳、reload 对账）；tui-plugin-capability 的 "daemon endpoint 校验" 失败经 stash 基线验证为既有环境问题。

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
| 慢环境冷启动（候选 19-31s） | 低 | 已有 45s 选举窗口 + 3-B-4 封顶；Phase 4 复核首请求预算 |

## 五、与北极星方案验收标准的对齐

- "全仓连接状态机实现数 = 1"：Phase 3 共享 driver 提取后达成（TUI 不新增自有状态机，直接消费共享环）。
- "headless 模式不受影响"：永久直连，不在迁移面。
- "Desktop 断连自动恢复"：3-C 已交付。
- TUI 迁移完成即北极星阶段 3 收口。

## 六、本 session 范围（Phase 1 之外的明确不做）

- TUI 侧任何改动（Phase 2 起）。
- Desktop 转向消费 live 工具事件替代 25ms 重水化（Phase 3 优化项）。
- 自由文本 prompt、BYOK 合并、driver 提取（Phase 3）。
