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
                                    └─ workspace pico.sqlite
```

- `pico` 和 `npm run dev` 启动的是 daemon 瘦客户端；TUI 进程不装配执行内核。
- Desktop Renderer 不访问 Node.js、Runtime registration 或本地文件，通过白名单 Preload API
  与 Electron Main 通信。
- `packages/protocol/` 定义本机 Runtime 方法、参数、结果、事件和 Desktop allowlist。
- daemon 依靠私有 endpoint、当前用户权限、root authority 和协议白名单建立本机边界，
  不是公开网络服务。

## 模块地图

| 模块                                    | 当前职责                                                 |
| --------------------------------------- | -------------------------------------------------------- |
| `src/cli/`、`src/tui/`                  | CLI 参数、daemon 客户端、Ink UI 与本地交互适配           |
| `apps/desktop/`                         | Electron Main/Preload/Renderer 与平台集成                |
| `src/daemon/`、`packages/runtime-host/` | 本机 IPC、Runtime 宿主、Workspace 生命周期和协议 handler |
| `src/runtime/`                          | `AgentRuntime` composition root、RuntimeRun 与恢复边界   |
| `src/engine/`                           | ReAct 循环、Session、调度、预算和 Reporter               |
| `src/provider/`                         | Provider 协议、模型路由、凭证解析、重试与计费            |
| `src/tools/`                            | Tool Registry、安全中间件、资源调度、子代理和工具披露    |
| `src/context/`                          | Prompt、请求投影、压缩、Skill 与恢复提示                 |
| `src/storage/sqlite/`                   | workspace 单库 schema、typed store、投影与事务边界       |
| `src/tasks/`、`src/memory/`             | Job/Cron/TaskRun 与长期记忆业务语义                      |

## 状态真源

每个 workspace 的持久事实集中在：

```text
$PICO_HOME/workspaces/<workspace-id>/
├── pico.sqlite
├── pico.sqlite-wal / pico.sqlite-shm  # 运行期
├── traces/
├── evidence/                           # 旧引用兼容或专用资产，不是新 ToolResult 主路径
├── fork-staging/
├── plugins.json
└── hooks-state.json
```

`pico.sqlite` 是统一物理载体，不代表所有状态属于同一个业务对象：

- sessions scope：RuntimeEvent、Session、Run、Transcript 与相关投影；
- task-runs scope：显式 recoverable 任务、Attempt、checkpoint、租约和启动凭据；
- control scope：Job、Cron、daemon run、usage、provider call 和生命周期控制状态；
- memory scope：Source、Fact、Proposal、settings、审计与幂等记录；
- operations、attachments、retention、kv 等 scope：跨域操作、文件历史 manifest、配额与辅助状态。

这些 scope 通过 typed store API 和事务边界维持所有权。RuntimeEvent 是 Agent 运行事实，
TaskRun 是恢复协议事实，Control 是调度事实，Memory Fact 是独立长期意图；它们不能互相冒充。

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
2. [`01-engine.md`](./01-engine.md) 至 [`07-hooks.md`](./07-hooks.md)：按模块理解实现；这些
   深入文档可能包含被后续 ADR 取代的局部段落，先看 [`docs/README.md`](../README.md) 的状态索引。
3. 决策记录 21—29：理解当前实现为何选择 PowerShell、SQLite、入口定形和恢复协议。
4. `docs/plans/`：阶段性交付证据，只用于追溯，不定义当前事实。

## 技术栈

- TypeScript ESM，Node.js 22.19+/24.3+/26，内置 `node:sqlite`
- Ink / React 19、Electron、pino、gpt-tokenizer、js-yaml
- tsx、TypeScript、ESLint、Prettier
