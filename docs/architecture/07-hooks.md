# Hooks 运行时与配置边界

Pico 前台会话使用会话级 `HookService`。一次事件调度会固定捕获当前不可变 snapshot；配置热重载只会影响后续事件，不会中途改变在途 handler 集合。

## 配置来源

默认加载顺序是：

1. `$PICO_HOME/hooks.json`（用户级，默认 `~/.pico/hooks.json`）
2. `<workspace>/.pico/hooks.json`（可跟踪项目级）
3. 旧版本本机 Hook 文件（兼容读取）
4. 旧版本 settings 中的 hooks（legacy，只读兼容）

Skill/Agent frontmatter 的 `hooks` 会在组件激活时作为内联 component source 原子加入，当前 Agent run 结束后卸载。`managed` 与 `plugin` 来源由宿主冻结的受信 Runtime Catalog 显式提供，Hook loader 不自行发现或启用扩展。

Canonical JSON 形状是 `event → matcher group → handlers`，`timeout` 单位是秒。Legacy `settings.json` 仍以毫秒解析，避免旧配置被意外放大超时。Canonical 某个 source 中出现未知事件、handler、非法 regex 或条件路径时，整个 source 被隔离，其他 source 仍可加载。

## Handler 与信任

前台支持 `command`、`http`、`mcp_tool`、`prompt` 和 `agent` 五类 handler。`command/http/mcp_tool` 在首次出现时为 `pending`，不会被调度。用户确认后，信任记录写入 `$PICO_HOME/trusted-hooks.json`（默认 `~/.pico/trusted-hooks.json`），并同时绑定：

- 真实工作区路径；
- 来源类型与真实配置路径；
- 规范化 handler 定义哈希；
- command 引用的现有脚本真实路径与字节哈希；
- 实际可执行文件及一级 Shebang 解释器的 inode、权限、owner、大小与纳秒级时间元数据。

`command` 使用受限 exec-form 静态语法，信任解析和执行共用同一个已授权 invocation：argv 与清理后的环境不再重算；实际 `spawn(shell:false)` 使用解析时选中的绝对 logical executable，从而保留 Python virtualenv 等依赖别名路径的运行时语义，同时把它当时指向的 canonical executable 及解释器身份写入指纹。Shell 组合/展开、package runner、命令转发器、未知外部 executable、Node 动态入口与未审计选项都不能建立信任。Node 与已审计文件解释器绑定普通文件入口；工作区 executable 还会保守绑定 argv 中可见的现有普通文件。短生命周期 handler 主动关闭 stdin 时，`EPIPE`、`ECONNRESET` 或已销毁 stream 只表示输入管道不再需要，最终仍由进程退出码和协议输出决定；其他 stdin 错误会终止进程树。

POSIX Shebang 必须是 LF 行尾、绝对解释器路径且不带参数；只允许一级，解释器自身仍为脚本、使用 `env` 等转发器、形成循环或名称触发特殊 argv0 语义时拒绝。Windows 保持 `shell:false`，因此可信入口只接受可直接启动的 `.exe`，不把 `.bat/.cmd` 隐式交给 shell。

执行环境会移除动态 loader、OpenSSL、Shell 启动、Node、Python、Ruby、Perl 与用户配置路径中的代码加载入口；Python 额外固定禁用 user site 和字节码写入，zsh/fish 的用户配置根固定到空配置根 `/dev/null`。handler 自带环境不能重新覆盖这些字段或 `PATH/PATHEXT`。

定义、入口、可见文件参数或 executable 元数据变更后回到 `pending`。解析结果保留顶层 executable、入口、loader、工作区文件参数及一级 Shebang 解释器的全部 logical↔canonical binding，并为受信引用保存有界 SHA-256。每个 command handler 在实际 spawn 前重新生成一次指纹并取得与该指纹对应的 exact invocation，随后复核全部路径映射、引用字节哈希和 executable identity，不复用事件开始时的旧结论，也不在 executor 内重新做 PATH 选择。信任目录/文件分别使用 `0700`/`0600`，拒绝符号链接，写入采用同目录原子 rename。

该信任层不是进程沙箱。脚本内部按运行时逻辑加载的间接模块、固定配置、子命令、系统级启动配置和动态库不会递归指纹化；Node 没有可移植的 exec-by-handle，因而最后一次 `realpath/lstat` 复核到 `spawn` 之间仍有同一用户可利用的 OS 调度级 TOCTOU 窗口。需要这些来源可审计时，应改为直接文件入口或把依赖显式纳入受信脚本内容。

## 热重载

`HookConfigReloader` 使用同一个 `HookTrustStore` 及其受控环境解析引用，并监视所有 binding 的 logical/canonical 两端所在父目录，不递归监视整个工作区。Debounce 后先完整解析候选 snapshot；解析失败则保留旧 snapshot。候选 watcher 以 generation 和对象身份隔离，未发布候选的迟到事件不能影响活跃 snapshot；被拒绝或过期的候选会吸收异步失败并有界停止。集成层通过 `beforeSwap` 使用旧 snapshot 发送 `ConfigChange`，只在放行后交换；会话关闭采用有界收口，不被平台 watcher 的永久 pending 拖住。执行授权不依赖 watcher 是否捕获到事件。

## `/hookify` 与 `/hooks`

Hookify 只生成 `<workspace>/.pico/hookify.<slug>.local.md` 受限规则；同名旧版本规则仅兼容读取：

- event：`bash | file | prompt | stop | all`；
- action：`warn | block`；
- condition：`regex | contains | equals`。

规则不能承载 Shell。`/hookify` 先展示完整 diff，再由 `confirm/cancel` 显式收口；`yolo` 模式也不例外。`/hooks` 无参打开独立管理 dialog，支持审查、双击确认信任、启停和重载；无头子命令仍保留。两者都只接收 handler id，不接收任意命令字符串。

## MCP 与异步回唤

MCP 仅在 TUI 提供完整表单宿主时协商 `2025-06-18` form elicitation；legacy SSE、无 UI 和后台均不声明。表单会显示 server 身份，区分 accept/decline/cancel，拒绝疑似密码或 token 字段，并按 `Elicitation → UI → ElicitationResult` 派发。

`command.asyncRewake` 完成后进入会话有界队列；运行中不并发启动第二个 Engine，TUI 空闲后通过同一 QueryGuard 合并续跑。会话关闭后迟到回调会被丢弃。

## 前后台边界

后台/Cron 仍使用独立 strict runner：只支持 legacy `command` Hook，故障 fail-closed，遇到其他 handler 显式拒绝启动。Hook 网络遵循 Job 创建时冻结的工具网络策略；新建自然语言任务默认 `allow`，旧 Job 的 `disabled` / `allowlist` 不迁移。前台的 fail-open 和五类 handler 不得被悄然带入后台。
