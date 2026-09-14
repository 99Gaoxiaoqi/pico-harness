# pico-harness 架构总览

> 文档类型：当前架构导航。系统边界与状态真源以仓库根目录
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md) 和已跟踪代码为准；本页不重复保存易漂移的
> 协议字段、表结构或验证数字。

## 当前执行路径

TUI 和 Desktop 是两个产品外壳，但不是两套 Runtime：

```text
CLI / TUI ── LocalRuntimeClient ───────────────┐
                                               ▼
Desktop Renderer ── Preload ── Electron Main ── current-user local daemon
                                               │
                                               ▼
                                  WorkspaceRuntimeService
                                               │
                                               ▼
                                  AgentRuntime / AgentEngine
                                    ├─ Provider / ModelRouter
                                    ├─ Context / Compaction
                                    ├─ ToolRegistry / Safety
                                    ├─ Hooks / MCP / Subagent
                                    ├─ workspace pico.sqlite
                                    └─ PICO_HOME/memory.sqlite
```

- `pico` 和 `npm run dev` 启动的是 daemon 瘦客户端；TUI 进程不装配执行内核。
- Desktop Renderer 不访问 Node.js、Runtime registration 或本地文件，通过白名单 Preload API
  与 Electron Main 通信。
- `packages/protocol/` 定义本机 Runtime 方法、参数、结果、事件和 Desktop allowlist。
- daemon 依靠私有 endpoint、当前用户权限、root authority 和协议白名单建立本机边界，
  不是公开网络服务。

## 包级模块地图

顶层目录按下面的方向组织；`src/` 中尚未迁出的同名目录是过渡兼容区，旧导入路径会保留到
对应模块至少有两个稳定消费者后才移除。

```text
apps/desktop, apps/mobile
        ↓
packages/cli ───────────────→ packages/pico-host
    ├──────────→ core/storage       ├──→ packages/protocol
    └───────────────────────────────├──→ packages/runtime-host ──→ packages/runtime
                                    └──→ packages/runtime ──→ packages/storage ──→ packages/core
```

CLI 也直接依赖 Core/Storage；Pico Host 直接依赖 Protocol、Runtime Host、Runtime、Storage 与
Core；Runtime Host 依赖 Runtime/Core，Runtime 依赖 Storage/Core，Storage 依赖 Core。Protocol
没有对 Core 的 package dependency。可交互版本见[冻结的包边界视觉审查输出](./pico-package-boundaries.html)；
实际依赖以各 package manifest 与 `check:architecture` 为准。

| 模块                                                 | 职责                                                                                                                                                                                                                                                   | 当前物理范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/`                                     | 与具体 Provider、数据库、宿主无关的领域契约：Message、ToolCall、ToolResult、Usage、Session identity/state/selection、Plan、RuntimeEvent、durable Transcript、Provider interface/profile/error/identity、Reporter，以及 reasoning/model capability 类型 | 已迁移首批契约、模型交互的稳定类型、Session 工作区身份与入口无关的 selection、非秘密 CredentialRef、可持久化状态 schema/严格解码、Plan 契约/事件校验及 review/transition/run 的确定性身份、完整 RuntimeEvent 泛型联合、durable Transcript/entry DTO 与严格校验、工具恢复审计契约、checkpoint 内容摘要、Transcript 工具开始事件的稳定身份与 RuntimeEvent 构造、Reporter 事件端口、Workspace trust 的 host prompt/decision 契约、纯权限边界模型、工具权限分类/决策表、后台 Autonomous policy snapshot 的严格解码、Resource Catalog 的名称/优先级/冲突/展示投影、Claude Tool compatibility 映射，以及 Agent Graph 的契约、确定性身份、诊断/脱敏、调度、就绪、Profile/Output/Resource Port 与 Control Store Port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/storage/`                                  | 存储基础设施、Store contract 与 SQLite 实现                                                                                                                                                                                                            | 已迁移 Event Log 保留/hard-cut、原子 JSON、OwnerLease、CAS mutation lease、File History Blob Store 与 manifest SQLite 行事务、遗留 Evidence Blob CAS/Archive、私有文件锁、全部 SQLite schema scope、connection lease、workspace binding/repair、Todo SQLite Store、Workspace trust 用户级文件库、Workbar、retention 与 Agent Graph Store，以及 Runtime Event codec、Store contract、Session catalog fold、工作区路径规范化和完整 SQLite Runtime Event Store；其余 `src/storage/` 继续分批收敛                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/runtime/`                                  | 执行内核、生命周期与运行策略                                                                                                                                                                                                                           | 已迁移 Node 版本策略、cleanup scope、完整 Atomic Memory 的内容安全、上下文构造、预算、evidence/proposal、提取引擎与 session lane、Ledger、Budget、Steer Queue、Token 估算器、完整 Compactor（tool-pair 完整性、MicroCompaction、token/字符闭环与 fail-closed budget error）和 Provider-backed `FullCompactor`（滚动摘要、安全切点、异常降级），以及 durable checkpoint 的泛型记录编排；后两者通过最小 Session/Run/Hook/logger Port 与宿主解耦。Context token 预算与安全压缩切点、子代理私有上下文压缩、token-aware context compression/fail-closed evidence reset 策略、统一 deadline、Goal 状态机/评估策略、Plan handoff、Runtime capability owner、不可伪造 capability 签发/owner fence 校验、泛型执行 Port 和泛型 durable fork lifecycle Port 契约、提醒与 Guardrail、错误恢复策略、ToolResult 入口投影/构造器、静默 Reporter、Provider 装饰器及投影诊断，以及模型 profile/capability/reasoning/search 策略；公开运行请求/结果契约和不含密钥的 Provider 计费路由映射也已迁入；工具资源访问冲突图、并发调度器、资源授权器、渐进披露（`load_tools`/`search_tools`）、Todo/会话任务的参数和有界结果投影、配置型子代理的选择/续跑校验、Swarm 状态的隐私裁剪、编辑候选定位和模型文本行尾编解码、跨平台 Shell 选择/环境净化、进程树终止、Bash/PowerShell 保守审批与 hardline 策略、审批危险命令纵深拒绝策略、敏感凭据/控制面路径判定、结构化会话授权 scope 的构造/匹配和进程内 grant state、Sandbox Boundary 真实路径规范化、Automation 工具白名单也已迁入；Session 的状态/用量/模型历史/Transcript/fork/ToolResult 纯投影、checkpoint 读取模型与统一 RuntimeProjectionService 也已迁入；Graph 的 Store adapter、Runtime Port、supervisor、reconciler、activation projection、profile catalog、work request、adapter bridge、应用服务、只读查询、资源保留、Exact Run 耐久分类、root wake 状态机与 `agent.output` 账本均已迁入；`src/runtime/`、`src/engine/` 等继续分批收敛 |
| `packages/runtime-host/`                             | 通用本机进程、连接和传输机制，不含 Pico 业务语义                                                                                                                                                                                                       | 已迁入 MCP wire protocol（JSON-RPC、资源/Prompt/Tool DTO、协商版本、工具名规范化）；连接客户端与 ToolRegistry/Sandbox 绑定仍是外层适配                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/pico-host/`                                | Pico workspace/daemon 的业务装配、RPC handler 和生命周期                                                                                                                                                                                               | 已迁移 Host 协议工具、Pico 路径模型与 Session scope、Skill Catalog（Pico/Claude/Plugin 来源扫描、优先级/修订与 `skill_view`）、原生 Agent Profile YAML 加载/限额/白名单及 fail-closed tombstone，以及 Prompt Composer（AGENTS.md、Plan/Graph/Headless 策略、Skill/Todo/Goal 组合）、MCP 配置面（schema、用户级原子库/锁、项目真实路径校验、受信任来源覆盖与插件优先级）、审批前工作区 diff 预览及人类审批等待/通知状态机、Workbar 终端状态/服务、Desktop interaction/conversation state、请求路由及 session/memory/provider/workbar/automation handler、Desktop Reporter、SQLite Session Continuity 读取投影、Desktop Atomic Memory 管理服务、Desktop Automation/Cron 产品服务、使用量读模型/价格投影、受限 Git review authority、后台 MCP 配置的路径校验与指纹复核、Workspace trust 的默认路径/风险/fail-closed 流程、Desktop checkpoint/review 的投影/指纹/fail-closed 规则、File History checkpoint 摘要与 CLI rewind/fork 命令服务，以及跨 Runtime 投影、File History 与 Storage SQLite 的只读 `StorageDoctor`；Graph workspace host 的完整装配、Operator 执行边界继承策略、Exact Run 的账本准入/附着/停止仲裁、root epoch 退役和受管 Git worktree 的创建、恢复与安全清理；`src/daemon/` 继续分批收敛                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/cli/`                                      | 命令行/TUI 的 argv 与交互适配                                                                                                                                                                                                                          | 已迁移 Session 参数语法、启动分派、资源命令分派、终端 Reporter、终端网格的 CPR/resize/鼠标适配、命令可用性判定、快捷键 schema、Rewind 纯文本投影与 Workspace trust 的 readline 提示适配；`src/input/`、`src/cli/` 旧入口仅兼容导出，`src/tui/` 继续分批收敛                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/protocol/`、`packages/transcript-replica/` | 本机 IPC 协议与 Transcript 本地副本                                                                                                                                                                                                                    | 已有独立包；Subagent 预设的 wire schema/规范化已收敛到 Protocol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/desktop/`                                      | Electron Main、Preload、Renderer 与平台集成                                                                                                                                                                                                            | 产品入口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Agent 资源侧，原生 YAML Profile 与 Claude Markdown/frontmatter 的用户级、项目级扫描，以及
Pico/Claude/内建/Plugin 来源的 Catalog 优先级合并、tombstone 与摘要投影均已归属
`packages/pico-host/`；旧 `src/tools/agent-profile.ts`、`src/input/agent-loader.ts` 和
`src/agents/catalog.ts` 仅保留日志/信任类型适配或兼容导出。

近期的细粒度边界调整：`StorageOperationJournal` 已在 `packages/storage/`，其新构造器
显式接收 `storageRoot`；`src/storage/operation-journal.ts` 仅保留从 workDir/picoHome 转换的
兼容适配。Workspace Blob GC 也在 Storage，宿主仅负责把 Pico 路径投影为所需的目录集合。
Bash 参数路径解析与 Bash/PowerShell 的保守审批、hardline 策略、敏感路径判定，以及会话授权的
scope 构造/匹配和进程内 grant state 位于 `packages/runtime/`；Pico Host 只向该 state 注入
workspace session key，外层负责目录登记、会话设置写回与人类审批交互。Pico Host 另拥有 workspace runtime registry、用户登记、
临时 workspace 授权、Storage Repair 确认流程、Runtime Host 操作注册表及 Session continuity
registry/bridge、Runtime Host 事件桥接与共享的通知帧裁剪策略，以及 Side Chat 的可恢复租约授权。
它还拥有 Plan 审核 Port、daemon 中断 Run 生命周期事实及其到 Agent Graph 启动状态的投影。
会话活跃输出 overlay 的低延迟发布、持久化、截断和恢复降级也归属于该 Host 适配层。
Runtime Host 控制面、事件与会话桥接的 composition factory 也由该包统一装配。
Local Runtime service、事件游标、shutdown ownership fence 与 Desktop/CLI/TUI 共用的 Local Runtime Client
则作为 Host 的共享生命周期端口；客户端默认解析 daemon 入口，产品壳也可按打包环境显式注入入口。
Runtime Host candidate 的 root 选主、可逆 residency、drain、bridge 和关停栅栏同样归属 Host；
Production service、SQLite continuity source 和全局 Session ownership 通过外层装配端口提供。
Browser Agent 的可见面板命令 broker、租约、代际吊销和固定 JSON 操作中转也位于 Host。
Subagent 的可用性 catalog、Settings 的 HMAC revision/冲突处理与不含凭据/端点的连接目录投影
是 Host 对用户预设和配置端口的适配；预设规范化本身属于 Protocol。
工具 Surface 的分组、background/headless 亲和性、Plan 工具面，以及按 AsyncLocalStorage 隔离的
Turn 工具披露/激活状态及 `load_tools`/`search_tools` 的校验、激活和结果投影位于 Runtime；Registry 的具体注册
以及读取当前工具集的窄端口仍在外层。
RuntimeRun 只通过 RuntimeToolRegistry 的捕获执行步、恢复策略查询和执行三个能力调度工具；
ToolExecutionContext、恢复 probe/policy 与 T1/T2 提交错误由 Runtime 统一定义。具体 Engine Session
也通过 RuntimeProjectionSession 暴露序列化、owner fence 和可替换投影，不再成为账本协调器的完整依赖。
完整 Registry 的注册、中间件、Hook、权限类别、文件副作用契约与 AJV 校验/资源准入实现属于
Pico Host；Runtime 只持有上述耐久执行所需的窄端口。旧 `src/tools/registry.ts` 仅兼容导出，
`src/tools/registry-impl.ts` 仅注入旧 logger 并聚合尚未迁出的具体工具。Read/Write/Edit 文件工具、
共享路径辅助、跨平台原子发布与 Windows 安全发布实现也已归属 Pico Host；旧 `src/tools` 入口保持
同一类与函数身份的兼容导出。Linux xattr helper 同时按安装包与 monorepo 布局解析，避免包迁移改变
Terminal-Bench 的原生辅助程序查找语义。`fetch_url`/`web_search` 的 DNS 固定、防 SSRF、重定向复核、
响应上限与搜索适配也已迁入 Pico Host；Runtime 仍只负责搜索能力与工具面策略。
后台任务的 Shell/Sandbox/进程树具体装配也已进入 Pico Host，并直接复用 Runtime 的跨平台 Shell 与
进程终止策略；旧 `src/tools/background-manager.ts` 只保留同一类身份的兼容导出。
`ask_user` 的请求身份、待决状态、取消/中止结算和 Registry 工具适配也归属 Pico Host；Daemon 与
TUI 直接消费该 Host 契约，旧工具入口仅兼容导出。
Browser Agent 的固定命令工具集、输入边界与按 Session 资源串行声明也已迁入 Pico Host；浏览器
命令 broker 和协议仍保持既有 Host/Protocol 分工。
Runtime 搜索策略到具体 Registry/Web 工具的桥接，以及配置型子代理输出的 workspace Store 打开、
路径授权与 SQLite diagnostics 装配也已迁入 Pico Host；授权查询与有界结果投影继续属于 Runtime。
配置型子代理输出、`schedule_task` 与 `request_sandbox_boundary` 的 Runtime→Registry 具体工具适配
也归属 Pico Host，Runtime 保持参数、策略与结果投影所有权。
Code Intelligence 的 definition/reference/symbol/diagnostic/call-hierarchy/Repo Map 工具适配也已与
底层 LSP/Repo Map Host 服务一起归属 Pico Host。
跨工具的文件扫描观察上下文归属 Runtime，`glob`/`grep` 的真实目录遍历、ripgrep 启动与 Node
降级归属 Pico Host；Grep 通过显式 diagnostics 端口保留旧日志行为。
Workspace Sandbox 的 Hardline/路径/网络预检和完整 Bash 工具也已迁入 Pico Host；Bash 的超时与
SIGTERM→SIGKILL 宽限改为调用 Runtime 统一的可取消、unref deadline 原语，保持进程退出语义。
完整 RuntimeRun 已归属 Runtime；durable Transcript 的恢复校验使用独立 inspector，不依赖展示层 reducer，
旧入口只负责注入结构化 diagnostics 并兼容导出。
单轮 RuntimeRunExecutor 属于 Pico Host，以窄 Session/Hook/模型执行 Port 连接 RuntimeRun；具体
AgentEngine、SessionRuntime、图片加载和日志仅由旧兼容入口注入，不进入 Runtime 或 Host 包的反向依赖。
Host Agent 的轮次预算校验和 Plan execution/revision 提示属于 Runtime 纯策略；AgentRuntime 只消费结果。
Runtime 还提供 Hook async-rewake 队列/coordinator、通用 RuntimeRun Port factory，以及 durable fork
lifecycle factory；Host/Engine 只注入具体模型注册表、Session fork 文件事务与资源清理。
Pico Host 的 SessionRuntime lifecycle 是会话资源 owner，统一管理 Hook 生命周期、任务投影、后台进程、
Code Intelligence 状态切换、沙箱 detach 与终止释放；旧源码入口只负责具体资源构造和端口适配。
FileIndex 的 git/rg/目录扫描与本地缓存同样属于 Pico Host，TUI 只消费其公开查询能力。
File History 的写前 journal、快照/CAS 编排、diff、rewind、fork sidecar 与恢复状态机也属于 Pico Host；
manifest 表访问和 mutation lease 由 Storage 提供，旧 `src/safety/file-history*` 仅保留兼容导出。
Workspace Todo Store 的 Host 路径适配，以及 Process Sandbox 的环境净化、策略编译、原生后端探测、
资源摘要验证和进程 lease 也属于 Pico Host；旧路径仅为兼容导出，运行时 singleton 与错误类型身份不分裂。
WorkspaceRoots 的真实路径/授权边界与 Code Intelligence 的 LSP/RepoMap 生命周期同样位于 Pico Host；
具体 Tool Registry middleware 和结构化 logger 由旧入口注入，不让 Host 包反向引用 `src/`。
Hook 的事件/信任契约、HookService、配置/watch、Shell/信任库、管理状态、Hookify 文件规则和具体
handler executor 与 Session composition 已收敛到 Pico Host；Hook composition 通过命令工厂连接
`@pico/cli` 的 SlashCommand 契约及 `/hooks`、`/hookify` 适配，`src/hooks` 仅保留兼容和 logger 注入。
进程内 `TaskRegistry` 的任务身份、状态转移、快照隔离、重启中断与权威投影幂等同样属于
Runtime；`task_list/task_output/task_stop` 的校验、任务域分流和结果投影也通过窄 Port
在 Runtime 内实现。Storage 控制 Store 上的 JobService 和 TaskRegistry→Job/attempt/lease 镜像编排
同样属于 Runtime，且只接受 Host-resolved `storageRoot`。后台子进程的生命周期、输出环形缓冲、停止升级和记录裁剪属于 Pico Host；
实际 Shell/Sandbox 启动请求和进程树信号由外层安全适配器通过 Port 注入。
TUI 可写任务的 Worktree Supervisor、串行 Merge Queue 和 TaskHostRuntime 也属于 Pico Host；
它们统一持有 Git worktree、admission/shutdown ownership fence 与持久 Job 镜像，只向下依赖
Runtime 的任务/Job 编排和 Storage 的 SQLite 控制事实。
WorkspaceTaskRuntime、CronRuntimeScheduler 和每工作区的 CronWorkspaceRuntime 装配同样位于 Pico Host：
前者拥有 workspace Run 的暂停、恢复、取消与有界关闭状态机，后两者把 Runtime CronService 的
耐久 Run、ownership fence 与有界 drain 接入 workspace 执行。
TaskRun 的纯事件/投影与恢复身份属于 Core，Store 契约和完整 SQLite 实现属于 Storage，适配器注册
与输入校验、SafeBoundaryResume 的计划/CAS/结算协调属于 Runtime；耐久 Agent worker intent、
文件锁争用与 RuntimeEvent 准入适配属于 Pico Host。旧 `src/tasks`、`src/runtime` 和
`src/storage/sqlite` 的这些同名入口仅用于兼容。
`request_sandbox_boundary` 的严格输入/结算校验和 direct-only 工具投影也在 Runtime；实际的审批、
边界规范化与持久化/执行仍由 Host 注入的 handler 完成。
Skill Catalog 的目录扫描、来源优先级、修订计算和 `skill_view`，以及 Prompt Composer 的
AGENTS.md 读取、Plan/Graph/Headless 提示策略与 Skill/Todo/Goal 组合，同样属于 Pico Host；
它们只通过注入的窄 Port 读取外层会话和日志能力。
MCP 的 schema 校验、用户级配置文件的私有原子写入/幂等锁、项目配置真实路径检查、受信任的
用户/项目/插件来源优先级解析，以及 HTTP/SSE、stdio 客户端和 Connection Manager 生命周期均归于
Pico Host；日志、远程网络准入和进程沙箱通过显式 Host Port 注入，旧 `src/mcp` 入口只保留兼容适配。
MCP 的不含 Pico 语义的 wire protocol DTO、JSON-RPC 常量、版本协商、工具名规范化，以及将 MCP tool
映射为全局资源互斥工具的通用 bridge 位于 Runtime Host；Pico Host 只将它绑定到完整 ToolExecutionContext
和 ToolRegistry，保持 Runtime Host 不感知产品配置与连接策略。
审批前的 diff 预览同样在 Host：它读取工作区文件并通过注入的安全路径解析与 diff 生成 Port 形成
仅供交互展示的 best-effort 结果，任何异常都不会阻断审批。
人类审批的挂起/唤醒、超时、取消和通知属于 Pico Host；其 session scope 为不透明载荷。危险命令与
hardline 的 fail-closed 判断属于 Runtime，避免交互状态机反向依赖安全或 Engine 实现。
`LocalDaemonHost` 通过泛型 Cron 生命周期端口协调注册工作区、服务关闭与 ownership fence；
Cron scheduler 和 SQLite 细节仍由外层实现注入。Resource Doctor 也位于 Host：它只读取候选资源
目录、校验其真实路径是否仍在边界内，并生成可展示的权威诊断，不解析 prompt 或启动扩展。
Desktop checkpoint/review 的投影、SHA-256 指纹和 Rewind fail-closed 前置条件同样归属 Host；
Desktop Rewind 的 claim、幂等回放和通知编排也在 Host，通过最小 Session fork、文件变更和日志 Port
接入外层实现。File History 命令服务通过最小 Session Port 读取 checkpoint 并触发不透明的 fork authority，
避免 Host 反向依赖 Engine 或存储实现。Desktop Runtime 通知到 durable Transcript 的筛选、去重与追加
也由 Host 负责，完整 Transcript reducer 校验经端口注入。Provider 调用目的位于 Core，而异步调用归属上下文位于 Runtime。Workspace trust 的交互契约位于 Core，原子用户级文件库位于 Storage，
默认路径与 fail-closed 流程位于 Host，readline 实现位于 CLI。CLI 包已拥有会话启动参数和 SQLite
catalog resolver。有效模型运行时只可投影为不含凭据和端点的诊断信息；该投影位于 Host，供
Workspace Doctor 与 Desktop 外层装配复用。Workspace Doctor 的只读状态编排也位于 Host，
SQLite 深检以只读 Port 注入，因而不会让 Host 反向依赖 Storage 的具体实现。
Provider Usage 的成本计算位于 Runtime；可更新的模型价格 catalog 则由外层作为 resolver 注入，
避免 Runtime 与特定价格快照耦合。
周期任务的意图判断、自动启动子进程的最小环境，以及自动 Git 的 hooks、凭据、filter 和维护禁用
策略同样属于 Runtime。每工作区 Cron 的关闭、drain deadline 与 ownership fence 位于 Host，
具体 scheduler 与 durable store 只经端口提供。
Usage baseline 的差额导入、Provider 限流头解析、凭据轮换池、重试及 429 轮换协调也位于 Runtime；
网络适配与结构化日志保留在外层，通过 Provider 与 logger 端口接入。Provider 请求的无明文指纹、
Endpoint 安全规范化、Prompt Cache 身份/工具快照、缓存前缀断点、效果统计和变更诊断同样归属 Runtime，
Tracker、Provider 与 Engine 直接消费该稳定能力。
Web Search 的能力判断、网络守卫和工具面收缩也在 Runtime；具体 ToolRegistry 注册与外部搜索适配
仍由外层提供。Plan 的事件条目确定性折叠、活动计划筛选和不变量校验同样位于 Runtime，
仅消费 Core 的计划事实与 Storage 的事件条目契约及实现。Plan Coordinator 的 CAS、幂等重放、
Graph 完成前置校验与执行恢复编排也已归入 Runtime；Engine 的活跃 Run 状态以 liveness Port 注入。
配置型子代理的隐藏准入事实解析、会话归属读取、续跑前的耐久一致性校验，以及 `agent_output`
的授权查询和有界历史投影也已归入 Runtime；当前父 Run 与子 workspace 的 Store 打开动作由外层
适配器以最小 Port 提供。
Graph Operator 的 `agent.output` canonical ledger、幂等重放仲裁和 RuntimeEvent 写入同样位于
Runtime；Graph Host 仅注入当前 Session 的 owner-fence 断言，不向 Runtime 泄漏 Engine 生命周期。
Exact Run 的耐久分类和 root wake 状态机仅依赖 Runtime/Storage 端口；Session pinning、Run admission
与实际执行仍由 Host 组合。受管 Graph Git worktree 的创建、物理路径校验、恢复和安全清理属于 Pico Host。

现有业务目录的归属为：`src/engine/`、`src/context/`、`src/provider/`、`src/tools/`、
`src/safety/`、`src/approval/` 的运行策略将继续收敛到 Runtime，涉及文件系统、Pico session key/
设置写回和审批交互的宿主适配则留在外层。`src/agent-graph/` 已只保留旧
import 兼容出口，以及两项外层适配：Engine Session → Pico Host 执行边界 Port、SQLite Runtime Event
Store → Runtime 查询 Port；稳定 Graph 契约/权限边界在 Core，SQLite Graph Store 在 Storage，应用与
协调实现都在 Runtime。`src/daemon/` 将收敛到 Pico Host；`src/cli/`、`src/tui/` 将收敛到 CLI；SQLite
schema 与事务实现将收敛到 Storage。

## 状态真源

每个 workspace 的会话和控制事实保存在：

```text
$PICO_HOME/workspaces/<workspace-id>/
├── pico.sqlite
├── pico.sqlite-wal / pico.sqlite-shm  # 运行期
├── traces/
├── evidence/                           # 旧引用兼容或专用资产，不是新 ToolResult 主路径
├── fork-staging/
├── plugins/                            # workspace 私有 local-scope Plugin
├── plugins.json
└── hooks-state.json
```

原子长期记忆另存 `$PICO_HOME/memory.sqlite`，同一用户跨工作区共用；通过 global/workspace
scope 限定可见范围。`pico.sqlite` 承载以下工作区状态，不代表它们属于同一个业务对象：

- sessions scope：RuntimeEvent、Session、Run、Transcript 与相关投影；
- task-runs scope：显式 recoverable 任务、Attempt、checkpoint、租约和启动凭据；
- control scope：Job、Cron、daemon run、usage、provider call 和生命周期控制状态；
- operations、attachments、retention、kv 等 scope：跨域操作、文件历史 manifest、配额与辅助状态。

这些 scope 通过 typed store API 和事务边界维持所有权。RuntimeEvent 是 Agent 运行事实，
TaskRun 是恢复协议事实，Control 是调度事实。独立记忆库由 `SqliteMemoryItemStore` 管理
Item、keys、sources、cursor/receipt 和工作区开关；不与 RuntimeEvent 共用事务。当前机制见
[原子长期记忆](14-workspace-memory.md)。

旧 Fact/Proposal workspace memory scope 已从当前 schema 移除；带有这些旧表的 workspace
数据库不走兼容读取或迁移，需在可恢复归档后重建。

## ToolResult 与上下文

- ToolResult 在执行结果进入 Runtime 前受 1 MiB 上限约束。
- 限内结果以 `storage: "inline"` 进入 canonical RuntimeEvent；超限结果改写为合成错误，原始
  超限正文不会进入事实库。
- Provider 请求在读取侧按预算生成有界投影；Compaction 只改变模型读取视图，不改写
  canonical RuntimeEvent。
- `read_evidence` 与新 ToolResult 的 Evidence CAS 回读协议已经退役；旧
  `storage: "evidence"` 形态仅在兼容读取边界容忍。

## 路径边界

- `$PICO_HOME`：设备级配置、信任、daemon 注册、文件历史 blob 与 workspace 状态根。
- `<workDir>/.pico/`：随项目保存的声明式 config、commands、skills、agents、hooks、MCP 和
  plugins，不保存 Session 历史。
- 旧 JSONL 纪元的 `.storage/`、`sessions/`、`task-runs/`、`control/` 与 `runtime/` 是不兼容
  布局标记；产品路径不会猜测性迁移或自动删除。

## 阅读顺序

1. [`ARCHITECTURE.md`](../../ARCHITECTURE.md)：当前系统边界、状态所有权与安全边界。
2. [`01-engine.md`](01-engine.md) 至 [`07-hooks.md`](07-hooks.md)：按模块理解实现；这些
   深入文档可能包含被后续 ADR 取代的局部段落，先看 [`docs/README.md`](../README.md) 的状态索引。
3. 决策记录 21—30：理解当前实现为何选择 PowerShell、SQLite、入口定形和恢复协议；
   工具披露与运行时边界以取代决策 23 的[决策 30](../decisions/30-decision-maka-tool-runtime.md)为准。
4. `docs/plans/`：当前实施计划；`docs/history/`：已结束计划、课程与历史设计，不定义当前事实。

## 技术栈

- TypeScript ESM，Node.js 22.19+/24.3+/26，内置 `node:sqlite`
- Ink / React 19、Electron、pino、gpt-tokenizer、js-yaml
- tsx、TypeScript、ESLint、Prettier
