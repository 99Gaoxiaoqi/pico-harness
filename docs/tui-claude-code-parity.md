# Pico Claude Code 风格交互启动指南

这份文档面向想把 Pico 当作 Claude Code 风格编码助手使用的用户：进入任意项目目录，启动交互界面，让会话、命令、上下文引用都围绕当前项目工作。

## 推荐启动方式

推荐在目标项目目录启动 Pico，而不是在 pico-harness 仓库目录启动后再让模型切目录。

```bash
cd /path/to/your-project
pico
```

如果你正在本仓库内开发 Pico，可以从任意目标项目目录直接调用源码入口：

```bash
cd /path/to/your-project
npx tsx --env-file=/path/to/pico-harness/.env \
  --import /path/to/pico-harness/src/tui/preload-env.ts \
  /path/to/pico-harness/src/cli/main.ts
```

启动时的 `cwd` 就是 Pico 眼里的项目根目录：

- 工具读写、Bash、`@` 文件引用默认都相对 `cwd` 解析。
- `AGENTS.md`、`.pico/commands`、`.claude/commands`、`.claude/agents` 都从当前项目读取。
- CLI session 保存在当前项目的 `.claw/sessions/<session-id>.jsonl`，不同项目目录互不混用。
- 已安装的 `pico` 不会自动读取本仓库 `.env`；请提前导出环境变量，或使用上面的开发命令显式传 `--env-file`。

## Trace 调试入口

需要复盘每轮 agent 决策时，在启动前设置：

```bash
PICO_TRACE=1 pico
```

开启后，每次请求都会把 span tree 写到当前项目的 `.claw/traces/trace_<session>_<timestamp>.json`。TUI 会在本轮结束后追加一条 system message，直接显示保存路径；程序化调用仍可从 `runAgentFromCli()` 的 `result.tracePath` 读取同一路径。

## Session 启动语义

Pico 的 CLI session 以当前项目目录为边界：

| 模式        | 启动方式               | 语义                                               |
| ----------- | ---------------------- | -------------------------------------------------- |
| new         | `pico`                 | 在当前项目启动 TUI，并创建或复用当前 TUI session。 |
| browse      | `/sessions`            | 在 TUI 内查看当前项目可恢复的 session。            |
| resume hint | `/resume <session-id>` | 输出恢复提示；当前运行中的 engine 不做热切换。     |

交互内可以先用 `/sessions` 查看当前项目可恢复的 session，再用 `/resume <session-id>` 获取提示。当前运行中的 engine 不做热切换。

## Slash Commands

当前交互层支持这些内置命令：

| 命令           | 说明                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| `/status`      | 查看当前 session、cwd、provider、model route、thinking、mode 和 fork 来源。                |
| `/mode`        | 查看或切换唯一交互模式：`default`、`plan`、`auto`、`yolo`；默认是 `yolo`。                 |
| `/model`       | 从已配置/发现的 `providerID/modelID` 路由中切换完整 provider、端点、凭证来源和模型。       |
| `/thinking`    | 查看或切换思考强度：`off`、`low`、`medium`、`high`。别名：`/effort`。                      |
| `/permissions` | `/mode` 的兼容别名；不再维护第二套权限状态。                                               |
| `/help`        | 列出命令；`/help <command>` 查看单个命令用法。                                             |
| `/clear`       | 清空本地 TUI transcript 视图。                                                             |
| `/compact`     | 对当前 session 历史做摘要压缩；缺少模型配置时会说明不可用原因。                            |
| `/init`        | 在当前项目创建轻量入口文件：`AGENTS.md` 和 `.pico/config.json`，不会覆盖已有 `AGENTS.md`。 |
| `/doctor`      | 检查 cwd、`.env`、provider、model、`LLM_BASE_URL`、`LLM_API_KEY[S]` 和 Node 版本。         |
| `/sessions`    | 列出当前项目可恢复 session。                                                               |
| `/resume`      | 输出指定 session 的恢复提示。                                                              |
| `/snapshots`   | 诊断性列出当前 session 的文件历史数据。                                                    |
| `/rewind`      | 打开用户消息选择器，按提示词/时间/文件变化恢复 code、conversation 或二者。                 |
| `/undo`        | `/rewind` 的兼容入口；同样打开用户消息选择器，不再走隐藏的直接回滚路径。                   |
| `/agents`      | 列出内置 Agent 和项目 `.claude/agents/*.md`。                                              |
| `/agent`       | 把任务委派给指定 Agent：`/agent <name> <task>`。                                           |
| `/tasks`       | 查看和控制当前 TUI 启动的隔离 worktree 任务。                                              |
| `/skills`      | 列出当前项目 `.claw/skills` 中可用 Skill。                                                 |
| `/skill`       | 显式激活 Skill 并交给 Agent 执行：`/skill <name> [arguments]`。                            |
| `/add-dir`     | 列出或添加当前会话可访问的工作目录：`/add-dir [directory]`。                               |

项目或用户自定义 Markdown 命令也会进入同一套 slash command registry。内置命令名优先保留，避免项目命令覆盖关键控制命令。

### 显式 Skill 激活

`/skill <name> [arguments]` 与动态的 `/<skill-name> [arguments]` 都会启动一次 Agent 请求，不再只是把 Skill 正文显示在本地。TUI 会先记录一条 `Skill activated` 事件，再把带来源、触发方式和参数的 Skill 指令作为用户请求交给模型。

Skill 正文支持 Claude Code 风格参数：`$ARGUMENTS` 保留完整参数，`$ARGUMENTS[0]` 与 `$0` 表示第一个参数；正文没有占位符时，参数会以 `ARGUMENTS: ...` 附在末尾。

### 附加工作目录

主 Agent 的路径权限按 mode 处理：

- `yolo`（默认）：按启动 Pico 的 OS 用户权限执行普通 Read/Write/Edit/Bash/网络操作，工作区外与敏感路径不弹日常审批。
- `default`：审批框显示目标和 diff，可选择 `Yes`、`Yes, allow … during this session` 或 `No`。`Yes` 只授权当前调用；session 选项才会把目录加入当前会话并对普通编辑切换为 `auto`。
- `plan`：只允许宿主能保守证明为只读的工具调用；审批不能放行 Bash 或 MCP 写操作。
- hardline 命令和显式 Hook deny 在任何 mode 下都不可通过审批绕过。

也可以在执行前手动加入目录：

```text
/add-dir /path/to/shared-directory
```

目录加入当前会话后，Read、Write、Edit、Glob、Grep、审批 diff 和文件历史会共享同一组工作区根。`/add-dir` 本身只更新当前会话，不修改配置文件。

启动时也可以重复传入 CLI 参数：

```bash
pico --add-dir ../shared --add-dir /absolute/generated
```

需要长期配置时，在项目的 `.pico/config.json` 中声明：

```json
{
  "permissions": {
    "additionalDirectories": ["../shared", "/absolute/generated"]
  }
}
```

配置中的相对路径以项目根目录为基准。附加目录只扩展文件工具的访问边界，不会从外部目录加载 `AGENTS.md`、hooks 或命令配置。

### 隔离任务

`/tasks` 管理由当前 TUI 启动的可写 worker。worker 总是进入独立 branch/worktree 和 OS 沙箱，完成后由宿主统一提交；这个边界不随主会话的 `yolo` 放开。

- `/tasks`：列出持久化的任务记录。
- `/tasks <task-id>` 和 `/tasks tail <task-id>`：查看状态与当前进程的有界输出。
- `/tasks message <task-id> <text>`：把补充指令放入队列，worker 在下一个安全排水点读取；目前不是实时 steer。
- `/tasks stop <task-id>`：发送 AbortSignal 并等待 runner 真正退出；超时时保持 `stopping`，不伪装成已停止。
- `/tasks retry|merge|cleanup <task-id>`：重试、串行合并或清理已合并的临时资源。

`.claw/tasks/state.json` 当前持久化的是任务账本，用于重启后查看历史和将遗留 `running` 任务明确收口为失败；它不会复活上一个 Node/LLM 进程。真正的跨重启 resume、冲突合并隔离和实时 message steer 已列入后续任务。

### 项目配置与键位

`.pico/config.json` 还可以设置项目命令目录和 TUI 键位：

Pico 首次打开一个工作区时会先显示信任确认。信任门通过前不会读取本项目配置、AGENTS / Skills 或 Session，也不会启动 LSP、MCP、Hook 和 Provider 发现。记录保存在用户目录 `~/.pico/trusted-workspaces.json`，项目本身不能声明已信任。

```json
{
  "version": 1,
  "commandsDir": ".pico/commands",
  "permissions": {
    "additionalDirectories": ["../shared"]
  },
  "keybindings": {
    "Global": {
      "ctrl+x": "app:exit",
      "ctrl+k": "command:/status"
    },
    "Chat": {
      "meta+enter": "input:newline"
    }
  }
}
```

模型工具由 Agent 按任务自动选择，并通过内部延迟披露机制按需加载；TUI 不提供 `/tools` 命令。MCP 连接状态使用 `/mcp`，审批策略使用 `/permissions`。

键位值可以是内置 action、`command:/...` slash command，或 `null` 用于解绑默认键。已知字段会在启动时严格校验，错误会带配置路径和字段名；`commandsDir` 必须保持在项目目录内。

工具卡默认用 `Ctrl+E` 展开或折叠，卡片右侧会显示完整提示；裸 `e` 保留给输入框。

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

当前 TUI 默认还会提供内置 Agent：`Explore`、`Plan`、`general-purpose`。项目级 `.claude/agents` 可以覆盖同名内置 Agent。

### `@` mentions

普通输入和 prompt command 输出都会先展开 `@` 引用，再交给模型：

- `@src/app.ts`：附加文件内容。
- `@src/app.ts#L10-40`：附加文件行号范围。
- `@"docs/design notes.md"`：引用包含空格的路径。
- `@docs`：附加目录清单。
- `@skill:review`：附加指定 Skill 正文。
- `@agent:tester`：提示优先使用子代理能力处理该 Agent 相关工作。

`@` 路径引用仍相对当前 `cwd` 解析并限制在主工作区内；`/add-dir` 扩展的是 Read、Write、Edit、Glob、Grep 等文件工具的访问根。

## 常见错误

### `.env` 缺失

开发命令如果写成 `--env-file=.env`，这个 `.env` 是相对当前 shell 所在目录解析的。在任意项目目录启动时，推荐使用绝对路径：

```bash
npx tsx --env-file=/path/to/pico-harness/.env /path/to/pico-harness/src/cli/main.ts
```

已安装的 `pico` 命令不会自动加载 `.env`，需要先在 shell 中设置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，或用外部工具加载环境变量。

### Provider 配置缺失

如果看到「缺少 Provider 配置」或 `/doctor` 显示 `LLM_BASE_URL`、`LLM_API_KEY[S]` missing，请检查：

- `LLM_BASE_URL` 是否已设置。
- `LLM_API_KEY` 或 `LLM_API_KEYS` 是否已设置。
- `LLM_MODEL` 是否符合当前 provider。
- `--provider`、`--model` 是否传给了正确入口，或环境变量是否已设置。

### 未知命令

未知 slash command 会显示 `Unknown slash command: /xxx`，并尽量给出 suggestions。请用 `/help` 查看内置命令，用 `/sessions`、`/agents`、`/skills` 查看当前项目加载到的动态能力。

如果自定义 `.claude/commands` 没出现，检查文件是否以 `.md` 结尾，路径名是否只包含字母、数字、下划线、短横线和子目录冒号映射所需的目录结构。

### 路径不在当前工作区

如果严格边界路径仍提示“请先运行 `/add-dir <directory>`”，可先执行 `/add-dir`，确认返回的 canonical path，再重试。普通主 Agent 文件调用会按当前 mode 自动授权或打开有效审批；复杂 `eval`、`python -c` 等动态 Bash 路径无法可靠静态提取，建议显式 `/add-dir`。

### Worktree 没有 `.env`

Git worktree 通常不会复制未跟踪的 `.env`。如果你在 `.worktrees/...` 内运行 `npm run dev`，而该 worktree 没有自己的 `.env`，启动会缺少模型配置。可选做法：

- 在 worktree 中复制一份 `.env`。
- 使用 `--env-file=/主仓库绝对路径/.env`。
- 直接在 shell 中导出 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。
