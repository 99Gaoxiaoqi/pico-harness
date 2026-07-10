# TUI 启动与运行

pico-harness 当前收口为 TUI 单入口。唯一公开启动方式是 `pico` → TUI；`npm run dev` 是仓库开发时的等价入口。

REST/WebSocket、ACP、飞书和 one-shot CLI 外壳曾在历史阶段完成，后已退役。Cron/headless 调度、Docker 部署和 Plugin runtime 不在当前支持范围。`runAgentFromCli` 仅供 TUI 内部装配，不构成公开 headless API。

## 本地开发启动

```bash
npm run dev
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

## 环境变量

至少需要：

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
| `LOG_LEVEL`       | `debug` / `info` / `warn` / `error` |

## 验证

```bash
npm run typecheck
npm run test -- tests/tui/repl-input-routing.test.tsx tests/tui/app.test.tsx
npm run smoke:tui
```

`smoke:tui` 会先构建可发布产物，再在真实 PTY 中启动 `pico`，提交一条输入并验证它向本地 fake OpenAI 端点发起请求；不需要密钥或外网。
