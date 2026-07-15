# pico-harness 架构

> 本文描述当前生产代码的模块边界与事实源。设计原则是：产品外壳可以不同，Agent
> 执行内核、持久化语义和安全边界必须共享。

## 系统边界

```text
TUI
  pico / npm run dev
    └─ src/cli + src/tui
         └─ AgentRuntime

Desktop
  Renderer
    └─ typed Preload bridge
         └─ Electron Main
              └─ LocalRuntimeClient
                   └─ authenticated local daemon
                        ├─ DesktopRuntimeService
                        ├─ WorkspaceRuntimeService
                        └─ AgentRuntime

AgentRuntime
  ├─ Session / RuntimeRun
  ├─ AgentEngine
  ├─ Provider / ModelRouter
  ├─ ToolRegistry / approval / hooks / MCP
  └─ RuntimeEventStore + RuntimeStore
```

TUI 和 Desktop 是当前两种产品外壳。TUI 在当前进程装配 `AgentRuntime`；Desktop
Renderer 不直接访问 Node.js 或 Runtime，而是经类型化 Preload、Electron Main 和本机
daemon 调用同一个 Runtime。daemon 只提供当前用户本机 IPC，不开放网络传输。

`packages/protocol` 定义 daemon 方法、参数、结果、事件和 Desktop 可访问方法白名单。
Electron Main 只转发白名单内的方法，Renderer 只依赖 `DesktopBridge` 类型。

## 分层与所有权

| 层次         | 主要模块                                                                                 | 所有权                                                     |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 产品外壳     | `src/cli/`、`src/tui/`、`apps/desktop/`                                                  | 输入、展示、生命周期和宿主交互                             |
| 本机 Runtime | `src/daemon/`、`packages/protocol/`                                                      | 本机 IPC、认证、Workspace 注册、Desktop 控制面             |
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

`src/engine/loop.ts` 只负责执行循环，不拥有产品 UI 或持久化路径。TUI 使用
`TuiReporter` 更新 Ink 界面；Desktop daemon 将同一类运行状态投影为协议事件，Renderer
再构造 Transcript 和 Timeline。

上下文超水位时，旧 ToolResult 先做请求投影；仍超预算时，`FullCompactor` 在完整工具
批次边界生成摘要。被移出模型历史的原始工具交换写入 evidence，RuntimeEvent 事实不因压缩
而丢失。

## 状态真源

`$PICO_HOME/workspaces/<workspace-id>/runtime.sqlite` 由两个边界清晰的组件共享：

| 组件                | 负责的数据                                                                                  | 不负责的数据                  |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| `RuntimeEventStore` | Session manifest、消息、工具、审批、压缩、rewind、run terminal 等 Agent 事实                | Job 调度、租约和完成通知      |
| `RuntimeStore`      | Jobs、daemon/cron runs、attempts、leases、usage、provider calls、completion outbox 等控制面 | Session Transcript 和标题事实 |

`RuntimeEventStore` 是会话和 Agent 运行事实的唯一真源。Session 内存、Transcript、FTS5
检索和 Desktop 展示状态都是投影；损坏后应从 RuntimeEvent 重建，不建立第二套会话历史。

Session 标题也属于 RuntimeEvent。Desktop session metadata 只保存 archive 等 UI 元数据；
旧 metadata 由一次性迁移转换，正常读写只使用当前 schema，不以 metadata title 作为回退。

`RuntimeStore` 是后台任务控制面的真源。它与 RuntimeEventStore 共用数据库和迁移身份，
但通过不同表和 API 维持 bounded context，不能把 Job 状态当作 Session 历史。

## 路径模型

`PICO_HOME` 是宿主拥有的用户状态根，默认值为 `~/.pico`。同一进程可以运行多个不同
`PICO_HOME` 的 Runtime；Session scope、权限、凭证、Artifact 和数据库路径必须随宿主隔离。

```text
$PICO_HOME/
├── config.json
├── commands/
├── skills/
├── agents.yaml
├── hooks.json
├── plugins/
├── trusted-workspaces.json
├── trusted-hooks.json
├── daemon-workspaces.json
├── file-history/
└── workspaces/<workspace-id>/
    ├── runtime.sqlite
    ├── sessions.db
    ├── todo.json
    ├── artifacts/
    ├── evidence/
    ├── traces/
    ├── memory/
    ├── tasks/
    ├── storage-operations/
    └── fork-staging/

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

## 并发与安全边界

- Session 以 `workspace root + sessionId` 隔离，并通过 owner lease 和 per-session drain
  串行化持久变更。
- RuntimeEvent 追加在 SQLite 事务中分配全局 sequence，并以 `eventId` 保证重试幂等。
- ToolScheduler 根据声明的文件读写资源构建冲突图；Bash 等动态能力使用保守资源边界。
- 文件改动由 FileHistory、CAS blob 和 storage operation journal 支持 rewind/fork 恢复。
- Approval、Hardline、Plan、Workspace trust 和 Hook 位于工具执行前的安全链；Hook 改写后
  必须重新经过安全检查。
- 子代理拥有独立上下文和工具集合。可写 Worker 的共享目录、OCC 和 worktree 升级规则见
  [多 Agent 共享工作区并发规范](./docs/architecture/08-multi-agent-concurrency.md)。
- Desktop BrowserWindow 开启 context isolation、关闭 Node integration；daemon token、socket
  权限和方法白名单共同构成本机信任边界。

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
