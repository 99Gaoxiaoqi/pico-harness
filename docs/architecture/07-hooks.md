# Hooks 运行时与配置边界

Pico 前台会话使用会话级 `HookService`。一次事件调度会固定捕获当前不可变 snapshot；配置热重载只会影响后续事件，不会中途改变在途 handler 集合。

## 配置来源

默认加载顺序是：

1. `~/.pico/hooks.json`（用户级）
2. `<workspace>/.pico/hooks.json`（可跟踪项目级）
3. `<workspace>/.claw/hooks.local.json`（本机级）
4. `<workspace>/.claw/settings.json#hooks`（legacy，只读兼容）

Skill/Agent frontmatter 的 `hooks` 会在组件激活时作为内联 component source 原子加入，当前 Agent run 结束后卸载。`managed` 与 `plugin` 来源仅保留显式扩展口，不恢复公开 Plugin runtime。

Canonical JSON 形状是 `event → matcher group → handlers`，`timeout` 单位是秒。Legacy `settings.json` 仍以毫秒解析，避免旧配置被意外放大超时。Canonical 某个 source 中出现未知事件、handler、非法 regex 或条件路径时，整个 source 被隔离，其他 source 仍可加载。

## Handler 与信任

前台支持 `command`、`http`、`mcp_tool`、`prompt` 和 `agent` 五类 handler。`command/http/mcp_tool` 在首次出现时为 `pending`，不会被调度。用户确认后，信任记录写入 `~/.pico/trusted-hooks.json`，并同时绑定：

- 真实工作区路径；
- 来源类型与真实配置路径；
- 规范化 handler 定义哈希；
- command 引用的现有脚本真实路径与字节哈希。

定义或脚本字节变更后立即回到 `pending`。信任目录/文件分别使用 `0700`/`0600`，拒绝符号链接，写入采用同目录原子 rename。

## 热重载

`HookConfigReloader` 只监视已知配置与引用脚本的父目录，不递归监视整个工作区。Debounce 后先完整解析候选 snapshot；解析失败则保留旧 snapshot。集成层应通过 `beforeSwap` 使用旧 snapshot 发送 `ConfigChange`，只在放行后交换。

## `/hookify` 与 `/hooks`

Hookify 只生成 `.claw/hookify.<slug>.local.md` 受限规则：

- event：`bash | file | prompt | stop | all`；
- action：`warn | block`；
- condition：`regex | contains | equals`。

规则不能承载 Shell。`/hookify` 先展示完整 diff，再由 `confirm/cancel` 显式收口；`yolo` 模式也不例外。`/hooks` 无参打开独立管理 dialog，支持审查、双击确认信任、启停和重载；无头子命令仍保留。两者都只接收 handler id，不接收任意命令字符串。

## MCP 与异步回唤

MCP 仅在 TUI 提供完整表单宿主时协商 `2025-06-18` form elicitation；legacy SSE、无 UI 和后台均不声明。表单会显示 server 身份，区分 accept/decline/cancel，拒绝疑似密码或 token 字段，并按 `Elicitation → UI → ElicitationResult` 派发。

`command.asyncRewake` 完成后进入会话有界队列；运行中不并发启动第二个 Engine，TUI 空闲后通过同一 QueryGuard 合并续跑。会话关闭后迟到回调会被丢弃。

## 前后台边界

后台/Cron 仍使用现有独立 strict runner：只支持 legacy `command` Hook，网络关闭，故障 fail-closed，遇到其他 handler 显式拒绝启动。前台的 fail-open 和五类 handler 不得被悄然带入后台。
