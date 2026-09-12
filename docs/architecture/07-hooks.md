# Hooks 运行时与配置边界

Pico 前台会话使用会话级 `HookService`。一次事件调度会固定捕获当前不可变 snapshot；配置热重载只会影响后续事件，不会中途改变在途 handler 集合。

## 配置来源

默认加载顺序是：

1. `$PICO_HOME/hooks.json`（用户级，默认 `~/.pico/hooks.json`）
2. `<workspace>/.pico/hooks.json`（可跟踪项目级）

Skill/Agent frontmatter 的 `hooks` 会在组件激活时作为内联 component source 原子加入，当前 Agent run 结束后卸载。`managed` 与 `plugin` 来源由宿主冻结的受信 Runtime Catalog 显式提供，Hook loader 不自行发现或启用扩展。

Canonical JSON 形状是 `event → matcher group → handlers`，`timeout` 单位是秒。某个 source 中出现未知事件、handler、字段、非法 regex 或条件路径时，整个 source 被隔离，其他 source 仍可加载。历史 `.claw/hooks.local.json`、`.claw/settings.json` 及 `{ "hooks": ... }` settings wrapper 均不读取、不迁移；由 Claude 兼容资源目录加载的 Skill/Agent 仍可通过上述 component source 边界提供 hooks。

## Handler 与信任

前台支持 `command`、`http`、`mcp_tool`、`prompt` 和 `agent` 五类 handler。`command/http/mcp_tool` 在首次出现时为 `pending`，不会被调度。用户确认后，v2 信任记录写入 `$PICO_HOME/trusted-hooks.json`（默认 `~/.pico/trusted-hooks.json`），并同时绑定：

- 真实工作区路径；
- 来源类型、真实配置路径与可选组件 ID；
- 规范化 handler 定义哈希。

`command` 是由用户确认的 Shell 命令字符串；POSIX 选择 `bash`/`sh`，Windows 前台按运行边界选择 Git Bash 或 PowerShell，AppContainer 下跳过 Git Bash。运行时显式启动选定的 Shell（`spawn(shell:false)`）并把命令作为 `-c`/`-Command` 参数传入；配置存在 `args` 时按对应 Shell 方言逐词引用。短生命周期 handler 主动关闭 stdin 时，`EPIPE`、`ECONNRESET` 或已销毁 stream 只表示输入管道不再需要，最终仍由进程退出码和协议输出决定；其他 stdin 错误会终止进程树。

信任指纹不绑定 Shell 选择，也不递归钉死命令引用的可执行文件或脚本字节；这里的授权边界是工作区信任、来源和完整 handler 定义。每次执行前会重新计算当前定义指纹，`command` 还会从信任权威取得对应 invocation；工作区信任撤销、来源或定义变化都会使 handler 回到 `pending`。旧 v1 `trusted-hooks.json`（含 `scriptHashes`）会明确报 schema 无效，不会被原地升级或剪除；用户需先归档或移除旧文件，再重新审查当前 handler。

执行环境会移除动态 loader、OpenSSL、Shell 启动、Node、Python、Ruby、Perl 与用户配置路径中的代码加载入口；Python 额外固定禁用 user site 和字节码写入，zsh/fish 的用户配置根固定到空配置根 `/dev/null`。handler 自带环境可以显式覆盖普通变量（包括 `PATH/PATHEXT`），但不能恢复全局禁用的注入字段。

信任目录/文件分别使用 `0700`/`0600`，拒绝符号链接，写入采用同目录原子 rename。该信任层不是进程沙箱；命令仍由统一进程沙箱和网络策略约束，动态加载与 Shell/语言运行时注入环境会被清理，handler 明示环境也不能恢复全局禁用项。

## 热重载

`HookConfigReloader` 监视已知配置、信任、本地状态与 Hookify 文件的父目录，不递归监视整个工作区，并用文件指纹轮询补偿 `fs.watch` 的有损通知。Debounce 后先完整解析候选 snapshot；解析失败则保留旧 snapshot。候选 watcher 以 generation 和对象身份隔离，未发布候选的迟到事件不能影响活跃 snapshot；被拒绝或过期的候选会吸收异步失败并有界停止。集成层通过 `beforeSwap` 使用旧 snapshot 发送 `ConfigChange`，只在放行后交换；会话关闭采用有界收口，不被平台 watcher 的永久 pending 拖住。执行授权不依赖 watcher 是否捕获到事件。

## `/hookify` 与 `/hooks`

Hookify 只生成并读取 `<workspace>/.pico/hookify.<slug>.local.md` 受限规则：

- event：`bash | file | prompt | stop | all`；
- action：`warn | block`；
- condition：`regex | contains | equals`。

规则不能承载 Shell。`/hookify` 先展示完整 diff，再由 `confirm/cancel` 显式收口；`full-access` 模式也不例外。`/hooks` 无参打开独立管理 dialog，支持审查、双击确认信任、启停和重载；无头子命令仍保留。两者都只接收 handler id，不接收任意命令字符串。

## MCP 与异步回唤

MCP 仅在 TUI 提供完整表单宿主时协商 `2025-06-18` form elicitation；legacy SSE、无 UI 和后台均不声明。表单会显示 server 身份，区分 accept/decline/cancel，拒绝疑似密码或 token 字段，并按 `Elicitation → UI → ElicitationResult` 派发。

`command.asyncRewake` 完成后进入会话有界队列；运行中不并发启动第二个 Engine，TUI 空闲后通过同一 QueryGuard 合并续跑。会话关闭后迟到回调会被丢弃。

## 前后台边界

后台/Cron 仍使用独立 strict runner：从当前 `<workspace>/.pico/hooks.json` 读取 canonical 配置，只接受工具事件中的 `command` handler 及其受限字段，配置、信任、启动、超时或输出异常均 fail-closed，其他 handler 会显式拒绝启动。Hook 网络遵循 Job 创建时冻结的工具网络策略；新建自然语言任务默认 `allow`，旧 Job 的 `disabled` / `allowlist` 不迁移。前台的 fail-open 和五类 handler 不得被悄然带入后台。
