# Plugin scope 物理边界契约

当前插件生命周期使用 `PluginScope = user | project | local`，物理根目录由
`resolvePluginScopeRoots(workDir, options)` 唯一计算：

| scope     | 当前 workspace 的物理根目录           | 优先级 |
| --------- | ------------------------------------- | -----: |
| `user`    | `$PICO_HOME/plugins`                  |      1 |
| `project` | `<canonical-workspace>/.pico/plugins` |      2 |
| `local`   | `<canonical-workspace>/.claw/plugins` |      3 |

`canonical-workspace` 由 `resolvePicoPaths()` 通过 `realpath`（目录尚不存在时使用规范化绝对路径）得到。`PluginManager` 会把外部来源复制到对应 scope 的 managed root，先校验完整资源指纹，再写入对应 registry；运行时快照还会复制到 host-private runtime tree。scope 不能绕过信任或路径校验。

## 当前明确的边界

- `project` 和 `local` 是当前工作区的项目/本地覆盖层，不能被另一个工作区读取。
- `user` 的物理目录和 registry 位于 `$PICO_HOME/plugins` 与 `$PICO_HOME/plugins.json`，跨工作区共享；`project`/`local` 的 registry 仍位于当前 workspace 的 `$PICO_HOME/workspaces/<workspace-id>/plugins.json`。user scope 是设备级本地 registry，不等于公开 marketplace。
- 同一插件 ID 的有效 winner 按 `local > project > user` 选择；高优先级层若未信任、已变更或 materialization 失败，不回退到低优先级层。
- `installPath` 必须位于声明的 managed scope root 内；外部来源只用于一次受校验的复制，冲突 fingerprint 不会静默覆盖。运行时只使用经过指纹校验的 host-private copy；copy dispose 后其 Hook authority 立即失效。

## 兼容与迁移

旧 workspace registry 中的 user 条目仍会被读取并参与合并，新的 user 安装统一写入 `$PICO_HOME/plugins.json`。后续可在不改变运行时事实源的前提下清理旧条目；并发写入继续由原子 JSON 写入边界负责。
