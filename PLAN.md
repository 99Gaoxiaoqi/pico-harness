# Graph 持久调度增强计划

## Approach

直接用持久化 Graph 控制面替换现有 `graph.*` 事件状态机、`DelegationManager` Graph 分支和 engine 内 continuation。新的调度权威落在 workspace `pico.sqlite`，Operator 复用持久 child Session，Activation 复用普通 `RuntimeRun`，所有恢复都绑定预分配的精确 Turn/Run ID。

## Scope

- In:
  - 保留公开的 `orchestrationMode="graph"`、CLI/TUI/Desktop 模式入口和普通 Session/RuntimeEvent 执行语义。
  - 新增 schedule revision、operator provision、activation claim、record ref、supervisor wake/attempt 的 SQLite 控制面。
  - 新增 `view_agent_graph`、`update_agent_graph`、`yield_agent_graph` 和 operator-only `agent_output`。
  - 支持首版主路径：add、stop、finish、`shared` workspace、已提交输入引用、有界 handoff、不同 Operator 并行、同一 Operator 串行、daemon 启动恢复。
  - 引入宿主权威 Operator 目录、完整 readiness facts、artifact/evidence handoff、多 epoch、Desktop 只读面板、`isolated-worktree` 持久生命周期和独立进程崩溃恢复验收。
  - 删除 v1 调度写链路及历史兼容层；旧 `graph.*` RuntimeEvent 历史数据清理后不再解码。
- Out:
  - 不维护 v1/v2 双运行时或活动 Graph 原地迁移。
  - 不实现自动 `map` / `all_settled`、任意删边重连、可视化节点编辑器和全局公平调度。

## Action Items

- [x] 1. 已定义 `src/agent-graph/core/` 领域契约和纯状态转换，覆盖 Graph、revision、Operator、ActivationIntent、Provision、Claim、RecordRef、Wake，以及 revision CAS、finish fence、唯一 Claim 和 exact Run 身份。
- [x] 2. 已新增 `src/storage/sqlite/agent-graph-scope.ts` 与 `sqlite-agent-graph-control-store.ts`，将 schedule、Provision、Claim、RecordRef、yield、Wake、Attempt 表接入 workspace SQLite scopes；竞争写通过共享数据库的 `BEGIN IMMEDIATE` 与版本/唯一约束仲裁。
- [x] 3. 已实现 `src/runtime/agent-graph-runtime-adapter.ts` 和 exact Run port，幂等 provision 持久 child Session，持久化 profile/workspace 快照，并用 Claim 预分配的 Turn/Run/Invocation/Event ID 启动、观察或安全 attach 普通 `RuntimeRun`。production workspace host 已接通精确模型路由、工具、权限、system prompt 和 detached 执行。
- [x] 4. 已实现 operator-only `agent_output` 和 reference-only Record 投影，只接受 committed、non-partial、身份及 owner fence 匹配的 RuntimeEvent，并按单条 16 KiB、总计 48 KiB 生成带 provenance 的下游 handoff。
- [x] 5. 已实现 `src/agent-graph/reconciler.ts`，按 stop → provision → resolve inputs → revision-conditional claim → begin executing → project records 推进到 fixed point；finish 阻止 fresh Claim，但保留既有 Claim 与 Runtime 事实。
- [x] 6. 已实现 workspace 级 `AgentGraphSupervisorService` 及 `WorkspaceRuntimeService` 生命周期接入，覆盖启动扫描、single-flight reconcile、持久 yield/Wake/Attempt、退避、权限等待、manual intervention 和精确根 RuntimeRun。
- [x] 7. Graph 工具与 prompt 已硬切为 `view_agent_graph`、`update_agent_graph`、`yield_agent_graph` 和 operator-only `agent_output`；已删除 `DelegationManager` Graph 分支、Graph work lease、旧 settle/reconcile/recover 与 engine continuation 写路径；历史数据、codec、类型与 reducer 也已彻底退役。
- [ ] 8. 确定性集成测试已覆盖 revision 幂等/冲突、readiness、stop/finish 与 Claim 竞争、两个 SQLite store/进程竞争、投影重建、exact Run attach/indeterminate/stop/authority/损坏账本、真实宿主 operator/root execute、owner fence、yield/wake 竞态、production 装配失败和 workspace 生命周期；关键并发组连续 10 轮共 400 项无失败。尚未用独立子进程逐一 kill/reopen 覆盖 claim 后 Run 前、provider 前后、terminal 后 wake 前的全部崩溃窗口。
- [x] 9. 已完成 Graph v2 架构文档、旧数据硬切说明、production daemon host 执行接线和最终确定性验证：独立审查的 Graph/production 集成集 91/91 通过，`npm run lint`、`npm run typecheck`、严格架构边界检查、build、依赖审计（0 vulnerabilities）、Desktop typecheck/package/make、DMG 镜像校验、格式和差异检查通过。最终全量集成测试 1364 项中 1354 项通过、0 项失败、10 项仅因当前 macOS 平台跳过；Hook watcher 的丢通知、慢 guard 去重、guard 内二次写、startup gap、stop/restart 与旧异步回调撤租也已收口并通过 32 项生命周期回归。
- [x] 10. 真实模型 E2E 已在用户默认路由 `deepseek/deepseek-v4-flash` 显式执行并 2/2 通过：完整走通 root → Operator → 唯一 durable output/Record → exact root wake → `view_agent_graph` 读取随机 canary/status → finish，约 44.9 秒完成；输出内容只经 Runtime RecordRef 返回，未复制到 Graph 控制库或 wake prompt。
- [x] 11. 已修复 exact root wake 的 Provider 前失败、`agent_output` 非法 Unicode/重复 provenance 输入和 Supervisor root context 污染身份；公共 `update_agent_graph` 仅接受 `shared` workspace，`isolated-worktree` 在 submit/持久化前 fail closed。
- [x] 12. 已实现宿主内置 Operator 目录；公共 add 只接受 `profile_id`，应用服务冻结带指纹快照，production 在 Provider 前复验并强制默认权限、禁止 Session grant 累积与关闭扩展装配；Supervisor 投影不暴露内部快照。
- [x] 13. 已实现完整 readiness facts：每个 Intent 由宿主派生单一正式输出 ID，允许同 Graph 未来输出作为依赖，拒绝任意/跨 Graph/循环引用，并在 view 中暴露 resolved/in_flight/failed/unknown 分类。
- [ ] 14. 实现 artifact/evidence handoff，包含持久资源保留、摘要验证与崩溃恢复。
- [ ] 15. 已实现 root Run 绑定的多 epoch 分配：同一 root Session 复用当前 open Graph，finish 后下次 root Run 原子取得下一 epoch，工具读取不再隐式创建 Graph，且所有 root 工具请求校验精确 epoch。待完成只读 Graph query/timeline 协议与 Desktop 面板。
- [ ] 16. 实现 `isolated-worktree` 的持久 resource authority、adopt/release/retain/cleanup 生命周期和验收。
- [ ] 17. 新增独立子进程真实 kill/reopen 测试，覆盖 schedule、provision、claim、provider、output、wake 和 workspace resource 窗口。

## Validation

- 同一 ActivationIntent 在并发和重启后最多产生一个 Claim、一个 child Session 绑定和一个 target RuntimeRun。
- target Run 一旦存在，恢复只观察或恢复该 Run，provider 不会因 Graph reconcile 再调用一次。
- 输入未提交、Graph 已 finish 或 revision 已变化时，不产生 provision 之外的 fresh execution side effect。
- coordinator、UI callback 或进程崩溃不会改变 SQLite/Runtime ledger 中已经提交的事实，重启后能够从持久状态收敛到相同投影。
- `npm run typecheck`、`npm run check:architecture` 和 Graph 相关集成测试在最终代码状态上通过；真实模型 Graph E2E 必须在发布环境显式启用并通过，不能把默认 skip 视为通过。
