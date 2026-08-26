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

- [ ] 1. 定义 `src/agent-graph/core/` 领域契约和纯状态转换，覆盖 Graph、revision、Operator、ActivationIntent、Provision、Claim、RecordRef、Wake，以及 revision CAS、finish fence、唯一 claim 和 exact Run 不变量。
- [ ] 2. 新增 `src/storage/sqlite/agent-graph-scope.ts` 与 `sqlite-agent-graph-control-store.ts`，将 schedule、provision、claim、wake、attempt 表接入 `ALL_WORKSPACE_SQLITE_SCOPES`，并为跨进程竞争提供 `BEGIN IMMEDIATE` 事务接口。
- [ ] 3. 实现 `src/runtime/agent-graph-runtime-adapter.ts`，幂等 provision 持久 child Session，冻结 agent/model/tool/permission/workspace 快照，并使用 claim 预分配的 Turn/Run/Event ID 启动或恢复普通 `RuntimeRun`。
- [ ] 4. 实现 operator-only `agent_output` 和 reference-only Record 投影，只接受已提交、非 partial、身份匹配的 RuntimeEvent，并按单条 16 KiB、总计 48 KiB 解析带 provenance 的下游 handoff。
- [ ] 5. 实现 `src/agent-graph/reconciler.ts`，按 stop → provision → resolve inputs → revision-conditional claim → begin executing → project records 的顺序推进到 fixed point，并确保 finish 只阻止 fresh claim、不丢弃既有 claim。
- [ ] 6. 实现 workspace 生命周期的 `src/daemon/agent-graph-supervisor-service.ts`，支持启动扫描、single-flight reconcile、持久 wake/attempt、退避恢复和 race-safe yield，根唤醒同样使用预分配的普通 RuntimeRun。
- [ ] 7. 将 Graph 模式接线硬切到 `view_agent_graph`、`update_agent_graph`、`yield_agent_graph`，同步修改 prompt、daemon protocol、TUI/Desktop projection；移除 `DelegationManager.graphWorkId`、Graph work lease、`settleGraphWork` 和 engine continuation 的 v1 写路径。
- [ ] 8. 新增确定性集成测试，覆盖 revision 幂等/冲突、依赖 readiness、stop/finish 与 claim 竞争、同 Operator 串行、不同 Operator 并行、两个 store/host 竞争及投影重建；使用独立子进程 kill/reopen 覆盖 claim 后 Run 前、provider 前后、terminal 后 wake 前的崩溃窗口。
- [ ] 9. 增加一条真实模型 E2E 验证 `add → yield → operator output → durable wake → finish`，随后运行相关集成测试、typecheck、architecture check 和最终差异审查，并更新 Graph 架构文档与旧数据硬切说明。

## Validation

- 同一 ActivationIntent 在并发和重启后最多产生一个 Claim、一个 child Session 绑定和一个 target RuntimeRun。
- target Run 一旦存在，恢复只观察或恢复该 Run，provider 不会因 Graph reconcile 再调用一次。
- 输入未提交、Graph 已 finish 或 revision 已变化时，不产生 provision 之外的 fresh execution side effect。
- coordinator、UI callback 或进程崩溃不会改变 SQLite/Runtime ledger 中已经提交的事实，重启后能够从持久状态收敛到相同投影。
- `npm run typecheck`、`npm run check:architecture`、Graph 相关集成测试和一条真实模型 Graph E2E 在最终代码状态上通过。
