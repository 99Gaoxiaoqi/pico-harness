# Graph 持久调度硬切开发计划

## Approach

直接用持久化 Graph 控制面替换现有 `graph.*` 事件状态机、`DelegationManager` Graph 分支和 engine 内 continuation。新的调度权威落在 workspace `pico.sqlite`，Operator 复用持久 child Session，Activation 复用普通 `RuntimeRun`，所有恢复都绑定预分配的精确 Turn/Run ID。

## Scope

- In:
  - 保留公开的 `orchestrationMode="graph"`、CLI/TUI/Desktop 模式入口和普通 Session/RuntimeEvent 执行语义。
  - 新增 schedule revision、operator provision、activation claim、record ref、supervisor wake/attempt 的 SQLite 控制面。
  - 新增 `view_agent_graph`、`update_agent_graph`、`yield_agent_graph` 和 operator-only `agent_output`。
  - 支持首版主路径：add、stop、finish、已提交输入引用、有界 handoff、不同 Operator 并行、同一 Operator 串行、daemon 启动恢复。
  - 删除 v1 调度写链路；旧 `graph.*` RuntimeEvent 不迁移、不续跑，只作为不可变历史保留。
- Out:
  - 不维护 v1/v2 双运行时或活动 Graph 原地迁移。
  - 不实现自动 `map` / `all_settled`、任意删边重连、可视化节点编辑器和全局公平调度。
  - 首版不实现跨 Graph epoch 历史结果输入、existing-operator follow-up 和丰富 replace 语义。

## Action Items

- [x] 1. 已定义 `src/agent-graph/core/` 领域契约和纯状态转换，覆盖 Graph、revision、Operator、ActivationIntent、Provision、Claim、RecordRef、Wake，以及 revision CAS、finish fence、唯一 Claim 和 exact Run 身份。
- [x] 2. 已新增 `src/storage/sqlite/agent-graph-scope.ts` 与 `sqlite-agent-graph-control-store.ts`，将 schedule、Provision、Claim、RecordRef、yield、Wake、Attempt 表接入 workspace SQLite scopes；竞争写通过共享数据库的 `BEGIN IMMEDIATE` 与版本/唯一约束仲裁。
- [x] 3. 已实现 `src/runtime/agent-graph-runtime-adapter.ts` 和 exact Run port，幂等 provision 持久 child Session，持久化 profile/workspace 快照，并用 Claim 预分配的 Turn/Run/Invocation/Event ID 启动、观察或安全 attach 普通 `RuntimeRun`。workspace host 已把 model/tools 映射到待执行输入；production 最终接线及 `permissionPolicy`、`systemPromptVersion` 的完整恢复仍列为发布缺口。
- [x] 4. 已实现 operator-only `agent_output` 和 reference-only Record 投影，只接受 committed、non-partial、身份及 owner fence 匹配的 RuntimeEvent，并按单条 16 KiB、总计 48 KiB 生成带 provenance 的下游 handoff。
- [x] 5. 已实现 `src/agent-graph/reconciler.ts`，按 stop → provision → resolve inputs → revision-conditional claim → begin executing → project records 推进到 fixed point；finish 阻止 fresh Claim，但保留既有 Claim 与 Runtime 事实。
- [x] 6. 已实现 workspace 级 `AgentGraphSupervisorService` 及 `WorkspaceRuntimeService` 生命周期接入，覆盖启动扫描、single-flight reconcile、持久 yield/Wake/Attempt、退避、权限等待、manual intervention 和精确根 RuntimeRun。
- [x] 7. Graph 工具与 prompt 已硬切为 `view_agent_graph`、`update_agent_graph`、`yield_agent_graph` 和 operator-only `agent_output`；已删除 `DelegationManager` Graph 分支、Graph work lease、旧 settle/reconcile/recover 与 engine continuation 写路径。旧 `graph.*` 仅保留历史 codec/reducer，不迁移、不续跑。
- [ ] 8. 确定性集成测试已覆盖 revision 幂等/冲突、readiness、stop/finish 与 Claim 竞争、两个 SQLite store/进程竞争、投影重建、exact Run attach/indeterminate、yield/wake 竞态和 workspace 生命周期；同 Operator 多 Intent 的公开协议尚未开放，独立 Operator 的真实并行执行仍需宿主级验证；也尚未用独立子进程逐一 kill/reopen 覆盖 claim 后 Run 前、provider 前后、terminal 后 wake 前的全部崩溃窗口。
- [ ] 9. Graph v2 架构文档和旧数据硬切说明已更新；发布前仍需完成 production daemon host 的最终执行接线、为 `isolated-worktree` 提供 resolver（当前默认仅支持 `shared`，否则 fail closed）、消费 `profileSnapshot.permissionPolicy` / `systemPromptVersion`，并增加真实模型 E2E `add → yield → operator output → durable wake → finish`；最终代码还需重新运行 Graph 相关集成测试、`npm run typecheck`、`npm run check:architecture`、格式检查和差异审查。

## Validation

- 同一 ActivationIntent 在并发和重启后最多产生一个 Claim、一个 child Session 绑定和一个 target RuntimeRun。
- target Run 一旦存在，恢复只观察或恢复该 Run，provider 不会因 Graph reconcile 再调用一次。
- 输入未提交、Graph 已 finish 或 revision 已变化时，不产生 provision 之外的 fresh execution side effect。
- coordinator、UI callback 或进程崩溃不会改变 SQLite/Runtime ledger 中已经提交的事实，重启后能够从持久状态收敛到相同投影。
- `npm run typecheck`、`npm run check:architecture`、Graph 相关集成测试和一条真实模型 Graph E2E 在最终代码状态上通过。
