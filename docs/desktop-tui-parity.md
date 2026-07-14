# Pico Desktop 与 TUI 入口一致性规范

本文是 Pico Desktop 会话化改造的可验收入口映射。Desktop 是 TUI/Runtime 的图形宿主，不创建第二套任务、Session 或运行控制语义。

## 事实来源与术语

- TUI 命令及其可用状态以 [`src/input/pico-command-registry.ts`](../src/input/pico-command-registry.ts) 和 [`src/input/command-availability.ts`](../src/input/command-availability.ts) 为准。
- 运行中输入路由以 [`src/tui/repl.tsx`](../src/tui/repl.tsx) 为准：普通输入默认 Steer，`/queue` 排入下一轮，`/replace` 中断并替换，`/interrupt` 中断并清空队列。
- Session 持久化和恢复以 [`src/engine/session.ts`](../src/engine/session.ts)、[`src/tui/session-hydration.ts`](../src/tui/session-hydration.ts) 为准。
- 当前 Desktop 路由与能力缺口以 [`apps/desktop/src/renderer/App.tsx`](../apps/desktop/src/renderer/App.tsx)、[`apps/desktop/src/renderer/runtime.ts`](../apps/desktop/src/renderer/runtime.ts) 和 [`packages/protocol/src/runtime.ts`](../packages/protocol/src/runtime.ts) 为准。

本文使用以下入口等级：

- **主路径**：普通用户无需记忆命令即可发现和完成。
- **高级入口**：通过 Composer 的 Slash 补全、命令面板或低频菜单进入；必须调用同一 Runtime 能力。
- **暂不适用**：属于 TUI 进程或终端显示管理，不在 Desktop 复制同名行为；需给出桌面等价行为。

所有入口都遵守 TUI 可用状态：`idle` 仅在当前 Session 无活动 Run 时可操作，`running` 仅在运行中可操作，`always` 在无模态交互遮挡时可操作；审批、Ask User 或其他模态打开时禁止触发新的命令。

## 产品结构

```text
Workspace
└── Session（Desktop 中的一项对话）
    ├── Turn / Run 1
    │   └── Transcript Items
    ├── Turn / Run 2
    └── Child Session（Subagent）
```

- 点击“新任务”只进入空白对话和 Composer；首次发送时创建 Session 与首轮 Run。
- Run 完成后仍停留在 `/session/:sessionId`，下一次发送复用同一 Session。
- Plan、工具、审批、Ask User、Changes、Goal 和子代理均为 Transcript 条目或其详情面板，不是独立任务仪表盘。
- Slash 命令是图形能力的键盘入口，不得在 Renderer 中解析成另一套业务逻辑。

## 会话与工作区入口

| TUI 入口                       | TUI 行为与状态                                                   | Desktop 等价入口                                                                                                | 等级     | 验收标准                                                                                    |
| ------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `/status`                      | 展示当前 Session 设置、内存后端和 MCP 摘要；`always`             | 会话标题栏的状态按钮打开只读 Popover；展示 Workspace、Session、模型、模式、Thinking、授权目录、Runtime/MCP 状态 | 主路径   | 状态来自当前 Session 和 Runtime；切换 Session 后不残留上一个 Session 的值                   |
| `/goal`                        | 展示当前长期目标；无参数；`always`                               | 有活动 Goal 时在 Composer 上方显示进度行，点击打开 Goal 详情；无 Goal 时不伪造默认目标                          | 主路径   | Goal 更新作为当前 Session 的结构化事件实时刷新；详情与 TUI `GoalManager` 一致               |
| `/compact`                     | 调用摘要模型压缩当前 Session；`idle`                             | 会话标题菜单“压缩上下文”，显示二次确认、执行进度和压缩结果                                                      | 高级入口 | 运行中禁用；失败显示 Runtime 原因；成功后刷新 Transcript revision，不删除可恢复 Session     |
| `/init`                        | 在 Workspace 创建轻量 Pico 项目入口文件并触发 Setup Hook；`idle` | Workspace 菜单“初始化 Pico 项目”                                                                                | 高级入口 | 运行中禁用；显示将写入的 Workspace；完成消息进入当前 Transcript；不得在 Renderer 直接写文件 |
| `/doctor`、`/doctor resources` | 只读诊断配置或资源；`idle`                                       | 设置 → 诊断，提供“运行诊断”和“扫描资源”两个操作                                                                 | 高级入口 | 结果保留结构化状态和原始诊断文本；扫描不触发 Catalog 修复、GC 或其他写操作                  |
| `/sessions`                    | 列出当前项目可恢复 Session 并打开选择器；`idle`                  | 左侧项目树和“所有会话”页面                                                                                      | 主路径   | 只展示当前 Workspace 的 Session；支持搜索、归档筛选和明确的当前会话标记                     |
| `/rename <title>`              | 重命名当前 Session；`idle`                                       | 点击会话标题或标题菜单“重命名”                                                                                  | 主路径   | 空标题拒绝；成功后侧栏、标题栏和持久化目录同步更新                                          |
| `/resume <session-id>`         | 切换到已有 Session；`idle`                                       | 点击侧栏或会话库中的会话，导航到 `/session/:sessionId`                                                          | 主路径   | 加载对应 Transcript、当前 Run 和待处理交互；不存在时显示可恢复错误，不回到首页冒充成功      |
| `/fork <session-id>`           | 从已保存 Session 创建分支并切换；`idle`                          | 会话标题菜单或历史行菜单“从此会话创建分支”                                                                      | 高级入口 | 新 Session 保留来源关系但拥有独立 ID、Transcript revision 和后续历史；原 Session 不变       |

## Composer、模型与权限入口

| TUI 入口                                   | TUI 行为与状态                                          | Desktop 等价入口                                                   | 等级   | 验收标准                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `/model [name]`                            | 查看或切换模型路由；`idle`                              | Composer 底栏模型选择器                                            | 主路径 | 选项来自 Runtime 模型路由；切换只影响当前 Session；运行中禁用并说明原因                                            |
| `/mode <default\|plan\|auto\|yolo>`        | 查看或切换交互模式；`idle`                              | Composer 底栏模式选择器                                            | 主路径 | 四种模式与 TUI 值一一对应；变更持久化到当前 Session，不能仅改 Renderer 状态                                        |
| `/permissions [default\|auto\|yolo\|plan]` | `/mode` 的权限语义别名；`idle`                          | Composer 底栏权限/访问级别按钮，打开的仍是同一个模式选择器         | 主路径 | Desktop 不维护第二个 permission mode；从任一入口修改后，模式和权限文案立即一致                                     |
| `/thinking [level]`                        | 查看或切换当前模型支持的推理强度；`idle`                | Composer 底栏 Thinking 选择器                                      | 主路径 | 仅显示当前模型路由支持的级别；切换模型后重新校验，不保留非法旧值                                                   |
| `/skill <name> [arguments]`                | 激活 Skill 并作为 Prompt 启动 Agent；`idle`             | Composer “+”菜单 → Skill，选择后插入结构化 Skill 引用及可编辑参数  | 主路径 | Skill 身份不退化为普通文本；发送遵循首次创建或空闲续聊语义；运行中禁用                                             |
| `/agent <name> <task>`                     | 将指定 Agent 资料渲染为委派 Prompt；无显式 availability | Composer “+”菜单 → Subagent，选择 Agent 后在同一 Composer 描述任务 | 主路径 | Agent 选项来自同一 Catalog；提交后主 Transcript 显示委派条目，子 Session 在右侧详情打开；运行中提交遵循 Steer 语义 |

Composer 仍保留 Slash 自动补全作为上述能力的高级等价入口。图形入口和 Slash 入口必须调用同一领域接口；不得通过拼接 `/model ...` 等文本绕过类型化协议。

## 运行中输入与控制

| TUI 行为            | Desktop Composer 行为                                            | 等级     | 验收标准                                                                              |
| ------------------- | ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| 普通输入（运行中）  | 发送按钮默认标记为“调整当前运行”，提交为 Steer                   | 主路径   | 输入追加到当前 Run 的下一个模型边界；携带 `expectedRunId`，Run 已切换时拒绝错投       |
| `/steer <guidance>` | 发送菜单“调整当前运行”                                           | 主路径   | 用户消息立即进入当前 Session Transcript；Runtime 接受后显示待应用状态，不能伪报已生效 |
| `/queue <prompt>`   | 发送菜单“排到下一轮”；待发消息显示在 Composer 上方，可编辑或删除 | 主路径   | 当前 Run 完成后恰好启动一次新 Run；App/daemon 重启后队列仍可恢复                      |
| `/replace <prompt>` | 发送菜单“停止并替换”，提交前明确会清空既有排队输入               | 高级入口 | 请求中断当前 Run，待其进入终态后启动替代输入；旧队列被清除并显示数量                  |
| `/interrupt`        | 标题栏/Composer 的停止按钮                                       | 主路径   | 中断当前 Run、清空 Steer 和 Queue；审批、Ask User 等待态同时关闭；中断不显示为失败    |

运行中禁止图片附件，与当前 TUI 行为一致；UI 应保留草稿并提示在运行结束后发送，而不是静默丢弃。运行中不允许执行的 `idle` 命令在 Slash 列表中可见但禁用，并显示“当前运行结束后可用”。

## Changes、Snapshots 与 Rewind

| TUI 入口                | TUI 行为与状态                                   | Desktop 等价入口                                          | 等级     | 验收标准                                                                                            |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `/snapshots`            | 列出当前 Session 的消息检查点；`idle`            | 会话标题菜单“版本历史”，打开右侧 Changes 面板的检查点列表 | 高级入口 | 仅展示当前 Session；标出用户消息、时间、文件摘要和 legacy 状态                                      |
| `/changes [message-id]` | 打开指定或最近检查点的单文件部分回退预览；`idle` | Transcript 的文件修改条目“Review”，以及右侧 Changes 面板  | 主路径   | 默认定位触发它的消息检查点；Diff、文件列表与 TUI File History 数据一致                              |
| `/rewind`               | 打开代码与对话检查点回退菜单；`idle`             | Changes 面板中的“Rewind 到这里”                           | 高级入口 | 执行前展示会截断的对话和文件；文件指纹变化时 fail-closed；成功后旧 Transcript cursor 失效并重新加载 |

`Changes` 是 Session Transcript 的详情，不是跨 Session 的全局变更页。全局 `/review` 页面可以聚合待审内容，但进入审阅时必须携带并展示所属 Session，不能使用 `data.runs[0]` 推断目标。

## MCP、Skills、Subagents 与 Automations

| TUI 入口                 | TUI 行为与状态                                   | Desktop 等价入口                                     | 等级                                               | 验收标准                                                                      |
| ------------------------ | ------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/mcp`                   | 查看 MCP 配置、连接状态和工具摘要；默认 `always` | 侧栏 MCP 页面                                        | 主路径                                             | 显示 config path、连接/失败/禁用数量、各 Server transport、错误和工具数       |
| `/mcp reload             | enable                                           | disable                                              | reconnect                                          | auth`                                                                         | 管理 Server 生命周期                                                                  | MCP Server 行内菜单                                               | 主路径                                                      | 每项操作展示进行中和真实失败；认证由 Main/daemon 安全流程完成，Renderer 不接触密钥 |
| `/mcp resources          | read                                             | prompts                                              | prompt`                                            | 浏览资源和 Prompt，并读取/实例化内容                                          | MCP Server 详情页的 Resources 与 Prompts 标签                                         | 高级入口                                                          | JSON 参数在提交前校验；响应可插入 Composer，但不会自动发送  |
| `/skills`                | 列出 Loader 发现的 Skills；`idle`                | 侧栏 Skills 页面                                     | 主路径                                             | 与 TUI 使用相同来源和禁用原因；刷新后不展示演示数据                           |
| `/agents`                | 列出 Agent Catalog；`idle`                       | Composer 的 Subagent 选择器和右侧 Subagents 面板空态 | 主路径                                             | 展示名称、来源、说明、允许工具和模型路由；不能把“多 Agent”绑定为 Git 前置条件 |
| `/cron status            | list                                             | runs`                                                | 查看 Workspace 后台任务、daemon 和运行历史；`idle` | 侧栏 Automations 页面                                                         | 主路径                                                                                | 数据按 Workspace 隔离；后台 daemon 不可用时显示“已保存但不会运行” |
| `/cron add               | enable                                           | disable                                              | delete`                                            | 管理持久 YOLO Cron；`idle`                                                    | Automations 新建/编辑/启停/删除操作                                                   | 主路径                                                            | 新建明确要求 YOLO、时区和工具网络策略；版本冲突不得覆盖更新 |
| `/cron credential status | import`                                          | 检查或导入后台 Provider 凭证                         | Automation Provider 设置                           | 高级入口                                                                      | 仅处理 `credentialRef`；legacy 环境变量路由不可用于持久 Cron；Renderer 不读取 API Key |

## 补充注册入口

这些入口也存在于当前 Registry，但不应改变本轮会话化主模型。

| TUI 入口                | Desktop 处理                                                         | 等级     |
| ----------------------- | -------------------------------------------------------------------- | -------- |
| `/usage`                | 侧栏 Usage 页面；当前 Session 可从状态 Popover 打开本次用量          | 主路径   |
| `/context`              | 状态 Popover 的 Context 区域展示预算、能力和覆盖信息                 | 主路径   |
| `/add-dir`              | Workspace 设置中的“添加授权目录”文件夹选择器                         | 高级入口 |
| `/plugin`               | Plugins 未开放前保留高级入口并明确不可用原因；不得提供虚假安装操作   | 高级入口 |
| `/help`                 | Composer Slash 补全和快捷键/命令面板帮助                             | 高级入口 |
| `/clear`                | 不清除持久 Session；只允许“新建会话”或明确的本地视图过滤重置         | 暂不适用 |
| `/exit`                 | 使用系统窗口关闭与“退出 Pico”菜单；后台运行行为由 Desktop 设置决定   | 暂不适用 |
| 项目/用户 Markdown 命令 | Composer Slash 补全按 Registry source 分组，执行后仍进入当前 Session | 高级入口 |

## 当前 Desktop 差距与验收顺序

当前 Desktop 已有 `/task/new`、`/task/:runId`、`/sessions`、`/automations`、`/skills`、`/mcp`、`/providers`、`/usage` 和 `/settings`，但其主链仍是“任务描述表单 → `run.start` → Run 仪表盘”，不满足本规范。实现时按以下顺序验收：

1. 用 `/session/:sessionId`、连续 Transcript 和固定 Composer 替代 Run 主页面；旧 `/task/:runId` 只做兼容定位。
2. 接通首次发送、空闲续聊、Steer、Queue、Replace、Interrupt，并以 Session 隔离所有事件。
3. 接入模型、模式、Thinking、Skill、Agent 和审批等 Composer 主路径。
4. 接入 Session 管理、Changes/Rewind、MCP、Skills、Automations 和诊断等详情入口。
5. 最后保留 Slash/命令面板作为高级等价入口，验证图形入口与命令入口结果一致。

完成标准不是“页面或按钮存在”，而是对应操作已调用 Runtime 的同一能力、更新同一 Session 真源，并在重连和恢复后保持一致。
