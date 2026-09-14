# Package 边界对齐（进行中）

## 接续检查点（2026-09-14，新会话从这里开始）

目标仍是完成 `@pico/core → @pico/storage → @pico/runtime → @pico/pico-host → entrypoints`
的渐进式边界迁移；当前目标未完成，不要缩小为只修编译。

最近已经完成并验证的迁移：

- MCP HTTP/SSE、stdio、Tool Bridge 和 Connection Manager 已迁入 Pico Host；旧 `src/mcp`
  入口仅注入 logger。MCP/网络门禁/沙箱/Registry 回归 47/47 通过。
- `CronWorkspaceRuntime` 已迁入 Pico Host；ownership/drain 回归 4/4 通过。
- Atomic Memory 的纯领域契约和 Store Port 已迁入 Core；SQLite schema 与
  `SqliteMemoryItemStore`、`ForkOperationCoordinator` 已迁入 Storage；旧入口保留兼容导出。
  Storage 迁移后 Memory 集成测试 69/69、Store/Fork 针对性测试 8/8 通过，覆盖事务回滚、
  receipt 幂等、CAS、删除 revision、恢复和跨会话隔离。
- 最近一次完整通过的公共门禁包括根 typecheck、各包 build、`check:architecture`（0 条逆依赖）
  和 `git diff --check`。

Atomic Memory 的 Runtime 层迁移已完成。以下实现位于
`packages/runtime/src/atomic-memory/`，原 `src/memory/atomic/` 路径保留兼容导出：

- `content-safety.ts`
- `context-builder.ts`
- `extraction-budget.ts`
- `extraction-evidence.ts`
- `extraction-proposal.ts`
- `extraction-engine.ts`
- `session-lane.ts`

`freezeSnapshot` 已以条件 spread 排除显式的 optional `undefined`，并复用非可选的冻结
checkpoints 局部值；生产调用点均已直连 `@pico/runtime/atomic-memory/*`。根 typecheck、各包构建和
Memory 集成测试 70/70 均已通过。

`StorageDoctor` 的跨层依赖也已拆分：它是同时编排 Runtime 投影、File History 与 Storage SQLite
只读检查的产品宿主服务，现位于 `@pico/pico-host/storage-doctor`；Storage 只通过公开接口提供
数据库、Journal 与 Blob Store，旧 `src/storage/storage-doctor.ts` 保留兼容导出。Pico Host 构建与
Storage Doctor 集成测试 4/4 已通过。

本轮最终完成度审计已通过：根 typecheck（含所有包构建）、`check:architecture`（0 条逆依赖）、
`git diff --check` 均通过；生产源码没有残留的旧 Atomic Memory 或 StorageDoctor 深路径导入。
Markdown 依赖图已按 manifest 校正；冻结的 architecture JSON/HTML/visual-check 仍保留其概念关联，
不得将其中 Protocol→Core 关联当作实际 package dependency。
阶段 2–5 仍标为进行中，因为 Engine、Context、Provider、Tools、Daemon 与 CLI/TUI 还有按真实消费者
逐步收敛的长程工作；本轮不将它们误标为完成。工作区包含大量本次迁移及用户既有未提交修改，
不得 stash、reset、clean、覆盖或提交不明改动；架构图 JSON/HTML/visual-check 产物保持冻结。

目标：让仓库顶层目录能直接表达 Pico 的产品模块，同时逐步建立类似 Maka 的
`core → storage → runtime → host → entrypoints` 依赖方向。此计划只调整代码组织和
构建边界；不改变 Runtime 事件、SQLite schema、IPC 契约或前台行为。

## 目标地图

```text
apps/desktop, apps/mobile
        ↓
packages/cli ───────────────→ packages/pico-host
    ├──────────→ core/storage       ├──→ packages/protocol
    └───────────────────────────────├──→ packages/runtime-host ──→ packages/runtime
                                    └──→ packages/runtime ──→ packages/storage ──→ packages/core
```

`packages/pico-host` 是 Pico 的 workspace/daemon 业务装配层；`packages/runtime-host`
继续只承载通用本机宿主、连接与传输机制（含 MCP wire protocol DTO、JSON-RPC、工具名规范化与
MCP tool bridge），
两者不得合并。

上图描述实际 workspace 依赖：CLI 直接依赖 Pico Host、Core 与 Storage；Pico Host 直接依赖
Protocol、Runtime Host、Runtime、Storage 与 Core；Runtime Host 依赖 Runtime/Core，Runtime 依赖
Storage/Core，Storage 依赖 Core。Protocol 不依赖 Core。

## 迁移阶段

- [x] 阶段 1：建立 `@pico/core`，迁出 Message、ToolCall、ToolResult、Usage、图片、
      ToolResult Envelope、持久 Session identity/selection、Provider interface/profile/error/identity、reasoning 与
      model capability 等稳定契约；
      Engine Runtime Port、Provider、Tool Registry、Runtime Contract、Event Store Contract 与关键
      Engine 消费方已改为直接消费新包。具体协议翻译、模型默认值和网络调用仍留在外层 Provider
      适配器。Reporter 生命周期事件端口也已归属 Core。保留旧路径的兼容 re-export，并在架构门禁中禁止
      Core 依赖实现层。
- [ ] 阶段 2：已将 Runtime Event 的通用信封、Run 准入/终止、Message、ToolResult、审批、
      模型调用、Checkpoint、Session fork 与 Graph output 事实收敛到 Core；Plan 契约/事件校验、
      可持久化 Session state schema/严格解码，以及 Tool Recovery mode/审计上限也已归属 Core。
      完整 RuntimeEvent union 已作为可由 Transcript 事实专用化的泛型契约归属 Core；durable Transcript/
      entry DTO 与 fail-closed 校验也已脱离展示实现。另将未完成 Tool Exchange 判断收敛到 Core。
      Compaction summary 的稳定 marker、checkpoint 内容摘要，以及 Transcript 工具开始事件的稳定
      identity/RuntimeEvent 构造也由 Core 统一定义。
      Resource Catalog 的规范化名称、优先级、冲突解析和展示投影也已迁入 Core；Plugin Hook trust
      以不透明泛型能力由外层提供，避免 Core 依赖 hooks 或 Host。
      Claude 资源工具名的固定兼容映射和 unknown 工具 fail-closed 判定也已归属 Core，
      具体告警仍由外层 catalog 适配器记录。
      Plan review/transition/run 的确定性身份已迁入 Core，避免生产 Host 与各产品壳各自拼接操作 ID。
      纯权限边界模型、工具权限分类/决策表以及后台 Autonomous policy snapshot 的严格解码
      现已迁入 Core；Workspace trust 的 host prompt/decision 契约、Provider 调用目的枚举和 Cron
      草案/审阅契约也已脱离实现而归属 Core。Provider credential v2 的非密钥身份、
      Endpoint 规范化、引用编解码和身份绑定校验也已归属 Core；明文 vault 仍仅在 Host。
      TaskRun 的事件、Attempt/lease/checkpoint 投影、恢复停放原因与安全边界，以及恢复 launch/run
      的确定性身份和 Receipt 严格校验也已归属 Core；持久化格式与既有 ID 算法保持不变。
      其余纯契约只在至少两个消费者实际直连后再迁出，届时才删除旧路径。
- [ ] 阶段 3：已建立 `@pico/storage`，迁出无副作用的 Event Log 保留策略、原子 JSON、OwnerLease、
      CAS mutation lease、File History Blob Store、遗留 Evidence Blob CAS/Archive、私有文件锁、全部 SQLite schema scope、connection lease、workspace binding/repair、Workbar、retention 与 Agent Graph Store，以及 Runtime Event codec、Store contract、
      Session catalog fold、工作区路径规范化、Todo SQLite Store、Workspace trust 用户级文件库、Storage Operation Journal 与完整 SQLite Runtime Event Store。Store 的歧义写入告警经可选
      diagnostics 端口由旧宿主入口注入；事务 owner、数据库 scope、schema、文件发布协议与旧入口均保持不变。Graph 的稳定 profile contract、
      Graph contracts、确定性 identity 与诊断/脱敏规则先收敛到 Core，随后 Store 以
      `@pico/storage/sqlite/agent-graph-control-store` 暴露；因此 Storage 不反向依赖 Graph 运行逻辑。
      Runtime control 的 Job/attempt/lease/Cron/outbox/usage 记录、Store 输入契约与完整
      `SqliteRuntimeControlStore` 也已归属 Storage；旧 `src/tasks/runtime-{types,store-contracts}.ts`
      和 `src/storage/sqlite/sqlite-runtime-control-store.ts` 仅保留兼容导出。TaskRun Store 契约、稳定输入
      哈希与完整 `SqliteTaskRunStore` 也已迁入 Storage，继续维持原有 transactionId 幂等、revision CAS、
      逐事件重放及 workspace root 校验；旧路径仅保留兼容导出。
- [ ] 阶段 4：已建立 `@pico/runtime`，迁出 Node 版本策略、Runtime cleanup scope 与
      Atomic Memory 生命周期、Session Message Ledger、Iteration Budget、Steer Queue 与运行投影诊断；
      进程内 TaskRegistry 的身份生成、生命周期、快照隔离、重启中断投影与权威视图幂等更新
      也已归属 Runtime；`task_list/task_output/task_stop` 的参数校验、任务域分流和结果投影
      通过窄后台任务 Port 接入，旧 `src/tasks/task-registry.ts` 与 `src/tools/task.ts` 仅保留兼容导出；
      Storage 控制 Store 之上的 JobService 及 TaskRegistry→Job/attempt/lease 的 RuntimeTaskMirror
      也已归属 Runtime；Runtime 只接收 Host-resolved `storageRoot`，旧入口负责路径兼容转换。
      RecoverableTask 的适配器注册、不可变输入校验与恢复调用契约，以及 Storage 控制 Store 上的
      CronService 也已归属 Runtime；CronService 同样只接收 Host-resolved `storageRoot`。TaskRun 的
      SafeBoundaryResume planner/coordinator、lease/CAS 仲裁、运行边界复核和幂等 launch settlement
      也已整体迁入 Runtime，只通过 Core/Storage 契约访问下层。
      Token 估算器、Provider 的流式呈现装饰器、错误脱敏器和 Context evidence 投影也已迁入。
      Provider 失败分类、请求预检、模型 profile/capability、reasoning 与原生搜索策略亦已迁入；
      Graph SQLite adapter、Runtime Port、supervisor、reconciler、activation projection、profile catalog、
      work request、adapter bridge、应用服务与只读查询均已迁入。Graph 对 Runtime ledger 的读取以解码
      Event Query Port 注入，Runtime 不反向依赖宿主 SQLite event schema 或 feature decoder。
      会话状态/用量、模型历史、Transcript、fork、ToolResult 的纯投影，checkpoint 的 fail-closed
      读取模型，以及按 kind 切片读取的 RuntimeProjectionService 已迁入；Context 的 token 预算与安全
      压缩切点、完整 Compactor（tool-pair 完整性、MicroCompaction、token/字符闭环与 fail-closed budget
      error）、Provider-backed FullCompactor（滚动摘要、安全切点、失败降级）及 durable checkpoint 记录编排、
      子代理 token-aware context compression/fail-closed evidence reset 策略也已迁入；FullCompactor/checkpoint
      仅依赖最小 Session/Run/Hook/logger Port，旧 Engine/Context 入口只注入结构化日志并兼容导出。通用 deadline、Goal 状态机与独立模型 Goal 评估策略、提醒/Guardrail、
      错误恢复策略、Plan handoff 与 ToolResult 的入口投影/构造器也已迁入。旧 Engine/Context/
      util 路径只保留兼容导出；无副作用的 Silent Reporter、Runtime capability owner、不可伪造 capability
      签发/owner fence 校验、泛型执行 Port、泛型 durable fork lifecycle Port 契约与 SessionManager 进程级
      drain/owner 围栏由 Runtime 提供。Engine 仅把这些 Port 绑定到具体 Session/Tool Registry/文件事务 hooks。
      RuntimeRun 对具体 Engine Session 的依赖已收窄为 RuntimeProjectionSession Port，只保留序列化、
      owner-fence、模型/usage 投影与 Transcript start 提交能力；3300 行主账本协调器已整体迁入 Runtime。
      它以 presentation-independent durable Transcript inspector 复核 sequence、stream、tool、subagent
      与 truncate 关系，并通过可配置 diagnostics 端口保留旧入口的结构化告警。
      工具资源访问冲突图、并发调度器、资源授权器、工具 Surface（分组、宿主亲和性、Plan 工具面）与
      AsyncLocalStorage 隔离的 Turn 工具披露/激活策略，以及 `request_sandbox_boundary` 的严格输入/
      结算校验与 direct-only 工具投影，
      RuntimeRun 所需的窄工具执行 Port、recovery policy/probe、执行 step/context 及 T1/T2
      `ToolCommitBoundaryError` 也已归属 Runtime；完整 Registry 的 BaseTool、注册、中间件、Hook、
      文件副作用契约及 AJV 校验/资源准入实现已迁入 Pico Host，Runtime 继续只暴露耐久执行所需的
      窄 Port。旧 `src/tools/registry.ts` 仅兼容导出；`registry-impl.ts` 只注入旧 logger 并聚合具体工具，
      Engine、MCP 和配置消费者均直连 Host 契约或实现。
      单轮 `RuntimeRunExecutor` 已迁入 Pico Host：它通过窄 Session、Prompt Hook、模型执行与 diagnostics
      Port 连接 RuntimeRun，不再直接依赖具体 Engine、SessionRuntime、旧 Hook 类型或源码目录；旧
      `src/runtime` 入口只负责注入这些具体实现，并继续保持图片加载与结构化日志行为。
      Agent Host 的最大轮次准入边界，以及 Plan 批准、恢复和耐久修订反馈的模型提示构造已从
      `agent-runtime.ts` 拆入 Runtime；Headless 入口直接读取统一边界，Host composition 不再拥有这些纯策略。
      SessionRuntime 的 async Hook rewake 队列与 idle/coalescing coordinator 已迁入 Runtime，并以失败
      保留、容量封口和防重入测试固定语义。Engine→RuntimeRun 的通用生命周期 adapter，以及 fork 的
      历史校验、repair、bootstrap identity、SQLite authority/owner-fence 生命周期也已归属 Runtime；旧
      Engine/fork adapter 只绑定具体 Session/Registry，并注入物理 SessionForkService 事务与失败 settlement。
      SessionRuntime 的资源 owner 已迁入 Pico Host：任务/子代理/worktree Hook 投影、SessionStart/End
      顺序、Code Intelligence 切换串行化、后台任务终止、组件 Hook 逆序释放、沙箱原子 detach 和最终
      Goal/Session pin 释放均由 Host lifecycle 统一持有。旧 `session-runtime.ts` 只创建具体资源并把
      Hook、LSP 与 Sandbox 操作适配到窄端口。
      Session hydration 的一致性 DTO 与 Durable Transcript 事实类型现已统一归属 Core；Engine、Fork
      和 Storage 兼容契约不再从 presentation 实现反向取得耐久类型，旧 `engine/session-runtime.ts`
      已缩为状态与 hydration 两个 Core 子路径的兼容导出。
      本地 FileIndex（git/rg/目录扫描降级、忽略规则、TTL cache）也已迁入 Pico Host；旧 input 入口
      仅兼容导出，SessionRuntime 与 TUI entrypoint 直接依赖 Host 包。
      Workspace Todo Store 的 Pico 路径解析适配，以及受管子进程的环境净化、策略编译、原生后端探测/
      摘要校验和 lease 生命周期也已迁入 Pico Host；所有生产消费者直连包入口，旧 `src/context` 与
      `src/safety/process-sandbox` 深入口均保留同一实例/类型身份的兼容导出。
      WorkspaceRoots 的真实路径解析、一次性授权、完整权限 Profile 与 direct-file 边界投影，以及
      Code Intelligence 的 LSP discovery/stdio lifecycle、只读服务和 Repo Map fallback 也已归属 Pico Host；
      ToolRegistry 专属 middleware 留在旧薄适配层，LSP 日志通过显式 Host 端口注入。
      Read/Write/Edit 文件工具、共享路径辅助、原子工作区发布与 Windows 安全发布实现也已迁入 Pico Host；
      生产 Registry、子代理与审批 diff 直连包入口，旧路径只保留同一实现身份的兼容导出。Linux xattr
      helper 的候选路径覆盖安装包和 monorepo 两种布局，文件权限、ACL/xattr 与并发前置条件保持不变。
      `fetch_url`/`web_search` 的本机网络执行也已迁入 Pico Host，保留 DNS 固定、私网/元数据地址拒绝、
      逐跳授权、字节上限和搜索 API 兼容；Runtime 继续只持有原生搜索能力与工具面收缩策略。
      `ask_user` 的请求 identity、pending/abort/cancel 状态机和 Registry 适配也已迁入 Pico Host；
      Daemon/TUI 直接依赖 Host 契约，旧工具入口只保留同一实现身份的兼容导出。
      Browser Agent 的固定导航/点击/输入工具、参数上限和 Session 级资源声明也已迁入 Pico Host；
      生产 AgentRuntime 直连新包，旧工具入口仅兼容导出。
      Runtime 搜索策略到具体 Registry/Web 工具的桥接，以及配置型子代理输出的 workspace Store
      打开、Pico 路径解析与 SQLite diagnostics 装配也已迁入 Pico Host；父子授权、耐久记录查询和
      有界结果投影仍归 Runtime，旧宿主入口继续注入原 logger。
      配置型子代理输出、`schedule_task` 与 `request_sandbox_boundary` 的 Runtime→Registry 具体适配
      同样归属 Pico Host，旧工具路径仅兼容导出。
      Code Intelligence 的 definition/reference/symbol/diagnostic/call-hierarchy/Repo Map 工具适配也已
      迁入 Pico Host，与底层 LSP/Repo Map 服务保持同层；旧工具入口仅兼容导出。
      跨工具的文件扫描观察上下文已迁入 Runtime，`glob`/`grep` 的真实目录遍历、ripgrep 启动与
      Node 降级迁入 Pico Host；Grep 以显式 diagnostics 端口保留旧 logger 行为。
      Workspace Sandbox 的 Hardline/路径/网络预检和完整 Bash 工具也已迁入 Pico Host；Bash 超时及
      SIGTERM→SIGKILL 宽限复用 Runtime 的可取消、unref deadline 原语，不再在 Host 手写超时组合。
      File History 的写前文件 journal、snapshot/CAS 编排、diff、durable rewind/fork sidecar 与恢复状态机
      已整体迁入 Pico Host；manifest SQLite 行事务迁入 Storage，所有生产消费者直连包入口，旧三个
      `src/safety|storage` 文件均只剩两行兼容导出。
      Hook 的事件/信任契约、dispatch 编排、配置解析与 generation-safe watcher、命令 Shell、可信指纹库、
      本地 enablement、无头管理服务、Hookify 规则文件和五类 handler executor 也已迁入 Pico Host；
      executor 通过 Runtime process-tree/deadline、Runtime Host MCP DTO 与可注入 diagnostics 保持单向依赖。
      Session Hook composition 通过泛型 command factory 接收入口命令，不反向依赖 CLI；SlashCommand 的
      稳定契约及 `/hooks`、`/hookify` 适配已迁入 `@pico/cli`，旧 `src/input/types.ts` 仅兼容导出，
      旧 Hook 树只剩 55 行兼容/注入代码。
      `schedule_task` 的草案输入/结果投影、Goal 的创建/查询/更新工具、Plan 的提交/步骤更新/
      取消工具，以及 Graph Operator 与配置型子代理两类 `agent_output` 的输入、身份和结果投影也已
      归属 Runtime；前台审阅、Plan/Graph 事实提交和子 workspace 的打开仍由注入端口完成。
      `load_tools`/`search_tools` 的渐进披露、Todo 的动作校验与文本投影、会话任务的 CAS/
      幂等工具和有界 prompt 投影、Swarm 状态的严格输入/隐私裁剪，以及编辑候选定位和模型文本
      行尾编解码，以及配置型子代理的预设选择、续跑约束与结果封装也已归属 Runtime；具体 Registry
      注册、SQLite 账本、Graph 查询、子会话执行和物理文件 I/O 仍保留在外层 Storage/Host 适配。
      Bash 参数路径解析、跨平台 Shell 选择/环境净化、进程树终止、Bash/PowerShell 的保守审批与 hardline 策略、敏感凭据/控制面路径判定、结构化会话授权 scope 的构造/匹配与进程内 grant state、Sandbox Boundary 真实路径规范化，以及 Automation 工具白名单也已归属 Runtime；
      人类审批交互、Pico workspace session key 的注入、目录登记/会话设置写回和 OS sandbox 仍由外层 Host/Engine 适配。
      Provider 调用的异步归属上下文、公开运行请求/结果契约与不含密钥的 Provider 计费路由映射已迁入 Runtime；Runtime 包显式持有 `gpt-tokenizer` 与 Storage 依赖，根 `build:runtime` 会先构建 Core。
      Provider Usage 的通用成本计算也已迁入；模型价格 catalog 仍作为外层数据源以 resolver 注入，
      不让 Runtime 绑定可更新的价格快照。周期任务意图提示、自动子进程的最小环境与 Git hooks/
      credential/filter/自动维护禁用策略也已迁入 Runtime。Usage baseline 差额导入、Provider 限流
      响应解析、凭据池、带 abort/退避/429 轮换的重试内核及轮换协调器也已迁入；外层只注入日志或
      网络配置。Provider 网络配置契约也已归属 Runtime；旧 `src/provider/config.ts` 仅保留类型兼容
      出口。AgentRuntime 与 AgentEngine 已把 Core/Storage/Runtime/Host 中已有正式实现的纯转发依赖改为
      包入口，Provider retry 与 Runtime checkpoint 的结构化日志改为显式注入，避免依赖旧隐式适配层。
      Provider Endpoint 的安全规范化与 Prompt Cache 身份/工具快照，以及请求的无明文指纹、缓存断点
      与变更诊断也已归属 Runtime，Tracker、Provider、Engine 与缓存效果统计直接使用该包，其中调用
      记录以最小只读 Port 接入，旧 observability/provider 路径仅保留兼容导出。
      Web Search 的能力判断、网络守卫与工具面收缩也已迁入 Runtime；ToolRegistry 注册和外部搜索
      实现保留在外层适配器。Plan 事件条目的确定性 reducer、活动计划投影与不变量校验也已迁入
      Runtime，只消费 Core 的计划事实与 Storage 的事件条目契约；Plan Coordinator 的 CAS、幂等
      重放、Graph 完成校验与执行恢复编排也已归属 Runtime，Engine 活跃 Run 状态以 liveness Port
      注入。配置型子代理的隐藏准入事实解析、会话归属读取与续跑前的耐久一致性校验也已归属
      Runtime；`agent_output` 的授权查询与有界历史投影同样在 Runtime，当前父 Run 与子 workspace
      Store 打开动作以最小 Port 留在外层适配器。Graph Operator 的 `agent.output` canonical ledger、
      幂等重放仲裁和 RuntimeEvent 写入也已收敛到 Runtime；Host 只注入当前 Session 的 owner-fence
      断言。Exact Run 的耐久分类、预分配身份校验、确定性输入 identity 和 root wake 状态机，以及
      Output Resource 的 Evidence/Artifact 校验保留也已归属 Runtime。继续将 Engine、
      Context、Provider、Tools 和运行策略收敛到该包，仅通过 Core/Storage Port 访问下层。
- [ ] 阶段 5：已建立 `@pico/pico-host` 与 `@pico/cli`，分别迁出 Host 协议工具、Host-owned
      Pico 路径模型、Skill Catalog（Pico/Claude/Plugin 来源扫描、优先级/修订与 `skill_view`）、
      原生 Agent Profile YAML 加载/限额/白名单与 fail-closed tombstone（Hook 信任作为不透明泛型能力）、
      Claude Agent Markdown/frontmatter 的用户级与项目级扫描、文件限额、冲突优先级和摘要投影，
      Agent Catalog 对 Pico/Claude/内建/Plugin 来源的整条覆盖、同级冲突、tombstone
      与展示摘要投影（旧 `src/agents/catalog.ts` 仅注入日志和 Hook 信任类型）、
      后台进程任务的生命周期、输出环形缓冲、SIGTERM→SIGKILL 升级和完成记录裁剪，
      具体 Shell/Sandbox 启动和进程树信号装配也已迁入 Pico Host，并直接复用 Runtime 策略；旧入口仅兼容导出，
      TUI 可写任务的 Worktree Supervisor、fail-closed 串行 Merge Queue 与 TaskHostRuntime
      整体装配（含 admission/shutdown ownership fence、持久 Job 镜像和 Git 安全环境），
      旧 `src/tasks/{worktree-supervisor,merge-queue,task-runtime}.ts` 仅保留兼容出口/日志注入，
      WorkspaceTaskRuntime 与 CronRuntimeScheduler 也已归属 Pico Host，工作区 Run 状态机、暂停/恢复/
      取消、close drain 与 Cron lease heartbeat 均保持原行为；生产主链路已直接消费包入口，
      Agent recoverable worker 的耐久 intent、文件锁争用、SQLite RuntimeEvent 准入和安装 Receipt
      仲裁也已迁入 Pico Host，并复用 Runtime 的统一 deadline 原语；
      Prompt Composer（AGENTS.md、Plan/Graph/Headless 策略与 Skill/Todo/Goal 组合）、审批前工作区 diff
      预览与人类审批等待/通知状态机、Workspace Runtime registry、用户级 workspace 登记、临时 workspace 授权、Storage Repair 确认流程、Runtime Host 操作注册表与 Session continuity bridge/registry、Workbar 终端状态/服务、interaction/conversation 状态 store、受限 Git review authority、
      Graph workspace host 的完整装配、Operator 执行边界继承策略、Exact Run 的账本准入/附着/停止仲裁、root epoch 退役、受管 Git worktree 的创建/恢复/安全清理、只读 Resource Doctor、Desktop 请求路由及 session/memory/provider/workbar/automation handler、Desktop Reporter、
      使用量 dashboard/价格投影和 CLI Session 参数解析/SQLite catalog resolver。执行边界通过 Session Port 注入，Engine 类型只留在旧入口
      适配器；使用量读模型通过 Runtime Event reader Port 注入，Host 不反向依赖 SQLite 实现；后台 MCP
      配置 schema、用户级原子配置库/幂等锁、workspace 真实路径校验与 SHA-256 指纹/复核、受信任
      用户/项目/Plugin 来源优先级解析也已归属 Pico Host；Runtime Host 的 MCP tool bridge（输入
      契约不变性、结果投影、全局资源互斥）及其 wire protocol、events
      bridge、96KB 帧裁剪策略和 Side Chat 的 SQLite 可恢复租约授权也已归属 Pico Host；HTTP/SSE 与
      stdio 客户端、连接/重连/关闭状态机和 ToolRegistry 绑定也已迁入 Pico Host，日志、网络准入与
      进程沙箱均显式注入，旧 `src/mcp` 仅保留兼容适配。Plan 审核
      Port、daemon 中断 Run 生命周期事实及其 Agent Graph 启动状态投影同样位于 Host，后者按既定
      方向直接依赖 Runtime 的只读类型。会话活跃输出 overlay 的低延迟发布、持久化、截断和恢复
      降级，以及 Runtime Host 控制面、事件和会话桥接的 composition factory 也已迁入。继续将
      Local Runtime service、事件游标、shutdown ownership fence，以及 Desktop/CLI/TUI 共用的 Local Runtime Client
      都作为 Host 共享生命周期端口收敛；
      Runtime Host candidate 的选主、可逆 residency、drain、bridge 与关停栅栏也已迁入 Host，
      Production service、SQLite continuity source 与全局 Session ownership 则通过装配端口注入；
      Browser Agent 的面板命令 broker、租约/代际吊销和固定 JSON 操作中转也已迁入。Subagent
      可用性 catalog、预设 Settings 的 HMAC revision/冲突处理与不含凭据/端点的连接目录投影已迁入 Host，
      而预设 wire schema/规范化已迁入 Protocol。继续将
      `LocalDaemonHost` 与其泛型 Cron 生命周期端口迁入 Host；具体 scheduler/SQLite 实现仍经端口
      注入，保持 Host 不反向依赖实现。Desktop checkpoint/review 的投影、SHA-256 指纹与 Rewind
      fail-closed 前置条件也已迁入 Host；Workspace trust 的默认 `PICO_HOME`、风险清单与 fail-closed
      流程也由 Host 组装；File History 的 checkpoint 摘要、CLI rewind/fork 命令服务
      也已通过最小 Session Port 迁入 Host，Engine fork authority 保持不透明。不含凭据和端点的
      有效模型配置诊断投影及 Workspace Doctor 的只读编排也已迁入 Host；后者通过只读 Port
      消费 Storage 深检，原入口保留自动装配以维持兼容。每工作区 Cron 的关闭、drain deadline 与
      ownership fence 生命周期也已迁入 Host，具体 scheduler/store 仍通过 Port 注入；CronWorkspaceRuntime
      的产品装配也已迁入 Host，旧 daemon 路径仅兼容导出，production host 直连包入口。Desktop Rewind 的
      durable claim、幂等回放、file/fork 事务与完成通知也已迁入 Host；Engine Session fork、文件变化读取与
      日志均通过最小 Port 注入，旧 daemon 构造入口保持兼容。Desktop Runtime notification 到 durable
      Transcript 的筛选、去重与 append 编排也已迁入 Host；Session ledger 与完整投影 reducer 校验通过 Port
      注入，旧 daemon 入口继续保留两参兼容调用。后续继续将
      `src/daemon` 的外层装配迁到 Host 包、将 CLI/TUI 收敛到 CLI 包；CLI Terminal Reporter、命令可用性判定、
      快捷键 schema、Rewind 纯文本投影与 Workspace trust 的 readline 提示适配已迁入，旧 `src/input`/
      `src/cli` 路径保留兼容导出。UI 与 Eval
      只有产生第二个真实消费者时才抽包。

## 验收与约束

- 每阶段保留旧 import 路径的 re-export，避免一次性全仓改写。
- 每阶段运行该包 build、根 typecheck、`check:architecture` 和一条受影响的集成测试。
- 不移动用户现有未提交的 Desktop/Runtime Host 变更；不创建破坏性迁移或改写历史。
