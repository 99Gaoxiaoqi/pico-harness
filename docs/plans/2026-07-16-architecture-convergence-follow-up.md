# Pico Harness 架构收敛后续计划

> 状态：实施中
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

- [ ] 删除前台 legacy `HookRunner` fallback，只保留受信任的 canonical HookService。
- [ ] 将 macOS user daemon 的 service label 与 `PICO_HOME` 状态根绑定，并显式传递环境。
- [ ] daemon Server 在 dispatch 前统一执行严格方法参数校验。
- [ ] Desktop daemon 启动、失败和退出共用同一生命周期协调器。

### 验收

- HookService 初始化失败时不得执行 legacy shell command。
- 两个不同 `PICO_HOME` 生成不同 daemon label、plist 和 endpoint，且环境指向各自状态根。
- 畸形但已认证的参数必须在 service dispatch 前被拒绝。
- daemon 启动中退出或启动后失败都必须完成 owned resource 清理；external daemon 不得被误停。

## 第二部分：事件通道与背压

- [ ] replay 按字节预算分页，并以稳定 cursor/high-watermark 衔接 live 事件。
- [ ] 客户端补齐完整 backlog 后再释放 live buffer，不丢失超过单页的事件。
- [ ] 从 durable timeline 移除 `assistant.delta`、`assistant.message` 和 `tool.output`。
- [ ] 为 Renderer timeline 和事件去重状态设置明确上限。
- [ ] 删除 `WorkspaceRuntimeService` 中无读取者的进程内事件缓存。

### 验收

- 超过 10,000 条或 1 MiB 的 backlog 能分页恢复且顺序稳定。
- replay 与 live 交界处不丢失、不重复交付。
- SQLite 不再为逐 token delta 和 stdout/stderr chunk 持续增长。

## 第三部分：状态权威与运行时边界

- [ ] 将 `TaskStore` 改为一次性 legacy migration，停止 JSON 持续双写和反向导入。
- [ ] 为长生命周期 `SessionRuntime` 增加 Session pin/release，TTL/LRU 不驱逐活跃宿主。
- [ ] 在 `AgentRuntime` 入口冻结唯一 `picoHome/runtimeEnv` 并显式传播。
- [ ] 为 RuntimeEvent 投影提供真正的 existing/read-only 打开路径。
- [ ] 将跨 Home 的进程内 RuntimeRun 串行 key 纳入数据库路径。

### 验收

- SQLite 是 Task 的唯一持久控制面；旧 JSON 只迁移一次。
- 相同 cwd/sessionId、不同 `PICO_HOME` 的 Session、队列和数据库完全隔离。
- Transcript 等只读查询不创建数据库、不执行 schema 写事务。

## 第四部分：未接入代码退出

- [ ] 删除已确认零生产调用的 RuntimeRun、Session、Tool helper 和 deprecated facade。
- [ ] 删除无生产写入者的 learned `SkillRegistry` 与 `MemoryNudger`，保留 `SkillLoader/skill_view`。
- [ ] 若没有明确 `memory_search` 产品入口，删除 Session FTS 投影链及 fallback。
- [ ] 完成 Summary aggregate index 一次性迁移并退出长期双写/fallback。
- [ ] 删除产品入口已禁用的 model fallback，保留 retry、限流和凭证轮换。
- [ ] 更新架构文档，使事实源、Memory、Goal、rewind 和 Desktop secret 边界与实现一致。

### 明确保留

- `src/storage/blob-garbage-collector.ts`
- `src/storage/retention-policy.ts`
- `AgentRuntime`、`AgentEngine`、`Session` 当前状态 owner。
- worktree-only 的可写子代理模式；不实现尚无明确需求的 shared-workspace OCC。

## 最终验证与交付

- [ ] 最终集成态通过 `npm run lint`。
- [ ] 最终集成态通过 `npm run typecheck` 和 `npm run build`。
- [ ] Desktop 相关变更通过 `npm run desktop:typecheck` 和适用的打包验证。
- [ ] 存储相关变更通过 `npm run check:storage` 和针对性 smoke。
- [ ] 完成一次聚焦独立复审，确认没有恢复 fallback、双写或新状态 owner。
- [ ] 检查最终差异，只提交本计划范围内的变更并保护用户已有文件。

## 完成记录

实施过程中按部分补充提交哈希、验证命令和必要的迁移说明。
