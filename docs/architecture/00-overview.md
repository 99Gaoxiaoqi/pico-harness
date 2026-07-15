# pico-harness 架构总览

> 大模型是 CPU，上下文是内存，工具是外设，RuntimeEvent 是可恢复的运行事实。

## 产品与 Runtime

pico-harness 当前有 TUI 和 Desktop 两种产品外壳，两者共用 `AgentRuntime`、Provider、
ToolRegistry、Session 和持久化语义。

```text
pico / npm run dev
  └─ CLI + TUI ───────────────────────────────┐
                                               ▼
                                        AgentRuntime
                                               │
Desktop Renderer                              ▼
  └─ Preload ── Electron Main ── local daemon ─┘
                       │
                       └─ @pico/protocol 类型、校验与方法白名单

AgentRuntime
  └─ AgentEngine ── Provider / Tools / Context / Approval / Hooks / MCP
          │
          ├─ RuntimeEventStore：Session 与 Agent 事实
          └─ RuntimeStore：Jobs、Runs、Usage 与租约控制面
```

Desktop Renderer 不直接加载 Runtime 代码。Electron Main 使用共享 `LocalRuntimeClient`
连接当前 `PICO_HOME` 的认证本机 daemon；每个长连接订阅独占连接，普通请求复用请求连接。

## 模块地图

| 模块                          | 职责                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| `src/runtime/`                | `AgentRuntime` composition root、RuntimeRun、RuntimeEvent 及投影 |
| `src/engine/`                 | ReAct 循环、Session、预算、Reporter、Goal 与 Steer               |
| `src/provider/`               | Provider 协议、ModelRouter、凭证轮换、重试和计费能力             |
| `src/tools/`                  | 工具 Registry、中间件、调度器、子代理与渐进披露                  |
| `src/context/`                | Prompt 组装、请求投影、模型摘要、Artifact 和 Evidence            |
| `src/tasks/`                  | RuntimeStore、后台 Job、Cron、租约、Usage 和完成通知             |
| `src/daemon/`                 | 本机 IPC、认证、Desktop/Workspace Runtime 服务                   |
| `packages/protocol/`          | daemon 协议契约、运行时校验和 Desktop 方法白名单                 |
| `apps/desktop/`               | Electron Main/Preload/Renderer 和平台集成                        |
| `src/safety/`、`src/storage/` | FileHistory、CAS、rewind/fork journal、lease 与原子写入          |

## 状态边界

- `RuntimeEventStore` 是 Session manifest、消息、工具、审批、压缩、rewind 和 run terminal
  的唯一事实源。
- `RuntimeStore` 是 Jobs、daemon/cron runs、attempts、leases、usage 和 completion outbox
  的控制面真源。
- 两者共享 `$PICO_HOME/workspaces/<workspace-id>/runtime.sqlite`，但使用不同表和 API。
- Session 内存、FTS5、Transcript 和 Desktop ViewModel 都是可重建投影。
- Session title 存在 RuntimeEvent；Desktop metadata 不保存第二份 title。

## 路径边界

- `$PICO_HOME`：用户和设备级状态根，默认 `~/.pico`。
- `$PICO_HOME/workspaces/<workspace-id>/`：Runtime 数据库、检索投影、Artifact、Evidence、
  Trace、Task 和 storage operation。
- `<workDir>/.pico/`：项目配置、commands、skills、agents、hooks、MCP 和 plugins。
- `.claw` 只可能作为明确的旧版本兼容读取来源，不是 Pico 原生写入路径或事实源。

Runtime Host 必须显式传播 `picoHome` 和 `runtimeEnv`。同一进程中，不同
`PICO_HOME` 的 Session 设置、授权、凭证、Artifact 与数据库不能共享状态。

## 核心设计原则

| 原则             | 说明                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| 单一执行内核     | TUI 和 Desktop 共享 AgentRuntime/AgentEngine，不维护两套业务实现            |
| 事实与控制面分离 | RuntimeEventStore 管 Agent 事实，RuntimeStore 管后台调度状态                |
| 显式宿主边界     | Home、env、Provider config、Artifact root 由 composition root 固定并注入    |
| 安全链前置       | Trust、Plan、Hardline、Approval、Hooks 和 workspace boundary 位于工具执行前 |
| 投影可重建       | FTS、Transcript、UI state 不升级为第二事实源                                |
| 状态所有权拆分   | 只有拥有独立状态或生命周期的模块才拆成服务，避免空转抽象                    |

## 文档索引

| 文档                                                             | 内容                                        |
| ---------------------------------------------------------------- | ------------------------------------------- |
| [01-engine.md](./01-engine.md)                                   | Engine、Session、RuntimeEvent 与 Reporter   |
| [02-tools.md](./02-tools.md)                                     | Registry、调度、子代理、渐进披露与 Hooks    |
| [03-context.md](./03-context.md)                                 | Prompt、投影、压缩、Artifact 与记忆         |
| [04-provider-entry.md](./04-provider-entry.md)                   | Provider、AgentRuntime、TUI 与 Desktop 入口 |
| [05-infra-safety.md](./05-infra-safety.md)                       | FileHistory、审批、MCP、可观测性与部署边界  |
| [06-data-flow.md](./06-data-flow.md)                             | TUI/Desktop 到 Runtime 的关键数据流         |
| [07-hooks.md](./07-hooks.md)                                     | Hook 来源、信任、热重载和前后台边界         |
| [08-multi-agent-concurrency.md](./08-multi-agent-concurrency.md) | 多 Agent 共享写入和 OCC 规范                |
| [local-ipc-security.md](./local-ipc-security.md)                 | Desktop 与 daemon 本机 IPC 安全             |

## 技术栈

- TypeScript ESM，Node.js 22.x，strict type checking
- better-sqlite3、Ink/React、Electron、pino、gpt-tokenizer、js-yaml
- tsx、TypeScript、ESLint、Prettier
