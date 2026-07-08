# Pico Claude Code 风格交互启动指南

这份文档面向想把 Pico 当作 Claude Code 风格编码助手使用的用户：进入任意项目目录，启动交互界面，让会话、命令、上下文引用都围绕当前项目工作。

## 推荐启动方式

推荐在目标项目目录启动 Pico，而不是在 pico-harness 仓库目录启动后再让模型切目录。

```bash
cd /path/to/your-project
pico --tui
```

如果你正在本仓库内开发 Pico，可以从任意目标项目目录直接调用源码入口：

```bash
cd /path/to/your-project
npx tsx --env-file=/path/to/pico-harness/.env \
  --import /path/to/pico-harness/src/tui/preload-env.ts \
  /path/to/pico-harness/src/cli/main.ts --tui
```

也可以运行单轮任务：

```bash
cd /path/to/your-project
npx tsx --env-file=/path/to/pico-harness/.env \
  /path/to/pico-harness/src/cli/main.ts "阅读 README 并总结项目结构"
```

启动时的 `cwd` 就是 Pico 眼里的项目根目录：

- 工具读写、Bash、`@` 文件引用默认都相对 `cwd` 解析。
- `AGENTS.md`、`.pico/commands`、`.claude/commands`、`.claude/agents` 都从当前项目读取。
- CLI session 保存在当前项目的 `.claw/sessions/<session-id>.jsonl`，不同项目目录互不混用。
- 已安装的 `pico` 不会自动读取本仓库 `.env`；请提前导出环境变量，或使用上面的开发命令显式传 `--env-file`。

## Session 启动语义

Pico 的 CLI session 以当前项目目录为边界：

| 模式 | 启动方式 | 语义 |
| --- | --- | --- |
| new | 不传 session 参数 | 创建一个新的 `cli-*` session。 |
| continue | `pico --continue` 或 `pico -c` | 继续当前项目最近更新的 session；如果没有历史 session，则创建新 session。 |
| resume | `pico --resume <session-id>` 或 `pico -r <session-id>` | 恢复指定 session。找不到 `.claw/sessions/<session-id>.jsonl` 会启动失败。 |
| fork | `pico --fork-session <session-id>` | 从指定 session 复制历史，派生一个新的 `cli-*` session。 |

交互内可以先用 `/sessions` 查看当前项目可恢复的 session，再用 `/resume <session-id>` 获取重启提示。当前运行中的 engine 不做热切换，真正恢复需要用 `--resume <session-id>` 重启入口。

## Slash Commands

当前交互层支持这些内置命令：

| 命令 | 说明 |
| --- | --- |
| `/status` | 查看当前 session、cwd、provider、model、thinking、permission 和 fork 来源。 |
| `/mode` | 查看或切换交互模式：`default`、`plan`、`auto`、`yolo`。 |
| `/model` | 查看或切换后续请求使用的模型。 |
| `/thinking` | 查看或切换思考强度：`off`、`low`、`medium`、`high`。别名：`/effort`。 |
| `/permissions` | 查看或切换权限模式：`default`、`auto`、`yolo`、`plan`。 |
| `/tools` | 列出核心、已披露和可搜索工具；`/tools <query>` 搜索可披露工具。 |
| `/help` | 列出命令；`/help <command>` 查看单个命令用法。 |
| `/clear` | 清空本地 TUI transcript 视图。 |
| `/compact` | 对当前 session 历史做摘要压缩；缺少模型配置时会说明不可用原因。 |
| `/init` | 在当前项目创建轻量入口文件：`AGENTS.md` 和 `.pico/config.json`，不会覆盖已有 `AGENTS.md`。 |
| `/doctor` | 检查 cwd、`.env`、provider、model、`LLM_BASE_URL`、`LLM_API_KEY[S]` 和 Node 版本。 |
| `/sessions` | 列出当前项目可恢复 session。 |
| `/resume` | 输出如何用 `--resume <session-id>` 重启恢复。 |
| `/snapshots` | 列出当前 session 的文件历史回滚点。 |
| `/rewind` | 回滚代码、对话或二者：`/rewind <messageId> code|conversation|both`。 |
| `/undo` | 默认回滚最近一个文件历史快照，也可指定 message id 和模式。 |
| `/agents` | 列出内置 Agent 和项目 `.claude/agents/*.md`。 |
| `/agent` | 把任务委派给指定 Agent：`/agent <name> <task>`。 |
| `/skills` | 列出当前项目 `.claw/skills` 中可用 Skill。 |
| `/skill` | 查看指定 Skill 正文：`/skill <name>`。 |

项目或用户自定义 Markdown 命令也会进入同一套 slash command registry。内置命令名优先保留，避免项目命令覆盖关键控制命令。

## Claude Code 兼容入口

### `.claude/commands`

Pico 会加载这些 Markdown prompt command：

- 项目级：`<cwd>/.pico/commands/**/*.md`
- 项目级：`<cwd>/.claude/commands/**/*.md`
- 用户级：`~/.pico/commands/**/*.md`
- 用户级：`~/.claude/commands/**/*.md`

子目录会转成冒号命令名，例如 `.claude/commands/git/review.md` 会成为 `/git:review`。Markdown frontmatter 支持 `description`、`argument-hint`、`allowed-tools`、`model`，正文中的 `$ARGUMENTS` 和 `$1`、`$2` 会按输入参数替换。

### `.claude/agents`

Pico 会加载项目级 Claude agent profile：

```text
<cwd>/.claude/agents/*.md
```

每个文件可用 frontmatter 声明 `name`、`description`、`tools`，正文作为 Agent instructions。`/agents` 会列出这些 Agent；`/agent <name> <task>` 会生成委派 prompt，要求主 Agent 调用 `delegate_task`。

当前 TUI/CLI 默认还会提供内置 Agent：`Explore`、`Plan`、`general-purpose`。项目级 `.claude/agents` 可以覆盖同名内置 Agent。

### `@` mentions

普通输入和 prompt command 输出都会先展开 `@` 引用，再交给模型：

- `@src/app.ts`：附加文件内容。
- `@src/app.ts#L10-40`：附加文件行号范围。
- `@"docs/design notes.md"`：引用包含空格的路径。
- `@docs`：附加目录清单。
- `@skill:review`：附加指定 Skill 正文。
- `@agent:tester`：提示优先使用子代理能力处理该 Agent 相关工作。

路径引用会相对当前 `cwd` 解析，并限制在工作目录内。

## 常见错误

### `.env` 缺失

开发命令如果写成 `--env-file=.env`，这个 `.env` 是相对当前 shell 所在目录解析的。在任意项目目录启动时，推荐使用绝对路径：

```bash
npx tsx --env-file=/path/to/pico-harness/.env /path/to/pico-harness/src/cli/main.ts --tui
```

已安装的 `pico` 命令不会自动加载 `.env`，需要先在 shell 中设置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，或用外部工具加载环境变量。

### Provider 配置缺失

如果看到「缺少 Provider 配置」或 `/doctor` 显示 `LLM_BASE_URL`、`LLM_API_KEY[S]` missing，请检查：

- `LLM_BASE_URL` 是否已设置。
- `LLM_API_KEY` 或 `LLM_API_KEYS` 是否已设置。
- `LLM_MODEL` 是否符合当前 provider。
- `--provider`、`--model`、`--base-url`、`--api-key` 是否传给了正确入口。

### 未知命令

未知 slash command 会显示 `Unknown slash command: /xxx`，并尽量给出 suggestions。请用 `/help` 查看内置命令，用 `/sessions`、`/agents`、`/skills` 查看当前项目加载到的动态能力。

如果自定义 `.claude/commands` 没出现，检查文件是否以 `.md` 结尾，路径名是否只包含字母、数字、下划线、短横线和子目录冒号映射所需的目录结构。

### Worktree 没有 `.env`

Git worktree 通常不会复制未跟踪的 `.env`。如果你在 `.worktrees/...` 内运行 `npm run dev`，而该 worktree 没有自己的 `.env`，启动会缺少模型配置。可选做法：

- 在 worktree 中复制一份 `.env`。
- 使用 `--env-file=/主仓库绝对路径/.env`。
- 直接在 shell 中导出 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。
