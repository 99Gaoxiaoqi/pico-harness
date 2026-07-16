# TUI 启动与运行

pico-harness 的本地 Agent Runtime 同时支持 TUI 与 Desktop。`pico` → TUI 仍是已安装命令的公开启动方式；Desktop 当前从仓库开发脚本启动。

REST/WebSocket、ACP、飞书和 one-shot CLI 外壳曾在历史阶段完成，后已退役。`executeAgentRuntime` 是 TUI 与 daemon 共用的内部 Runtime 入口，不构成公开 headless API。持久 Cron 通过 TUI 创建并由当前 OS 用户的本机 daemon 执行；daemon 是内部 Runtime 宿主，不是公开 headless CLI。Docker 部署和 Plugin runtime 仍不在当前支持范围。

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

TUI 和 Desktop 从同一个 `PICO_HOME`（默认 `~/.pico`）读取设备级配置。`config.json` 只保存 Provider 元数据和默认值；密钥与配置分离。发布构建当前没有可用的持久凭证后端：macOS 的 `/usr/bin/security` 兼容实现默认 fail-closed，仅可用 `PICO_UNSAFE_KEYCHAIN_CLI=1` 显式开启本地开发模式。正式分发必须使用 Developer ID 签名的 Pico Credential Broker/XPC；在此之前只能使用前台环境变量，不能创建依赖持久密钥的 Automation。Desktop 的 Provider 页和 TUI `/provider` 命令修改的是同一份配置。

`PICO_HOME` 也参与本地 daemon endpoint 命名；两个不同的 `PICO_HOME` 不会误连到对方的 Runtime。工作区 `.pico/config.json` 只在信任后读取，并可覆盖用户默认模型。MCP 默认读取 `.pico/mcp.json`；旧 `.claw/mcp.json` 仅作兼容回退。

运行中的 Run 固定使用启动时的配置快照，不会中途热换模型或凭证。TUI 在下一轮发送前重新解析配置；Desktop 通过 Runtime 事件刷新，并在窗口重新聚焦时补一次读取。损坏配置、revision 冲突或 Provider authority 冲突都会 fail-closed。

## 环境变量兼容

如尚未配置共享 Provider，仍可用旧环境变量启动：

| 变量                           | 说明                            |
| ------------------------------ | ------------------------------- |
| `LLM_BASE_URL`                 | OpenAI 兼容端点或 provider 端点 |
| `LLM_API_KEY` / `LLM_API_KEYS` | 单 key 或多 key 轮换            |
| `LLM_MODEL`                    | 默认模型名                      |

可选：

| 变量              | 说明                                |
| ----------------- | ----------------------------------- |
| `SEARCH_API_BASE` | 搜索服务端点                        |
| `SEARCH_API_KEY`  | 搜索服务凭证                        |
| `PICO_SHELL_PATH` | 覆盖 Bash 工具使用的 shell          |
| `PICO_HOME`       | 覆盖共享配置与 Runtime 数据根目录   |
| `LOG_LEVEL`       | `debug` / `info` / `warn` / `error` |

## 验证

```bash
npm run typecheck
npm run test -- tests/tui/repl-input-routing.test.tsx tests/tui/app.test.tsx
npm run smoke:tui
```

`smoke:tui` 会先构建可发布产物，再在真实 PTY 中启动 `pico`，提交一条输入并验证它向本地 fake OpenAI 端点发起请求；不需要密钥或外网。
