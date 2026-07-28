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
          ├─ TaskRunStore：可恢复任务与 Attempt 事实
          └─ RuntimeStore：Jobs、Runs、Usage 与租约控制面
```

Desktop Renderer 不直接加载 Runtime 代码。Electron Main 使用共享 `LocalRuntimeClient`
连接当前 `PICO_HOME` 的认证本机 daemon；每个长连接订阅独占连接，普通请求复用请求连接。

## 模块地图

| 模块                          | 职责                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `src/runtime/`                | `AgentRuntime` composition root、RuntimeRun 及 Runtime adapters                      |
| `src/storage/`                | RuntimeEventStore 等 durable storage 实现                                            |
| `src/engine/`                 | ReAct 循环、Session、预算、Reporter、Goal 与 Steer                                   |
| `src/provider/`               | Provider 协议、ModelRouter、凭证轮换、重试和计费能力                                 |
| `src/tools/`                  | 工具 Registry、中间件、调度器、子代理与渐进披露                                      |
| `src/context/`                | Prompt 组装、请求投影、模型摘要和 Evidence CAS                                       |
| `src/tasks/`                  | RuntimeStore、TaskRun、后台 Job、Cron、租约、Usage 和完成通知                        |
| `src/daemon/`                 | 本机 IPC、认证、Desktop/Workspace Runtime 服务；typed request router 与领域 handlers |
| `src/plugins/`                | Plugin Manager、scope/winner、snapshot、Hook trust、受限 capability 与统一诊断       |
| `packages/protocol/`          | daemon 协议契约、运行时校验和 Desktop 方法白名单                                     |
| `apps/desktop/`               | Electron Main/Preload/Renderer 和平台集成                                            |
| `src/safety/`、`src/storage/` | FileHistory、CAS、rewind/fork journal、lease 与原子写入                              |

## 状态边界

- `RuntimeEventStore` 是 Session manifest、消息、工具、审批、压缩、rewind 和 run terminal
  的唯一事实源，落在每个 Session 的 `session.jsonl`。
- `RuntimeStore` 是 Jobs、daemon/cron runs、attempts、leases、usage 和 completion outbox
  的控制面真源。
- `TaskRunStore` 是显式 recoverable 任务跨 Attempt 的事实账本；它保存 adapter 身份、不可变输入、
  checkpoint 引用、执行租约和启动凭据，但不复制 Session RuntimeEvent。
- `daemon-events.jsonl` 是 daemon 通知的持久回放账本，不替代 Agent 事件或控制面状态。
- 三者共享 `$PICO_HOME/workspaces/<workspace-id>/` 下的事务协调，但分别落在 `sessions/`、
  `task-runs/` 和 `control/`，使用不同账本和 API。
- Session 内存、Transcript 和 Desktop ViewModel 都是可重建投影。
- Session title 存在 RuntimeEvent；Desktop metadata 不保存第二份 title。

## 路径边界

- `$PICO_HOME`：用户和设备级状态根，默认 `~/.pico`。
- `$PICO_HOME/workspaces/<workspace-id>/`：Runtime 文件账本、Summary sidecar、Evidence、
  Trace、Task 和 storage operation。
- `<workDir>/.pico/`：项目配置、commands、skills、agents、hooks、MCP 和 plugins。
- 旧 `runtime.sqlite`、`memory.sqlite`、WAL/SHM 与 legacy task 文件保留原样，但当前版本不读取、迁移或自动删除。
- `runtime/lock/` 只作为升级 fence 保留，使旧版本 fail closed，避免与新布局形成双写分叉；
  若存在旧 `runtime/` JSON 账本，它们在一次性迁移后仍保留为回退副本。回滚前必须先停止
  所有新版本进程，再显式移除该 fence；新旧版本不得并行运行。

```text
workspace/
  sessions/<sha256(sessionId)>/{session.jsonl,manifest.json}
  task-runs/<sha256(taskRunId)>/{task.jsonl,manifest.json}
  control/{state.json,daemon-events.jsonl,usage-ledger.jsonl}
  .storage/
    layout.json # stable storageRootId + physical directory identity
    commit.json
    lock/
  runtime/lock/ # 兼容 fence，仅用于阻止旧版本继续写
  memory/
    state.json
    lock/
    summaries/
```

目录使用 `0700`，数据文件使用 `0600`。Session、TaskRun 与控制面读写先取得
`.storage/lock/` 的 workspace owner lease，并恢复遗留 `.storage/commit.json`；JSON 替换通过
临时文件、文件 `fsync`、原子 rename 和目录 `fsync` 发布。JSONL 只允许截断未完成的最后
一行，完整但非法的中间记录会 fail closed。

Runtime Host 必须显式传播 `picoHome` 和 `runtimeEnv`。同一进程中，不同
`PICO_HOME` 的 Session 设置、授权、凭证、Evidence 与存储根不能共享状态。

## 可恢复任务边界

可恢复的是持久化工作流，不是旧 JavaScript 调用栈。恢复必须同时证明 adapter 版本与输入、
workspace/root identity、RuntimeEvent 高水位、interrupted terminal、审批与工具副作用、
后台操作、工具目录和 checkpoint 均一致；任一条件不确定就写入稳定 park reason。
通过校验后，协调器先按 TaskRun 日志的提交时间取得或接管执行租约，再以 revision CAS 原子
写入 `task.resume.claimed + attempt.started`。adapter 使用确定性的 `launchId`、Runtime Run ID
和 `run.started` event ID，在来源高水位 `H+1` 以 CAS 原子发布 `run.started`；只有发布成功后
才能安装或确认 durable execution intent/worker，再启动 provider、工具或其他外部副作用。
`run.started` 只证明 admission，不单独证明 worker 已启动；若在 TaskRun 结算前崩溃，恢复器
从 canonical `H+1` 事件重建 body-free 准入凭据，并以同一 `launchId` 重调幂等 adapter，
直到 adapter 确认执行已安装。重复调用不得重复真实副作用。同一 Session 在 `H+2` 之后出现的
其他合法 Run 不会推翻已经成立的准入凭据，但来源 Run 在终止序列后不得再追加事实。旧
owner/lease epoch 的 checkpoint、launch 与完成写入会被拒绝。
既有 Worktree runner、PTY、provider stream 和闭包没有该契约，继续标记为 `host_bound`，
进程退出后只收敛为 `interrupted`。

`sessions/`、`task-runs/`、Evidence、Trace 和 Memory summaries 可进入只读导出计划；
其中 Session/TaskRun 只接受完整 SHA-256 目录和固定 canonical 文件名，计划在共享事务锁内
恢复 pending commit 后生成一致性哈希；
`.storage/`、`control/`、Memory state、锁、凭据、临时文件和 legacy SQLite 属于 host-bound
或 protected。Portable TaskRun 可用于检查和审计，但在新的 storage root 上不会自动接管执行。

## 核心设计原则

| 原则             | 说明                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| 单一执行内核     | TUI 和 Desktop 共享 AgentRuntime/AgentEngine，不维护两套业务实现            |
| 事实与控制面分离 | RuntimeEvent 管 Agent 事实，TaskRun 管任务事实，RuntimeStore 管调度状态     |
| 显式宿主边界     | Home、env、Provider config、Evidence root 由 composition root 固定并注入    |
| 安全链前置       | Trust、Plan、Hardline、Approval、Hooks 和 workspace boundary 位于工具执行前 |
| 投影可重建       | Session 内存、Transcript、UI state 不升级为第二事实源                       |
| 状态所有权拆分   | 只有拥有独立状态或生命周期的模块才拆成服务，避免空转抽象                    |

## 文档索引

| 文档                                                                             | 内容                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [01-engine.md](./01-engine.md)                                                   | Engine、Session、RuntimeEvent 与 Reporter              |
| [02-tools.md](./02-tools.md)                                                     | Registry、调度、子代理、渐进披露与 Hooks               |
| [03-context.md](./03-context.md)                                                 | Prompt、投影、压缩、Evidence 与摘要 sidecar            |
| [04-provider-entry.md](./04-provider-entry.md)                                   | Provider、AgentRuntime、TUI 与 Desktop 入口            |
| [05-infra-safety.md](./05-infra-safety.md)                                       | FileHistory、审批、MCP、可观测性与部署边界             |
| [06-data-flow.md](./06-data-flow.md)                                             | TUI/Desktop 到 Runtime 的关键数据流                    |
| [07-hooks.md](./07-hooks.md)                                                     | Hook 来源、信任、热重载和前后台边界                    |
| [09-architecture-debt-remediation.md](./09-architecture-debt-remediation.md)     | Durable transcript、Markdown 与 Runtime 窄拆债务修整   |
| [10-architecture-quality-assessment.md](./10-architecture-quality-assessment.md) | 分层、模块化、可测试性与插件化质量评估及验收标准       |
| [plugin-scope-contract.md](./plugin-scope-contract.md)                           | Plugin scope 物理根目录、优先级与 workspace-local 限制 |
| [local-ipc-security.md](./local-ipc-security.md)                                 | Desktop 与 daemon 本机 IPC 安全                        |

## 技术栈

- TypeScript ESM，Node.js 22.13+/24.3+/26，strict type checking
- 本地 JSON/JSONL 文件存储、Ink/React、Electron、pino、gpt-tokenizer、js-yaml
- tsx、TypeScript、ESLint、Prettier
