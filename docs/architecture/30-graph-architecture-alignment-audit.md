# Graph 当前架构对齐审计

> 文档类型：当前实现审计。
>
> 审计日期：2026-08-28。
>
> 事实优先级：[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) → 当前源码与可执行测试 →
> 其他架构说明。历史快照不覆盖当前实现事实。

## 0. 结论

Graph 已符合项目当前的分层、状态真源和恢复模型，核心执行闭环以及本轮识别的 G1～G5
架构缺口均已收口。

当前实现坚持两类权威分离：Graph SQLite scope 只拥有调度准入、恢复身份、诊断与根唤醒状态；
RuntimeEvent ledger 只拥有实际执行、模型/工具派发、正式输出和终态事实。两者通过稳定 ID 引用，
不会复制 Session 执行历史，也不会形成第二套 Agent runtime。

失败路径现在具备持久诊断、有限自动退避、人工处理状态和显式 CAS 重试；Desktop、Supervisor
和工具读取面共用同一 Runtime 状态投影。Graph/Application 与 Runtime 不再反向依赖 daemon，
并由严格架构门禁持续约束。

本轮没有遗留 P0/P1 架构问题。仍需持续跟踪的项目是：受凭证控制的真实模型闭环需要在发布候选
环境定期执行；Graph query result 仍是通用 JSON schema；非瞬时 Reconciler 诊断暂未提供单独的
用户触发“重新调和”按钮。这些不影响当前执行正确性，但属于后续产品化和可操作性增强。

## 1. 权威边界

```text
root RuntimeRun
  → host-bound Graph tools
  → AgentGraphApplicationService
  → schedule revision CAS
  → Supervisor / Reconciler
  → Provision + Claim
  → exact child RuntimeRun
  → agent.output RuntimeEvent
  → reference-only RecordRef
  → durable YieldInterest / Wake / Attempt
  → exact root RuntimeRun
  → view results + finish epoch
```

| Authority           | 拥有的事实                                                                                  | 明确不拥有                                |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Graph 控制面        | epoch、schedule revision、Provision、Claim、RecordRef、资源引用、诊断、yield、Wake、Attempt | 模型正文、工具执行结果、Runtime terminal  |
| RuntimeEvent ledger | `run.started`、模型/工具派发、审批、`agent.output`、`run.terminal`                          | Graph admission、调度 revision、Wake 状态 |
| Workspace runtime   | 当前宿主执行活性、取消和 detached executor 代际                                             | 跨进程恢复事实                            |
| Desktop             | 类型化协议的查询结果、状态投影和显式用户操作                                                | Graph/Runtime 事实的直接写入              |

Graph `RecordRef` 只保存来源身份与指纹。正文在读取和 handoff 时从正式 `agent.output` 事件解析并重新
校验 provenance，因此 RuntimeEventStore 仍是执行结果的唯一真源。

## 2. 当前架构映射

| 架构约束                            | 状态   | 主要实现与证据                                                                                   |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| Schedule 是调度唯一写入口           | 已符合 | `src/agent-graph/core/schedule-transition.ts`；`src/agent-graph/sqlite-control-store-adapter.ts` |
| 模型不能提供 Graph/Runtime 身份     | 已符合 | `src/tools/agent-graph-tools.ts`；`src/tools/agent-output-tool.ts`                               |
| Claim 冻结完整 Runtime 身份         | 已符合 | `src/agent-graph/reconciler.ts`；`src/runtime/agent-graph-exact-run-port.ts`                     |
| 副作用派发后不得自动重放            | 已符合 | exact Run 的 attach/live/terminal/indeterminate 判定及恢复测试                                   |
| RecordRef 不复制输出正文            | 已符合 | `src/runtime/agent-graph-runtime-adapter.ts`                                                     |
| 根 Run 必须 finish 或持久 yield     | 已符合 | `src/runtime/agent-graph-host.ts` 的 settlement guard                                            |
| 调和失败可恢复、可观察              | 已符合 | `src/agent-graph/diagnostics.ts`；Graph schema v4 diagnostics                                    |
| 根 wake 自动重试有上限              | 已符合 | 最多五次自动 Attempt，之后进入 durable `needs_attention`                                         |
| 显式重试保留历史并受 CAS 仲裁       | 已符合 | `retrySupervisorWake()`；`session.graph.retryWake`                                               |
| 所有读取面使用相同 Runtime 状态语义 | 已符合 | `src/agent-graph/runtime-activation-projection.ts`                                               |
| Graph 查询不创建 Workspace runtime  | 已符合 | `WorkspaceRuntimeRegistry.peek()`；`peekWorkspaceRun()`                                          |
| Graph/Runtime 不反向依赖 daemon     | 已符合 | Supervisor 已移入 Graph 域；严格架构门禁覆盖类型和值依赖                                         |

## 3. 失败与恢复语义

### 3.1 Reconciler 诊断

Reconciler 对 load、stop、provision、resolve-inputs、claim、begin-executing 和 project-record 阶段返回
类型化错误。应用层按 `transient`、`configuration`、`integrity` 分类并写入
`agent_graph_diagnostics`：

- 瞬时错误进入 `retry_scheduled`，使用有上限的持久指数退避；重启后继续同一 Graph/Claim 身份。
- 配置和完整性错误进入 `needs_attention`，不会忙循环。
- 后续调和成功时，未解决诊断转为 `resolved`，历史仍保留。
- 错误消息在持久化前安全裁剪，避免密钥和无限文本进入 UI/时间线。

Workbar 会显示未解决诊断的 phase、classification、subject 和安全消息；timeline 同时保留诊断创建
与恢复事实。

### 3.2 根 Wake 有限重试

普通根唤醒失败按确定性 Attempt 身份重试，最多自动尝试五次。达到上限后：

1. 当前 Attempt 终结并保留错误；
2. Wake 进入持久 `needs_attention`；
3. 重启扫描不会继续创建 RuntimeRun；
4. 用户可从 Workbar 发起 `session.graph.retryWake`；
5. Store 使用 wake version、attention version 和 operation ID 做事务内 CAS；
6. 新尝试使用下一组确定性 Turn/Run ID，既有 Attempt 历史不改写。

显式重试还受 Graph retirement fence 约束。Graph 已 finish 时，Desktop 先返回冲突，SQLite Store
也会在同一写事务中再次检查 `graph.phase`，避免 TOCTOU 把已退休 Wake 重新置为 `pending`。

### 3.3 Runtime 状态投影

`projectAgentGraphRuntimeActivation()` 是 canonical 只读投影，同时消费 ledger facts 与可选 host
launch state。优先级为：

1. durable terminal 永远优先于宿主状态；
2. `not_started` 不被宿主状态伪造成已启动；
3. 非终态 ledger 可被 host 的 failed/cancelled/interrupted 修正；
4. host succeeded 但没有 durable terminal 时 fail-closed 为 interrupted；
5. host unknown 且已经存在 provider/tool 派发事实时为 interrupted；
6. 只有精确 start/确定性输入的 Run 仍可视为 attachable/running。

Supervisor、Runtime adapter 和 Desktop query 不再维护互相漂移的状态判断。Workbar 也保留
`interrupted`，不会降格显示为普通 failed。

## 4. 读写与依赖边界

Desktop 的 list/get/timeline 仍是只读路径。`get` 查询 Runtime 状态时只调用 registry `peek`：

- 已存在的 Workspace runtime 可提供 live launch state；
- 不存在时返回 unknown；
- 查询不会构造 runtime、启动 Graph recovery 或创建 epoch。

只有显式 `retryWake` 是写操作，它会先验证 trusted workspace、Session、Graph 和 Wake 的归属，
随后才确保 Workspace Graph application 已启动。跨 Session、跨 Graph 或 finished Graph 请求均被拒绝。

Supervisor service 与端口契约现位于 `src/agent-graph/supervisor-service.ts`。daemon 只负责生产装配
和宿主状态映射。`scripts/check-architecture-boundaries.mjs` 将 `src/agent-graph/` 识别为独立 area，
并拒绝：

- Graph → daemon 的值依赖和类型依赖；
- Runtime → daemon 的值依赖和类型依赖。

daemon → Graph/Runtime 的合法组合方向仍可通过门禁。

## 5. SQLite v4 迁移与回滚边界

Graph scope v4 是从 v3 向前的增量迁移：

- 新建 `agent_graph_diagnostics` 与活动诊断索引；
- 为既有 supervisor wake 增加 attention 状态、版本、时间和 retry operation 字段；
- 不删除或重写 v1～v3 的 Graph、Claim、Wake、Attempt 与 RuntimeEvent 数据；
- 旧 Wake 默认 `attention_state = 'none'`，迁移后保持原语义。

workspace schema migration 在单事务中执行。旧二进制遇到 v4 scope 会明确 fail-closed，不会按旧结构
继续写入。若需要应用级回滚，必须同时使用兼容 v4 的代码，或恢复迁移前数据库备份；不能只降级
二进制后继续写同一份数据库。

## 6. 本轮已关闭的缺口

| 缺口 | 原问题                                       | 当前状态                                                      |
| ---- | -------------------------------------------- | ------------------------------------------------------------- |
| G1   | Reconciler 错误只存在于单次内存返回值        | 已增加持久诊断、分类、退避、恢复和 Workbar 展示               |
| G2   | 根 Wake 普通失败可无限创建 Attempt           | 已限制五次并进入 durable `needs_attention`，支持显式 CAS 重试 |
| G3   | 真实模型 E2E 使用了漂移的 Graph ID fixture   | 已从实际 epoch authority 获取 Graph ID，并增加身份断言        |
| G4   | Desktop 与 Supervisor 的崩溃后状态分类不一致 | 已共享 canonical 投影并引入非构造式 host launch lookup        |
| G5   | Graph/Runtime 反向依赖 daemon 且无门禁       | 已移动领域契约并加入 strict architecture gate                 |

独立复核额外发现并关闭了 finished Graph 显式重试越过 retirement fence 的竞态。回归测试断言拒绝后
Wake 仍为 `needs_attention`，Attempt 历史不变。

## 7. 当前验证证据

本轮在最终代码状态实际执行：

```text
npm run typecheck
npm run desktop:typecheck
npm run lint
npm run check:architecture:strict
Graph 相关集成套件：154 passed，0 failed，0 skipped
真实模型 E2E 文件：2 passed，1 skipped
git diff --check
```

154 条集成验证覆盖 exact identity、崩溃恢复、诊断跨重启、有限重试、显式重试、finished fence、
统一投影、Desktop 归属校验、Workbar 展示、非构造式 registry lookup 和架构门禁。

真实模型主闭环用例因当前环境未设置执行凭证而明确 skip；两个不依赖凭证的 E2E 诊断/身份用例
已通过。此处不把 skip 描述为闭环已实际运行。

## 8. 后续增强

以下为非阻断增强，不改变当前 Graph 的正确性判断：

1. 在受控 CI 或发布候选环境定期运行真实模型 root update → yield → Operator output → exact wake →
   view → finish 闭环。
2. 把 `session.graph.query` 的通用 JSON result 收窄为协议级结构化 schema，减少 Renderer 二次校验。
3. 为 configuration/integrity 诊断增加独立“重新调和”操作；操作需复用 Graph revision/diagnostic
   version fence，不能绕过 retirement 或 exact Run 副作用边界。
4. 增加真实生产 host 下“执行中 Operator + running root wake + Session 删除 + 重启”的全链路测试。

## 9. 最终判断

Graph 是现有 Runtime 之上的持久调度控制面，不是旁路 Runtime 的第二套执行系统。它现在具备清晰
的 authority 分工、精确执行身份、CAS/唯一约束、fail-closed 恢复、有限失败收敛、统一读模型、
可操作的人工恢复入口和可执行的依赖门禁。

因此，Graph 可以视为已经对齐当前架构并完成本轮收口。后续工作应聚焦发布门禁和操作体验，
不应重新合并 Graph 与 Runtime 两类账本，也不应把宿主活性状态提升为跨进程恢复权威。
