# TUI 启动与运行

pico-harness 的本地 Agent Runtime 同时支持 TUI 与 Desktop。`pico` → TUI 仍是已安装命令的公开启动方式；Desktop 当前从仓库开发脚本启动。

REST/WebSocket、ACP、飞书和 one-shot CLI 外壳曾在历史阶段完成，后已退役。TUI 与 Desktop
都通过 `LocalRuntimeClient` 使用本机 daemon；`executeAgentRuntime` 是 daemon 内部入口，不构成
公开 headless API。持久 Cron 通过 TUI 创建并由当前 OS 用户的 daemon 执行。Docker 部署、
公开 Plugin 安装/市场 UI 和任意代码插件仍不在当前支持范围；已安装且明确受信的资源型
Plugin 会通过 host-private snapshot 供内部 Runtime 使用。

## 本地开发启动

```bash
npm run dev

# Desktop 开发版
npm run desktop:dev
```

在其他项目目录体验 Pico 时，建议显式使用本仓库的 `.env`：

```bash
cd /path/to/your-project
npx tsx --env-file=/path/to/pico-harness/.env \
  --import /path/to/pico-harness/src/tui/preload-env.ts \
  /path/to/pico-harness/src/cli/main.ts
```

## 已安装命令启动

```bash
cd /path/to/your-project
pico
```

启动时的当前目录就是 Pico 的项目根目录。工具读写、Bash、`@` 文件引用、`AGENTS.md`、`.pico/commands`、`.claude/commands` 都相对该目录解析。

文件历史也在 TUI 内操作：使用 `/snapshots` 列出快照，使用 `/rewind` 执行 code / conversation / both 回滚。

## 共享配置与凭证

TUI 和 Desktop 从同一个 `PICO_HOME`（默认 `~/.pico`）读取设备级配置。`config.json` 保存 Provider、默认路由，以及可选的明文 `apiKey`；目录和文件会分别收紧到 0700/0600。也可以让用户 Provider 通过 `apiKeyEnv` 或可用的系统凭证后端解析密钥。Desktop 的 Provider 页和 TUI `/provider` 命令修改的是同一份配置。

`PICO_HOME` 也参与本地 daemon endpoint 命名；两个不同的 `PICO_HOME` 不会误连到对方的
Runtime。模型 Provider 与默认路由只来自用户级 `config.json`；工作区 `.pico/config.json`
不再覆盖它们。MCP 合并 `$PICO_HOME/mcp.json` 与受信工作区 `.pico/mcp.json`，项目同名定义
优先；旧 `.claw/mcp.json` 仅作兼容回退。

每个 workspace 的 Session、TaskRun、控制面、Memory 和跨域 operation 都写入：

```text
$PICO_HOME/workspaces/<workspace-id>/pico.sqlite
```

数据库使用 Node 内置 `node:sqlite`、WAL 和 `synchronous=FULL`；`workspace_storage_binding`
保存稳定 `storageRootId` 与当前物理目录身份。存储根被复制、替换或移动后会 fail-closed，只有
显式 adopt 流程可以更新绑定，普通启动不会静默接管。

显式 recoverable 任务的执行权由 SQLite task-runs scope 中的 execution lease 决定。恢复器
必须重新证明 adapter 版本、不可变输入、workspace identity、RuntimeEvent 边界和副作用状态；
不能证明时写入稳定 park reason，不自动重放不确定副作用。`run.started` 只表示准入，不单独
证明 worker 已启动；既有闭包、provider stream、PTY 和普通子进程仍属于 `host_bound`。

旧 JSONL 纪元的 `.storage/`、`sessions/`、`task-runs/`、`control/` 与非空 `runtime/` 都是
不兼容布局标记。产品路径不会自动导入、复制或删除它们；需要保留旧数据时应先执行明确的迁移
或人工备份。旧 split-era `runtime.sqlite` / `memory.sqlite` 同样不是当前事实源。

运行中的 Run 固定使用启动时的配置快照，不会中途热换模型或凭证。daemon 在后续 Run
装配时读取新配置，并通过 Runtime 事件通知客户端刷新；Desktop 在窗口重新聚焦时还会补一次
状态读取。损坏配置、revision 冲突或 Provider authority 冲突都会 fail-closed。

## 环境变量迁移

裸 `LLM_*` 不再自动生成模型路由。它们只能作为 `/provider import-env <id>` 的一次性迁移输入，或在用户 Provider 已显式声明 `apiKeyEnv` 时提供凭证：

| 变量                           | 说明                                  |
| ------------------------------ | ------------------------------------- |
| `LLM_BASE_URL`                 | `/provider import-env` 的端点输入     |
| `LLM_API_KEY` / `LLM_API_KEYS` | 导入输入或 `apiKeyEnv` 指向的凭证     |
| `LLM_MODEL`                    | `/provider import-env` 的默认模型输入 |

可选：

| 变量              | 说明                                    |
| ----------------- | --------------------------------------- |
| `SEARCH_API_BASE` | 搜索服务端点                            |
| `SEARCH_API_KEY`  | 搜索服务凭证                            |
| `PICO_SHELL_PATH` | 覆盖宿主 Shell；支持 Bash 或 PowerShell |
| `PICO_HOME`       | 覆盖共享配置与 Runtime 数据根目录       |
| `LOG_LEVEL`       | `debug` / `info` / `warn` / `error`     |

## 验证

默认门禁全部是本地确定性检查，不访问真实模型：

```bash
npm ci
npm audit --audit-level=high
npm run lint
npm run format
npm run typecheck
npm run desktop:typecheck
npm run test:integration
npm run check:storage
npm run build
npm pack --dry-run
npm run desktop:package
```

`test:integration` 覆盖 Runtime、daemon、持久化和安全边界的本地集成路径；`check:storage`
验证 Node 22.19+/24.3+/26 的版本策略和内置 `node:sqlite` 可用性。项目不依赖需要单独按 ABI
重建的第三方数据库模块。`build` 和 `npm pack --dry-run` 检查 CLI 产物，
`desktop:package` 生成当前平台的未签名 Desktop smoke 包；它不替代安装、签名或公证验证。

真实模型闭环需要可用的 Provider 配置、凭证与网络，只在受控环境执行，不在无凭证 CI 中强制运行：

```bash
npm run test:llm-e2e
```
