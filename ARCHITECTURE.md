# pico-harness 架构

> 本文是当前生产代码的架构事实源，描述模块边界、依赖方向、运行链路、状态所有权与安全边界。
> 文档与代码或测试冲突时，以代码、测试和已实施的架构决策为准。

## 1. 架构目标

pico-harness 是一个面向本地工程的 Agent Harness。它将产品外壳、Agent 执行内核、持久化和安全策略分离，使 TUI、Desktop 以及远程客户端能够复用同一套执行语义。

核心原则：

- 产品外壳可以不同，Agent 执行内核必须共享。
- Session、Run、Transcript 和工具结果必须可持久化、可恢复。
- RuntimeEvent 是会话与 Agent 运行叙事的事实来源。
- 模型只能请求工具，不能绕过权限、审批、Hook 和沙箱直接操作系统。
- 领域层不依赖产品外壳；产品外壳只消费公开包接口。
- 根 `src/` 只承载发行入口，不承载业务实现。

## 2. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         产品外壳                              │
│                                                              │
│  TUI / CLI                         Desktop                   │
│  packages/cli                      apps/desktop              │
│       │                                  │                    │
│       │ LocalRuntimeClient               │                    │
│       └──────────────────┬───────────────┘                    │
└──────────────────────────┼───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    本机服务与产品装配层                       │
│                    packages/pico-host                         │
│                                                              │
│  Daemon · WorkspaceRuntimeService · DesktopRuntimeService     │
│  Provider · Tool Registry · Hooks · MCP · 配置 · 原生适配      │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                         执行层                                │
│                                                              │
│  packages/runtime                 packages/runtime-host       │
│  Session / Run / AgentEngine      进程、连接、传输与宿主能力   │
│  调度 / 预算 / 压缩 / 子代理       MCP bridge 与平台适配        │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                      领域、协议与持久化                       │
│                                                              │
│  packages/core       packages/protocol       packages/storage │
│  领域契约            本机 RPC / 事件协议      SQLite / Blob    │
│  运行状态模型        参数校验 / 白名单        Store / 投影     │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
             LLM Provider · 文件系统 · Shell · MCP · LSP
```

### 2.1 本地调用边界

```text
TUI
  └─ packages/cli
       └─ LocalRuntimeClient
            └─ current-user local daemon
                 └─ packages/pico-host
                      └─ AgentRuntime

Desktop Renderer
  └─ typed Preload bridge
       └─ Electron Main
            └─ LocalRuntimeClient
                 └─ current-user local daemon
```

TUI 和 Desktop 都通过 `LocalRuntimeClient` 调用本机 daemon。TUI 不再装配 Agent 执行内核；Desktop Renderer 不直接访问 Node.js、文件系统或 Runtime，而是通过类型化 Preload bridge 进入 Electron Main，再进入同一连接层。

当前 daemon 只提供当前用户本机 IPC，不直接开放网络传输。远程连接由独立的 remote 包和协议扩展提供。

## 3. Monorepo 结构

```text
pico-harness/
├── apps/
│   └── desktop/                  Electron 主进程、Preload、Renderer
├── packages/
│   ├── core/                     领域模型与跨模块契约
│   ├── protocol/                 RPC、事件、参数和结果协议
│   ├── runtime/                  Agent 执行内核
│   ├── runtime-host/             进程、连接、传输和宿主适配
│   ├── storage/                  SQLite、Store、Blob 和投影
│   ├── pico-host/                daemon 与产品级依赖装配
│   ├── cli/                      TUI、CLI 命令和客户端适配
│   ├── transcript-replica/       Transcript 客户端归并与复制
│   ├── remote-client/            远程客户端
│   ├── remote-gateway/           远程 Gateway
│   └── remote-relay/             WebSocket Relay
├── src/
│   ├── cli/main.ts               根发行包 CLI 入口
│   ├── daemon/main.ts            根发行包 daemon 入口
│   └── internal/                 Headless 入口
├── tests/e2e/                    真实模型端到端测试
├── scripts/                      构建、边界、审计和校验脚本
└── docs/                         使用文档与专题架构说明
```

根 `src/` 只保留四个进程入口：

- `src/cli/main.ts`
- `src/daemon/main.ts`
- `src/internal/headless-bootstrap-main.ts`
- `src/internal/headless-one-shot-main.ts`

跨模块引用必须使用 `@pico/*` 的公开 exports，不从根 `src/` 导入业务模块。

## 4. 模块职责与依赖方向

### 4.1 `packages/core`：领域基础层

负责稳定的领域模型和跨模块契约，包括：

- Session 与持久化契约
- Runtime message / transcript event
- Provider capability 与 reasoning
- Tool permission policy
- Workspace trust contract
- Subagent capability
- Plan review identity
- Agent Graph update contract
- 已知工具名称和运行状态模型

`core` 不依赖其他 workspace 包，是依赖图的基础层。

### 4.2 `packages/protocol`：通信协议层

负责 daemon、客户端和远程模块之间的协议定义：

- 方法、参数、结果和事件
- 严格解析与 validator
- 统一方法注册表
- Desktop 可访问方法白名单
- 传输编解码和身份相关协议

`protocol` 依赖 `core`，不依赖 CLI、Desktop 或具体 Runtime 实现。

### 4.3 `packages/storage`：持久化层

负责事实存储和可重建投影：

- SQLite schema 与事务
- Runtime Event Store
- TaskRun Store
- Runtime Control Store
- Memory Item Store
- File History blob、manifest 和 operation journal
- lease、checkpoint、terminal 状态和恢复数据

Storage 提供 Store 能力，但不拥有 Agent 循环，也不负责 UI 状态。

### 4.4 `packages/runtime`：Agent 执行内核

负责 Agent 如何运行：

- `AgentRuntime` 运行协作
- Session 与 RuntimeRun
- `AgentEngine` 主循环
- Prompt 组装和模型历史读取
- ToolScheduler 调度
- 运行预算和父子运行关系
- 子代理上下文与溢出处理
- 上下文压缩和归档读取
- Runtime 生命周期事件

`runtime` 依赖 `core` 和 `storage`，不依赖 TUI、Desktop 或具体 Provider SDK。

### 4.5 `packages/runtime-host`：运行时宿主层

负责把 Runtime 所需能力接到当前操作系统和本机进程：

- 进程与连接
- 通用传输机制
- MCP wire / bridge
- 文件、Shell 等宿主能力的适配
- 平台原生扩展

`runtime-host` 依赖 `core` 和 `runtime`。

### 4.6 `packages/pico-host`：本机产品装配层

负责组装可运行的本机 Agent：

- daemon 生命周期
- WorkspaceRuntimeService
- DesktopRuntimeService
- Provider 和 Model Router
- Tool Registry
- Approval、Hooks、MCP
- 配置、凭证和运行环境
- 原生安全适配
- Task Host 与服务级运行管理

`pico-host` 是 composition root 的主要承载位置，但共享执行语义仍由 `runtime` 定义。

`AgentRuntime` 接收明确的 `picoHome`、`runtimeEnv`、工作目录、模型路由和 Session，不在调用链深处重新猜测另一套 Home、凭证或工具环境。

### 4.7 `packages/cli`：TUI / CLI 外壳

负责：

- `pico` 命令和启动参数
- Ink TUI
- Slash Command 与 CommandRegistry
- RPC 命令、补全和格式化
- Settings、Hook、Memory、Plan 等客户端命令
- DaemonEventReporter 到 TUI 的事件转换

CLI 只负责输入、展示和客户端生命周期，不拥有 Agent 执行事实。

### 4.8 `apps/desktop`：桌面产品外壳

分为：

```text
Renderer  →  typed Preload bridge  →  Electron Main
```

Main 进程负责：

- Application 生命周期
- IPC 和命令服务
- LocalRuntimeClient 接入
- Browser / Computer Use
- Artifact 导出和预览安全
- Gateway 管理
- 平台级能力和高权限操作

安全边界要求：

- 开启 `contextIsolation`
- 关闭 Renderer 的 Node integration
- Renderer 只依赖类型化桥接接口
- 高权限操作只能由 Main 进程执行
- Main 只转发协议白名单中的方法

### 4.9 `packages/transcript-replica`：客户端 Transcript 副本

负责 Transcript 和运行事件的客户端归并、复制与同步。它不拥有会话事实，只维护可由协议事件重建的客户端副本。

### 4.10 Remote 模块

```text
remote-client  →  remote-gateway  →  remote-relay / WebSocket
                         │
                         ▼
                   本地 Pico Host
```

- `remote-client`：远程客户端协议封装。
- `remote-gateway`：Gateway、Runtime 接入和 WebSocket 服务。
- `remote-relay`：更底层的 WebSocket 中继。
- `transcript-replica`：远程客户端的 Transcript 状态复制。

远程模块复用 `protocol` 和本地 Runtime 语义，不重新实现 Agent 内核。

## 5. 一轮 Agent Run

```text
宿主输入
  │
  ▼
AgentRuntime.execute
  ├─ 解析 workDir、PICO_HOME、Session 和模型快照
  ├─ 获取 durable Session
  ├─ 修复或重建 RuntimeEvent 投影
  ├─ 装配 Provider、ToolRegistry、Approval、Hooks、MCP 和子代理
  └─ 创建 RuntimeRun
       │
       ▼
AgentEngine.run
  ├─ PromptComposer 组装 system prompt
  ├─ 从 RuntimeEvent read model 物化模型历史
  ├─ 调用 Provider generate / stream
  ├─ 解析 assistant message 和 Tool Call
  ├─ ToolScheduler 按资源冲突图执行工具
  ├─ 写入 assistant / tool / approval / terminal 事实
  └─ Reporter 向当前产品外壳发布生命周期事件
```

Agent 的核心循环如下：

```text
读取 Session
  → 构造上下文
  → 调用 Provider
  → 若无 Tool Call，则结束或等待下一次输入
  → 若有 Tool Call，则执行安全链
  → 写入 Tool Result
  → 继续调用 Provider
```

`AgentEngine` 不拥有产品 UI 或持久化路径。它通过注入的 Store、Provider、Tool Registry 和 Reporter 工作。

## 6. 工具执行安全链

模型不能直接执行操作系统能力，所有工具调用必须经过以下链路：

```text
Tool Call
  → Tool Registry
  → Permission Policy
  → Workspace Trust
  → Approval
  → Hardline
  → Plan / Hook
  → Sandbox / Runtime Host
  → ToolScheduler
  → 实际执行
  → Tool Result 持久化
```

### 6.1 权限与信任

安全策略至少覆盖：

- 工具级权限
- Workspace trust
- 用户审批
- Hardline 限制
- Hook 改写和拒绝
- Plan 约束
- 子代理权限和工具集合
- 运行预算

### 6.2 并发与资源冲突

`ToolScheduler` 根据工具声明的读写资源构建冲突图：

```text
read A.ts + read B.ts       → 可并发
write A.ts + read A.ts      → 必须串行
write A.ts + write A.ts     → 必须串行
动态 Bash                   → 使用保守资源边界
```

## 7. 状态真源与持久化

### 7.1 存储位置

```text
$PICO_HOME/
├── workspaces/<workspace-id>/
│   └── pico.sqlite           workspace 级 Session、TaskRun、Control 等状态
└── memory.sqlite             用户级原子长期记忆
```

可选的 `traces/` 保存运行 Span，但不替代事实账本。

### 7.2 所有权表

| Store                       | 逻辑 Scope           | 负责的数据                                                                         | 不负责的数据                     |
| --------------------------- | -------------------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| `SqliteRuntimeEventStore`   | `sessions`           | Session、消息、工具、审批、压缩、rewind、run terminal、Transcript 投影             | Job、TaskRun、长期记忆           |
| `SqliteTaskRunStore`        | `task-runs`          | 可恢复任务的输入、checkpoint、lease、启动凭据、终态                                | Session Transcript、Cron 调度    |
| `SqliteRuntimeControlStore` | `control`            | Jobs、daemon/cron runs、attempts、leases、usage、provider calls、completion outbox | Session Transcript、TaskRun 事实 |
| `SqliteMemoryItemStore`     | 独立 `memory.sqlite` | 原子 Item、keys、sources、提取 cursor/receipt、幂等操作、重试范围                  | 原始对话事实、旧 Proposal 审批   |

### 7.3 RuntimeEvent

`RuntimeEventStore` 是 Session 和 Agent 叙事的 canonical semantic log。以下内容都应是可重建投影：

- Session 内存状态
- Transcript
- Desktop ViewModel
- 客户端 Timeline
- 运行状态展示

Session 内存或客户端副本损坏时，应从 RuntimeEvent 重建，而不是建立第二套会话历史。

单次 Tool Result 在入口处受 1 MiB 上限约束：限内正文 inline 入库，超限则写入合成错误，并要求模型通过更窄的命令重新获取。

### 7.4 Session 隔离

Session 以工作区和 Session 标识隔离，并配合：

- owner lease
- per-session drain
- 连续 RuntimeEvent sequence
- SQLite 事务
- 崩溃恢复和 terminal 修复

## 8. Plan、DAG 与 Agent Graph

Plan 和 Agent Graph 是两个层次：

```text
Plan
  → 面向任务步骤的执行计划

Agent Graph
  → 面向 Agent 协作、依赖和控制的执行图
```

PlanStep 支持 `dependsOn`。只有全部前置步骤进入 terminal（`completed` 或 `skipped`）后，步骤才能进入 `in_progress`；无依赖关系的步骤可以并行执行。

调度状态通过持久化更新协调：

- `plan.step.updated(in_progress)` 作为 claim
- CAS 防止重复领取
- `run.terminal` 证明运行已终止
- `plan.step.recovered` 用于崩溃恢复

Plan 的步骤事实由 Plan 持有；Agent Graph 负责 Operator 的 claim、执行和结果收口，两者通过稳定标识关联，不复制整个 Session 历史。

## 9. 上下文、压缩与记忆

### 9.1 上下文压缩

```text
RuntimeEvent canonical log
  → 读取侧生成有界模型视图
  → 计算 Token 水位
  → 超过水位时生成压缩摘要
  → 后续请求使用压缩视图继续执行
```

压缩只改变后续模型的读取视图，不改写当前 EventLog 中的 canonical RuntimeEvent。完整工具批次边界是压缩的安全边界。

### 9.2 原子长期记忆

原子记忆位于独立的用户级 `memory.sqlite`，不与 RuntimeEvent 共享事务。

记忆库负责：

- Item、keys、sources
- 提取 cursor 和 receipt
- 幂等操作
- 重试范围
- 工作区设置
- 用户显式编辑意图

显式 `remember` 同步提交；自动后台提取在 terminal 或 checkpoint 持久化之后触发。Session 删除不会自动删除已提交记忆；删除记忆时清除正文及关联记录。

## 10. 子代理与后台任务

```text
Parent Run
  ├─ 创建 Child Session
  ├─ 分配独立上下文
  ├─ 限定工具集合
  ├─ 限定权限和共享预算
  ├─ 执行或后台运行
  └─ 汇总 Child Result
```

子代理拥有独立上下文和工具集合。父运行负责约束其运行身份、权限、预算和结果收口；子代理不直接共享父 Session 的完整 Transcript。

## 11. Provider 抽象

Provider 由 `pico-host` 装配，由 Runtime 消费统一接口：

```text
Provider Config
  → Model Route
  → Provider Adapter
  → Provider Capability / Reasoning
  → Runtime Model Interface
  → AgentEngine
```

当前产品支持的 Provider 协议包括：

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages
- OpenAI-compatible

Provider 的具体 SDK、凭证和模型路由配置不应泄漏到 `runtime` 或产品外壳。

## 12. 测试与工程校验

测试以 `tests/e2e/` 的真实模型端到端验证为主，覆盖：

- Agent Graph 与 DAG 调度
- Agent 输出引用
- 原子 Memory
- Code Mode
- 自动上下文压缩与压缩质量
- 子代理 continuation 和 preset
- Session 恢复
- 工具执行与状态同步

工程脚本还负责：

- 架构边界检查
- 依赖审计
- Sandbox 包和资源校验
- Storage capability 检查
- Worker 构建
- Desktop 打包
- 模型能力与价格同步

## 13. 依赖规则总结

```text
core
├── protocol
├── storage
└── runtime
      └── runtime-host
            └── pico-host
                  ├── cli
                  └── desktop

protocol
├── remote-client
├── remote-gateway
└── transcript-replica
```

约束：

1. `core` 不依赖其他 workspace 包。
2. `runtime` 不依赖 TUI、Desktop 或具体 Provider SDK。
3. `storage` 不拥有 Agent 循环，也不依赖产品外壳。
4. `pico-host` 负责产品级装配和外部能力接入。
5. CLI 与 Desktop 共享本机 Runtime，不各自实现 Agent 内核。
6. Renderer 不越过 Preload / Main 访问高权限能力。
7. 跨包导入使用 `@pico/*` 公开 exports。
8. 根 `src/` 只保留发行入口。
9. 精确依赖和边界以各包 manifest 及 `npm run check:architecture` 为准。

## 14. 一句话总结

pico-harness 是一个以 `AgentRuntime` 为执行核心、以 `pico-host` 为本机产品装配边界、以 `core / protocol / storage` 为稳定基础、以 TUI / Desktop / Remote 为不同产品外壳，并通过 RuntimeEvent、工具安全链和持久化 Store 实现可恢复 Agent 执行的本地 Agent 平台。
