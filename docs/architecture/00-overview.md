# pico-harness 架构总览

> 文档类型：当前架构导航。系统边界与状态所有权见
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md)；实际依赖以 package manifest、公开 exports
> 和 `npm run check:architecture` 为准。迁移过程保存在[包边界实施计划](../plans/2026-09-13-package-boundary-alignment.md)，不在本页重复维护。

## 执行路径

TUI 和 Desktop 是两种产品外壳，共享同一本机 daemon 与执行内核：

```text
CLI / TUI ── LocalRuntimeClient ─────────────────┐
                                                ▼
Desktop Renderer ── Preload ── Electron Main ── Pico Host daemon
                                                │
                                                ▼
                                      WorkspaceRuntimeService
                                                │
                                                ▼
                                       AgentRuntime 装配
                                                │
                                                ▼
                                     RuntimeRun / AgentEngine
                                                │
                                                ▼
                                      Storage 事实与投影
```

CLI/TUI 不装配执行内核；Desktop Renderer 不访问 Node.js、文件系统或 daemon registration，
只使用类型化 Preload 白名单。daemon 是当前用户本机 IPC 服务，不是公开网络服务。
Headless 入口复用 Pico Host 的装配与同一 Runtime，不建立另一套执行实现。

## 模块地图

业务实现只存在于以下正式包或 Desktop 应用中。跨包消费者使用 `@pico/*` 的公开 exports，
不穿透其他包的 `src/`、`dist/`，也不通过根 `src/` 获取实现。

| 模块                       | 职责                                                                              | 实现入口                                                     |
| -------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `@pico/core`               | 与 Provider、数据库及宿主无关的领域契约、身份、事件和纯模型                       | [Core](../../packages/core/src/)                             |
| `@pico/storage`            | Store 契约、SQLite schema/事务、锁、lease、blob 和持久化基础设施                  | [Storage](../../packages/storage/src/)                       |
| `@pico/runtime`            | Agent 执行循环、Session/Run 编排、上下文与压缩、预算、调度及安全策略              | [Runtime](../../packages/runtime/src/)                       |
| `@pico/runtime-host`       | 通用本机进程、连接、传输及 MCP wire/bridge 机制，不含 Pico 产品语义               | [Runtime Host](../../packages/runtime-host/src/)             |
| `@pico/protocol`           | 本机 RPC 方法、参数、结果、事件、校验与 Desktop allowlist                         | [Protocol](../../packages/protocol/src/)                     |
| `@pico/transcript-replica` | 基于协议的 Transcript 本地副本与客户端归并                                        | [Transcript Replica](../../packages/transcript-replica/src/) |
| `@pico/pico-host`          | 产品装配、daemon/RPC、workspace 路径与配置、Provider/工具/Hook/MCP 适配及原生沙箱 | [Pico Host](../../packages/pico-host/src/)                   |
| `@pico/cli`                | argv、命令、TUI、输入与终端展示适配                                               | [CLI/TUI](../../packages/cli/src/)                           |
| `@pico/desktop`            | Electron Main、Preload、Renderer 及桌面平台集成                                   | [Desktop](../../apps/desktop/src/)                           |

职责按策略与宿主实现划分，而不是按旧目录整块搬迁。例如，Runtime 拥有工具调度和安全策略，
Pico Host 拥有具体工具注册、文件/网络访问与人类审批交互，Storage 拥有相关持久化事务。
Runtime 可包含通用 Node/OS 机制，但不读取 Pico 产品配置、凭证或用户状态路径。

### 依赖方向

- Core 与 Protocol 不依赖其他 workspace 包；Storage → Core；Runtime → Storage/Core。
- Runtime Host → Runtime/Core；Transcript Replica → Protocol。
- Pico Host → Runtime Host/Runtime/Storage/Core/Protocol，不反向依赖 CLI 或 Desktop。
- CLI 和 Desktop 是外层消费者；它们可通过正式 exports 使用共享协议、投影和基础设施，
  不能把 UI 逻辑带入内层包。Desktop Renderer 还须遵守 Preload 隔离边界。
- 内层通过窄端口接收宿主能力，不回引根 `src/`、应用目录或其他包的私有实现。

完整直接依赖见各包的 `package.json`；[包边界可视化](./pico-package-boundaries.html)是冻结的设计审查快照，
不替代当前 manifest 与架构检查。

### 根 src 仅保留进程入口

```text
src/
├── cli/main.ts                        # CLI/TUI 进程入口
├── daemon/main.ts                     # 本机 daemon 进程入口
└── internal/
    ├── headless-bootstrap-main.ts      # Headless bootstrap 入口
    └── headless-one-shot-main.ts       # Headless 单轮入口
```

这四个文件只负责进程启动适配并调用正式包入口，不是兼容导出树或新的业务目录。
测试、诊断、CI 与打包脚本均消费正式包；构建后的根 `dist/` 对应这些入口，包实现由各自
`dist/` 提供。测试或开发运行前应通过现有 npm 生命周期构建 workspace 包。

## 状态所有权与安全原则

- `$PICO_HOME/workspaces/<workspace-id>/pico.sqlite` 保存工作区事实。RuntimeEvent 是会话/Agent
  叙事真源，TaskRun 是恢复协议事实，Control 是调度事实；共库不等于共享业务所有权。
- Session 内存、Transcript 与 Desktop ViewModel 都是可重建投影，不建立第二套会话历史。
- 原子长期记忆独立保存在 `$PICO_HOME/memory.sqlite`，不与 RuntimeEvent 共用事务。
- `<workDir>/.pico/` 保存项目声明式配置，不保存 Session 历史；宿主解析的 Home、路径、凭证
  与权限必须随运行隔离，内层不重新猜测。旧布局不做猜测性迁移或自动删除。
- Session 持久变更经 owner lease、串行化与事务保护；工具并发受资源冲突、权限和共享预算约束。
- Approval、Hardline、Plan、Workspace trust 与 Hook 组成执行前安全链，Hook 改写后重新检查。
- ToolResult 入口上限为 1 MiB；限内正文 inline 入事实库，超限写入合成错误。请求投影与压缩
  只改变模型读取视图，不改写 canonical RuntimeEvent。

状态表、路径布局、并发与恢复的完整规则统一见根 [ARCHITECTURE.md](../../ARCHITECTURE.md)。

## 进一步阅读

- [文档状态索引](../README.md)：区分当前机制、被取代的决策与历史资料。
- [Engine](01-engine.md)、[工具](02-tools.md)、[上下文](03-context.md)、
  [Provider 与入口](04-provider-entry.md)、[基础设施与安全](05-infra-safety.md)、
  [数据流](06-data-flow.md)、[Hooks](07-hooks.md)：按主题深入；局部旧段落以当前源码和状态索引为准。
- [本机 IPC 安全](local-ipc-security.md)、[原子长期记忆](14-workspace-memory.md)、
  [Graph Mode](18-graph-mode.md)：专项机制与所有权。
- [工具运行时决策 30](../decisions/30-decision-maka-tool-runtime.md)：取代早期工具披露决策。
- [实施计划](../plans/)与[历史资料](../history/)记录演进背景，不定义当前实现边界。
