# Shared Worker / OCC 历史提案

> 状态：未采用的历史设计，不属于当前架构或实施路线。

这份提案曾考虑让多个可写 Worker 共享同一目录，并通过 `writeScopes`、文件版本表、短锁和乐观并发控制协调写入。当前实现没有这些类型、守卫或协议事件，也不计划为尚未出现的产品需求引入这套复杂度。

## 当前实现

- `ToolScheduler` 只协调单个 Agent、单次模型响应中的工具批次，不是跨 Agent 文件锁。
- `explore` 子代理使用受限只读 Registry。
- 可写 `worker` 必须在独立 Git worktree 和 Worker 沙箱中执行。
- Git/worktree 或监督器不可用时，worker fail-closed，不会降级写入主工作区。
- Worker 结果由宿主审查和串行集成；当前没有 Shared Worker、`writeScopes`、文件 OCC 或动态 Bash workspace gate。

## 重新评估条件

只有出现明确的无 Git 可写 Worker 产品需求，并且 worktree-only 已被证明无法满足时，才重新设计共享写入。届时应基于实际冲突与恢复需求重新形成规格，而不是把本历史提案当作兼容契约。
