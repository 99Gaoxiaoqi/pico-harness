# pico-harness 架构

> 本文描述当前生产代码的模块边界与事实源。设计原则是：产品外壳可以不同，Agent
> 执行内核、持久化语义和安全边界必须共享。

## 系统边界

```text
TUI
  pico / npm run dev
    └─ src/cli + src/tui
         └─ LocalRuntimeClient

Desktop
  Renderer
    └─ typed Preload bridge
         └─ Electron Main
              └─ LocalRuntimeClient

LocalRuntimeClient
  └─ current-user local daemon
       ├─ DesktopRuntimeService
       ├─ WorkspaceRuntimeService
       └─ AgentRuntime

AgentRuntime
  ├─ Session / RuntimeRun
  ├─ AgentEngine
  ├─ Provider / ModelRouter
  ├─ ToolRegistry / approval / hooks / MCP
  └─ RuntimeEventStore + TaskRunStore + RuntimeStore
```

TUI 和 Desktop 是当前两种产品外壳。两者都通过 `LocalRuntimeClient` 调用本机 daemon；
TUI 进程不再装配执行内核。Desktop Renderer 不直接访问 Node.js 或 Runtime，而是经类型化
Preload 和 Electron Main 进入同一连接层。daemon 只提供当前用户本机 IPC，不开放网络传输。

`packages/protocol` 定义 daemon 方法、参数、结果、事件和 Desktop 可访问方法白名单。
Electron Main 只转发白名单内的方法，Renderer 只依赖 `DesktopBridge` 类型。

## 分层与所有权

| 层次         | 主要模块                                                                                 | 所有权                                                     |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 产品外壳     | `src/cli/`、`src/tui/`、`apps/desktop/`                                                  | 输入、展示、生命周期和宿主交互                             |
| 本机 Runtime | `src/daemon/`、`packages/protocol/`                                                      | 本机 IPC、认证、Workspace 注册、Desktop/Cron 控制面        |
| 应用装配     | `src/runtime/agent-runtime.ts`                                                           | 固定一次 Run 的 Session、Provider、工具、环境和路径依赖    |
| 执行内核     | `src/engine/`                                                                            | ReAct 循环、Session 串行化、预算、压缩触发和 Reporter 事件 |
| 能力         | `src/provider/`、`src/tools/`、`src/context/`、`src/approval/`、`src/hooks/`、`src/mcp/` | 模型、工具、上下文、安全与扩展能力                         |
| 持久化       | `src/runtime/`、`src/tasks/`、`src/storage/`、`src/safety/`、`src/memory/`               | 运行事实、控制面、文件恢复和可重建投影                     |

`AgentRuntime` 是共享 composition root。它解析明确的 `picoHome`、`runtimeEnv`、模型
路由和 Session，然后把已固定的依赖传给 Engine、Provider 和工具。模块不应在调用链深处
重新猜测另一套 Home、凭证或工具环境。

## 一轮 Agent Run

```text
宿主输入
  └─ AgentRuntime.execute
       ├─ 解析 workDir、PICO_HOME、Session 和模型快照
       ├─ 取得 durable Session 并修复 RuntimeEvent 投影
       ├─ 装配 Provider、ToolRegistry、审批、Hooks、MCP 和子代理
       └─ RuntimeRun.run
            └─ AgentEngine.run
                 ├─ PromptComposer 组装 system prompt
                 ├─ RuntimeEvent read model 物化模型历史
                 ├─ Provider generate / stream
                 ├─ ToolScheduler 按资源冲突图执行工具
                 ├─ 写入 assistant / tool / approval / terminal 事实
                 └─ Reporter 将生命周期投影给当前外壳
```

`src/engine/loop.ts` 只负责执行循环，不拥有产品 UI 或持久化路径。daemon 将运行状态投影为
协议事件；TUI 的 `DaemonEventReporter` 再转给 `TuiReporter` 更新 Ink 界面，Desktop
Renderer 则据此构造 Transcript 和 Timeline。

上下文超水位时，旧 ToolResult 先在读取侧生成有界请求投影；仍超预算时，`FullCompactor`
在完整工具批次边界生成摘要。压缩只改变后续模型读取视图，不改写当前 EventLog 中的
canonical RuntimeEvent。单次 ToolResult 在入口处受 1 MiB 上限约束，限内正文 inline 入库，
超限则写入合成错误并要求模型通过更窄的命令重新获取。

## 状态真源

`$PICO_HOME/workspaces/<workspace-id>/` 下的状态按事实所有权拆分。RuntimeEventStore 是
Session/Agent 叙事的 canonical semantic log；TaskRun、Control 与 Memory 各自拥有独立事实，
只通过稳定标识或弱外键引用 RuntimeEvent，不复制会话历史。

| 组件                        | `pico.sqlite` 逻辑 scope | 负责的数据                                                                                  | 不负责的数据                           |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| `SqliteRuntimeEventStore`   | sessions                 | Session、消息、工具、审批、压缩、rewind、run terminal 与 Transcript 投影                    | Job 调度、TaskRun 和长期记忆 Fact      |
| `SqliteTaskRunStore`        | task-runs                | 显式可恢复任务跨 Attempt 的输入、checkpoint、租约、启动凭据与终态                           | Session Transcript 和 Cron 调度状态    |
| `SqliteRuntimeControlStore` | control                  | Jobs、daemon/cron runs、attempts、leases、usage、provider calls、completion outbox 等控制面 | Session Transcript 和 TaskRun 事实     |
| `SqliteMemoryRepository`    | memory                   | 版本化 settings、sources、facts、proposals、审计与幂等记录                                  | 原始对话事实（属于 RuntimeEventStore） |

`RuntimeEventStore` 是会话和 Agent 运行事实的唯一真源。Session 内存、Transcript 和
Desktop ViewModel 都是可重建投影；损坏后应从 RuntimeEvent 重建，不建立第二套会话历史。

Session 标题也属于 RuntimeEvent。Desktop session metadata 只保存 archive 等 UI 元数据；
旧 metadata 由一次性迁移转换，正常读写只使用当前 schema，不以 metadata title 作为回退。

所有 workspace Store 共用一个 `pico.sqlite`，但通过独立 schema scope、typed store API 和
弱外键语义维持所有权边界。单库事务替代了旧 `.storage/` 目录锁、自研 commit journal 和
跨 JSON/JSONL 文件协调；跨域生命周期操作仍先写 durable prepare，再执行或恢复收口。

`SqliteMemoryRepository` 是 RuntimeEvent 派生 provenance + 用户编辑意图的复合 authority：
Source 可以由 RuntimeEvent 追溯，manual Fact、Fact 状态变更和 Proposal 裁决属于独立用户
意图。Session 删除、自动 retention 或 EventLog hard cut 只让 Source unavailable，不删除
已经提交的长期 Fact。`traces/` 保存可选运行 Span，不替代任何事实账本。

### Plan 执行与 DAG 调度

PlanStep 支持 `dependsOn`（前置步骤 id 列表），允许计划步骤以 DAG 形式声明依赖关系。
reducer 的依赖门控确保步骤只有在其全部 `dependsOn` 达到 terminal（completed/skipped）后
才能进入 `in_progress`；多个无依赖关系的步骤可并行执行。

DAG 调度全部从 RuntimeEventStore 派生，不建立第二个 canonical store：

- `plan.step.updated(in_progress)` 事件本身就是调度 claim（appendPlanOperation 的 CAS +
  幂等保证不重复 dispatch）。
- `plan.step.recovered` 事件用于崩溃恢复——当 `run.terminal` 证明某个 run 已终止但该 run
  启动的 step 仍未 settled 时，recover 将 step 回退为 pending（不自动重派）。
- `delegate_task` 工具的 `plan_step_id` 参数让工具层自动管理 step 状态（dispatch →
  in_progress，完成 → completed），无需模型手动调 update_plan。
- `src/graph/graph-reconcile.ts` 的 `computeReadySteps` 是纯函数，从 PlanProjection 计算就绪步骤。
- `src/graph/graph-recover.ts` 的 `recoverOrphanSteps` 通过 `run.terminal` 跨参判定 orphan step，
  零假阳性（vs lease 定时器的假阳性风险）。

## 路径模型

`PICO_HOME` 是宿主拥有的用户状态根，默认值为 `~/.pico`。同一进程可以运行多个不同
`PICO_HOME` 的 Runtime；Session scope、权限、凭证、Trace 和存储根必须随宿主隔离。

```text
$PICO_HOME/
├── config.json
├── commands/
├── skills/
├── agents.yaml
├── hooks.json
├── mcp.json
├── plugins/
├── plugin-data/
├── trusted-workspaces.json
├── trusted-hooks.json
├── daemon-workspaces.json
├── file-history/
└── workspaces/<workspace-id>/
    ├── pico.sqlite
    ├── pico.sqlite-wal / pico.sqlite-shm  # SQLite 运行期文件
    ├── evidence/
    ├── traces/
    ├── fork-staging/
    ├── plugins.json
    └── hooks-state.json

<workDir>/.pico/
├── config.json
├── commands/
├── skills/
├── agents.yaml
├── hooks.json
├── mcp.json
└── plugins/
```

`<workDir>/.pico` 保存可跟随项目的声明式输入，不保存 Session 历史。旧 `.claw` 文件仅在
明确标注的兼容读取边界中可能被识别，Pico 原生写入和事实源均不使用 `.claw`。

旧 `.storage/`、`sessions/`、`task-runs/`、`control/`、`runtime/`、split-era
`runtime.sqlite` / `memory.sqlite` 和 legacy task 文件都不属于当前布局。产品路径不会自动
导入或删除这些内容；出现 JSONL 纪元目录标记时，SQLite 初始化会 fail-closed。需要保留数据
时必须先走显式迁移或人工备份流程。

## 并发与安全边界

- Session 以 `workspace root + sessionId` 隔离，并通过 owner lease 和 per-session drain
  串行化持久变更。
- RuntimeEvent 在 SQLite `BEGIN IMMEDIATE` 事务中按 Session 分配连续 sequence，并以
  `eventId` 与 canonical payload 全等校验保证重试幂等；事实与相关投影同事务提交。
- ToolScheduler 根据声明的文件读写资源构建冲突图；Bash 等动态能力使用保守资源边界。
- 文件改动由 FileHistory blob、SQLite manifest 和 operation journal 支持 rewind/fork 恢复。
- Approval、Hardline、Plan、Workspace trust 和 Hook 位于工具执行前的安全链；Hook 改写后
  必须重新经过安全检查。
- 子代理拥有独立上下文和工具集合。可写 Worker 的共享目录、OCC 和 worktree 升级规则见
  [多 Agent 共享工作区并发规范](./docs/architecture/08-multi-agent-concurrency.md)。
- Desktop BrowserWindow 开启 context isolation、关闭 Node integration；私有 endpoint、
  当前用户文件/进程权限、typed root authority 和方法白名单共同构成本机信任边界。

## 关键模块索引

| 模块                | 入口                                                               |
| ------------------- | ------------------------------------------------------------------ |
| Engine 与 Session   | [01-engine.md](./docs/architecture/01-engine.md)                   |
| 工具与子代理        | [02-tools.md](./docs/architecture/02-tools.md)                     |
| 上下文与投影        | [03-context.md](./docs/architecture/03-context.md)                 |
| Provider 与产品入口 | [04-provider-entry.md](./docs/architecture/04-provider-entry.md)   |
| 基础设施与安全      | [05-infra-safety.md](./docs/architecture/05-infra-safety.md)       |
| 核心数据流          | [06-data-flow.md](./docs/architecture/06-data-flow.md)             |
| Hooks               | [07-hooks.md](./docs/architecture/07-hooks.md)                     |
| 本机 IPC 安全       | [local-ipc-security.md](./docs/architecture/local-ipc-security.md) |

架构判断以源码的实际依赖和事实源为准；历史课程章节只解释演进背景，不定义当前产品边界。
