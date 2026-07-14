# Hooks 运行时与配置边界

Pico 前台会话使用会话级 `HookService`。一次事件调度会固定捕获当前不可变 snapshot；配置热重载只会影响后续事件，不会中途改变在途 handler 集合。

## 配置来源

默认加载顺序是：

1. `~/.pico/hooks.json`（用户级）
2. `<workspace>/.pico/hooks.json`（可跟踪项目级）
3. `<workspace>/.claw/hooks.local.json`（本机级）
4. `<workspace>/.claw/settings.json#hooks`（legacy，只读兼容）

Skill/Agent frontmatter 可以由宿主作为显式 component source 注入，只在组件活跃期生效。`managed` 与 `plugin` 来源也保留扩展口，但 Pico 不自动发现它们，也不因此恢复公开 Plugin runtime。

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

规则不能承载 Shell。提案 API 返回完整 diff，并且写入 API 无条件调用宿主确认回调；`yolo` 模式也不例外。`HookManagementService` 为 `/hooks list/review/trust/enable/disable/reload` 提供无头 domain API，只接收 handler id，不接收任意命令字符串。TUI 面板由宿主使用现有 AskUser/审批 dialog 组合，该 domain 不修改主 layout 或审批面板。

## 前后台边界

后台/Cron 仍使用现有独立 strict runner：只支持 legacy `command` Hook，网络关闭，故障 fail-closed，遇到其他 handler 显式拒绝启动。前台的 fail-open 和五类 handler 不得被悄然带入后台。
