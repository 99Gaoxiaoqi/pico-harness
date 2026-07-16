# Pico Harness 架构收敛后续计划

> 状态：已完成
> 建立日期：2026-07-16
> 基线：`main@2235201`
> 集成分支：`codex/architecture-convergence-2`
> 原则：保留唯一 Runtime 主路径；先消除安全、状态根和生命周期分叉，再退出长期兼容与半接入能力。避免大型重写、通用 Context、Repository 或 DI 框架。

## 完成标记

- 未开始：`- [ ]`
- 完成：`- [x] ... ✔️`
- 只有实现、相关验证、最终差异检查均完成后才可打勾。
- 每部分独立提交；验证失败时不进入下一部分。

## 第一部分：安全与宿主生命周期

- [x] 删除前台 legacy `HookRunner` fallback，只保留受信任的 canonical HookService。✔️
- [x] 将 macOS user daemon 的 service label 与 `PICO_HOME` 状态根绑定，并显式传递环境。✔️
- [x] daemon Server 在 dispatch 前统一执行严格方法参数校验。✔️
- [x] Desktop daemon 启动、失败和退出共用同一生命周期协调器。✔️

### 验收

- HookService 初始化失败时不得执行 legacy shell command。
- 两个不同 `PICO_HOME` 生成不同 daemon label、plist 和 endpoint，且环境指向各自状态根。
- 畸形但已认证的参数必须在 service dispatch 前被拒绝。
- daemon 启动中退出或启动后失败都必须完成 owned resource 清理；external daemon 不得被误停。

### 完成记录

- 提交：`363d597 refactor(hooks): 删除前台旧 HookRunner 回退路径`；`d888217 fix(daemon): 隔离状态根并收紧请求校验`；`58b9fa9 fix(桌面端): 收敛守护进程启动退出生命周期`。
- 验证：Node 22.23.0 下 `npm run lint`、`npm run typecheck`、`npm run build`、`npm run desktop:typecheck`；子任务 smoke 覆盖 legacy Hook trust、跨 Home service/endpoint、真实 IPC 非法参数拒绝和 Desktop 启停竞态。
- 说明：canonical Hook loader 继续兼容 `.claw` source，但所有 executable 必须通过统一 trust；external daemon 不纳入 Desktop ownership。

## 第二部分：事件通道与背压

- [x] replay 按字节预算分页，并以稳定 cursor/high-watermark 衔接 live 事件。✔️
- [x] 客户端补齐完整 backlog 后再释放 live buffer，不丢失超过单页的事件。✔️
- [x] 从 durable timeline 移除 `assistant.delta`、`assistant.message` 和 `tool.output`。✔️
- [x] 为 Renderer timeline 和事件去重状态设置明确上限。✔️
- [x] 删除 `WorkspaceRuntimeService` 中无读取者的进程内事件缓存。✔️

### 验收

- 超过 10,000 条或 1 MiB 的 backlog 能分页恢复且顺序稳定。
- replay 与 live 交界处不丢失、不重复交付。
- SQLite 不再为逐 token delta 和 stdout/stderr chunk 持续增长。

### 完成记录

- 提交：`65ab866 fix(事件通道): 收敛分页回放与持久事件`。
- 验证：真实 socket + SQLite smoke 覆盖 10,050 条 durable backlog、24 页回放及 1 条并发 live event，共 10,051 条无丢失无重复；全部响应通过 1 MiB 帧编码，跨 workspace cursor 被拒绝。
- 说明：high-watermark 在首个订阅页冻结；后续页只追到该边界，live event 在 client buffer 中等待 replay 补齐。Desktop 不再复制存储高频文本流。

## 第三部分：状态权威与运行时边界

- [x] 将 `TaskStore` 改为一次性 legacy migration，停止 JSON 持续双写和反向导入。✔️
- [x] 为长生命周期 `SessionRuntime` 增加 Session pin/release，TTL/LRU 不驱逐活跃宿主。✔️
- [x] 在 `AgentRuntime` 入口冻结唯一 `picoHome/runtimeEnv` 并显式传播。✔️
- [x] 为 RuntimeEvent 投影提供真正的 existing/read-only 打开路径。✔️
- [x] 将跨 Home 的进程内 RuntimeRun 串行 key 纳入数据库路径。✔️

### 验收

- SQLite 是 Task 的唯一持久控制面；旧 JSON 只迁移一次。
- 相同 cwd/sessionId、不同 `PICO_HOME` 的 Session、队列和数据库完全隔离。
- Transcript 等只读查询不创建数据库、不执行 schema 写事务。

### 完成记录

- 提交：`dbbbad1 refactor(storage): 增加运行时事件只读投影入口`；`909a6cf refactor(tasks): 统一任务持久化权威`；`ebbc656 refactor(runtime): 收紧会话生命周期与状态根边界`。
- 验证：Task legacy queued/running/terminal、重复迁移和崩溃重试 smoke；Session pin/release 的 TTL/LRU smoke；同 cwd/sessionId 跨 Home 的环境、队列和 RuntimeEvent 隔离 smoke；只读 projection smoke 验证数据库 mtime/size 不变且缺失路径不被创建。
- 说明：TaskRegistry 继续作为进程内执行视图；live RuntimeRun 的 write guard 已改为必填，detached 写入只保留 fork 内部窄入口。

## 第四部分：未接入代码退出

- [x] 删除已确认零生产调用的 RuntimeRun、Session、Tool helper 和 deprecated facade。✔️
- [x] 删除无生产写入者的 learned `SkillRegistry` 与 `MemoryNudger`，保留 `SkillLoader/skill_view`。✔️
- [x] 在没有明确 `memory_search` 产品入口的前提下，删除 Session FTS 投影链及 fallback。✔️
- [x] 完成 Summary aggregate index 一次性迁移并退出长期双写/fallback。✔️
- [x] 删除产品入口已禁用的 model fallback，保留 retry、限流和凭证轮换。✔️
- [x] 更新架构文档，使事实源、Memory、Goal、rewind 和 Desktop secret 边界与实现一致。✔️

### 完成记录

- 提交：`6c0c28f refactor(core): 删除无调用的兼容门面`；`555e1f8 refactor(memory): 删除未接入的搜索与学习链路`；`94bb87c refactor(memory): 退出摘要聚合索引`；`7b1efbf refactor(runtime): 收敛模型路由与会话兼容接口`；`5138151 docs(architecture): 收敛当前架构事实`。
- 删除：FTS5/InMemorySearch、learned SkillRegistry/MemoryNudger、bare-model fallback、legacy CLI/TUI Runtime 转发层，以及零调用的 Session/RuntimeRun/Tool helper；真实 `SkillLoader/skill_view`、RuntimeEvent、Summary、retry、限流和凭证轮换保留。
- 迁移：Summary per-session v2 成为唯一权威；legacy aggregate 只固定快照迁移一次。Task JSON 同样通过固定快照和 durable marker 完成永久 cutover；首次无源后新出现的 JSON 也不再影响 SQLite。
- 复审修复：`5f048d5 fix(tasks): 固化旧任务迁移切换点`；`5695021 fix(runtime): 修复回放与实时事件重叠去重`。真实 socket + SQLite smoke 覆盖 10,050 条 replay/live 完全重叠，无丢失、无重复且 cursor 不回退。
- 文档：当前架构只承诺 worktree-only 可写 Worker；Shared/OCC 降为未采用的历史提案。Summary 明确为 compaction/rewind/fork sidecar，不宣称是 Session 恢复真源或跨重启增量摘要来源。

### 明确保留

- `src/storage/blob-garbage-collector.ts`
- `src/storage/retention-policy.ts`
- `AgentRuntime`、`AgentEngine`、`Session` 当前状态 owner。
- worktree-only 的可写子代理模式；不实现尚无明确需求的 shared-workspace OCC。

## 最终验证与交付

- [x] 最终集成态通过 `npm run lint`。✔️
- [x] 最终集成态通过 `npm run typecheck` 和 `npm run build`。✔️
- [x] Desktop 相关变更通过 `npm run desktop:typecheck` 和适用的打包验证。✔️
- [x] 存储相关变更通过 `npm run check:storage` 和针对性 smoke。✔️
- [x] 完成一次聚焦独立复审，确认没有恢复 fallback、双写或新状态 owner。✔️
- [x] 检查最终差异，只提交本计划范围内的变更并保护用户已有文件。✔️

## 完成记录

- 最终集成态在 Node 22.23.0 下通过 lint、核心与 Desktop typecheck、核心 build、SQLite/WAL storage check，以及 macOS arm64 Desktop package。
- 定向 smoke 覆盖 Hook trust、daemon 状态根与生命周期、RuntimeEvent 只读投影、Task/Summary 固定快照迁移、Session pin/Home 隔离、显式模型路由，以及 10,050 条 replay/live 重叠去重。
- 聚焦独立复审发现并修复 Task migration cutover 与 replay/live overlap 两项问题；修复后重新执行受影响 smoke 和最终全量校验。
- 最终扫描未发现已删除入口、model fallback、learned memory 或测试代码残留；差异仅包含本计划范围内的实现与文档，主工作区既有未跟踪文件保持不变。
