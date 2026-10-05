# pico-harness 文档

从使用、架构或教程入口开始阅读。文档与实现冲突时，以代码、测试和已实施的架构决策为准；目标规格和历史记录不代表当前已完成能力。

## 使用与开发

| 入口                                                                                        | 内容                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [快速开始](../README.md#快速开始) · [部署与运行](guides/deployment.md)                      | 安装、模型配置、TUI/Desktop 启动和数据位置 |
| [系统架构](../ARCHITECTURE.md) · [架构导航](architecture/00-overview.md)                    | 系统边界、模块地图与状态所有权             |
| [Desktop 架构](guides/desktop-architecture.md) · [Desktop 发布](guides/desktop-release.md)  | 桌面进程边界、打包与发布                   |
| [移动端](../apps/mobile/README.md) · [公网直连](remote/mobile-direct.md)                    | 手机应用、连接方式与验收范围               |
| [桌面 Relay](remote/desktop-relay.md) · [Relay 部署](remote/relay-deployment.md)            | 中转连接与服务部署                         |
| [进程沙箱](guides/process-sandbox.md) · [本机 IPC 安全](architecture/local-ipc-security.md) | 权限模式、受控执行与本机信任边界           |
| [测试指南](../tests/README.md) · [工程脚本](../scripts/README.md)                           | 选择验证范围与运行检查                     |
| [内部 Headless Runner](guides/internal-headless-one-shot.md)                                | 仓库评测入口，非公开服务 API               |
| [产品设计原则](design/product.md) · [冻结交互原型](design/prototypes/full-flow/README.md)   | 产品设计约束与目标交互参考                 |

## 技术博客

| 文章                                                                      | 主题                                 |
| ------------------------------------------------------------------------- | ------------------------------------ |
| [从一句话到一次可靠执行](guides/pico-harness-architecture-guide-image.md) | 从前台输入到模型、工具和持久状态     |
| [上下文压缩](pico-context-compaction-technical-guide.md)                  | 真实用量触发、安全切点、摘要与归档   |
| [长期记忆](pico-memory-technical-guide.md)                                | 用户证据、原子记忆、事务恢复与召回   |
| [子智能体](pico-subagents-technical-guide.md)                             | 子任务配置、持久会话、权限继承与续用 |
| [课程 00–10](#课程式构建记录)                                             | 从基础循环到完整 Harness             |

[执行架构图](readme-assets/current/runtime.png)（[交互版](readme-assets/current/runtime.html) · [图源](readme-assets/current/runtime.json)）
· [阅读路线图](readme-assets/current/reading.png)（[交互版](readme-assets/current/reading.html) · [图源](readme-assets/current/reading.json)）。

博客最近一次集中核对的范围与依据见[2026-09-21 核对记录](blog-code-consistency-audit.md)，不能据此推定后续改动均已同步。

## 架构与专题

[系统架构](../ARCHITECTURE.md)是当前边界入口：TUI/Desktop 共用本机 daemon；工作区事实存于 `pico.sqlite`，长期记忆独立存于用户级 `memory.sqlite`；工具结果通过持久投影和归档回读进入模型上下文。旧 JSONL、Evidence CAS 和文件式 Plan 描述不再定义当前行为。

| 范围         | 文档与状态                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上下文与记忆 | [上下文](architecture/03-context.md)、[压缩与结果](architecture/12-compaction-and-tool-result.md)、[原子记忆](architecture/14-workspace-memory.md)、[压缩契约](features/context-compaction.md)：当前机制                                                   |
| 入口与扩展   | [Provider](architecture/04-provider-entry.md)、[Hooks](architecture/07-hooks.md)、[Plugin scope](architecture/plugin-scope-contract.md)：当前主线与约束                                                                                                    |
| 调度         | [Graph](architecture/18-graph-mode.md)：当前主线；[Goal](guides/goal-implementation.md)、[TodoList](guides/todolist-implementation.md)：部分过期，存储与路径需对照代码                                                                                     |
| 旧实现说明   | [Engine](architecture/01-engine.md)、[Tools](architecture/02-tools.md)、[Infra](architecture/05-infra-safety.md)、[数据流](architecture/06-data-flow.md)、[渐进披露](architecture/13-progressive-disclosure.md)：局部存储、Evidence 或工具披露内容已被替代 |
| 缓存         | [Prompt Cache](architecture/15-prompt-cache.md)：阈值和 Provider 细节待专项复核                                                                                                                                                                            |
| 产品专题     | [深度研究](features/deep-research.md)、[追踪面板](features/inspector-panel.md)、[Provider 网络恢复](features/provider-network-recovery.md)                                                                                                                 |
| 交互规格     | [Desktop/TUI parity](guides/desktop-tui-parity.md)：目标与验收规格；[TUI 指南](guides/tui-claude-code-parity.md)：命令需按当前实现复核                                                                                                                     |

[架构决策目录](decisions/)中，21、24、26–30 为已实施决策；23 已被 30 取代，25 已被 SQLite 迁移取代，24a 的 JSONL 形态已退役。[历史架构资料](history/architecture/)保留研究与演进背景，不作为当前待办。

## 课程式构建记录

以下 11 章已按当前实现重写；`history/course/` 路径保留以兼容已有链接，章节中的示例与实际接口仍需区分。

| 章节                                    | 主题                     |
| --------------------------------------- | ------------------------ |
| [0](history/course/00-why.md)           | 为什么自己写 Harness     |
| [1](history/course/01-breathing.md)     | 最小循环与 ReAct         |
| [2](history/course/02-provider.md)      | Provider 抽象            |
| [3](history/course/03-tools.md)         | 工具 Registry            |
| [4](history/course/04-memory.md)        | Session 与上下文         |
| [5](history/course/05-compaction.md)    | 上下文压缩               |
| [6](history/course/06-steering.md)      | Plan、恢复与重复失败     |
| [7](history/course/07-safety.md)        | 安全与审批               |
| [8](history/course/08-subagent.md)      | 子代理与隔离             |
| [9](history/course/09-observability.md) | 成本、Trace 与日志       |
| [10](history/course/10-evaluation.md)   | 内部 Headless 与评测证据 |

## 实施与验收记录

`plans/` 保留仍有待验收事项或承担现行说明的记录；文件存在不表示仍在开发。已完成且不再承载当前契约的一次性计划、交接与旧设计验收，通过 Git 历史追溯。

| 记录                                                                                                                       | 保留原因                               |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [移动端发布交付](plans/2026-10-04-mobile-release-delivery.md) · [发布整改](plans/2026-10-04-mobile-release-remediation.md) | 正式签名、真机、公网及发布资料仍有待项 |
| [移动端 Relay](plans/2026-10-04-mobile-relay-implementation.md)                                                            | 外部部署与验收条件需落实               |
| [移动端直连](plans/2026-10-02-mobile-direct-implementation.md) · [移动端交互](plans/2026-10-03-mobile-ux-redesign.md)      | 保留设备、网络、可访问性等验收边界     |
| [Graph 与界面修复](plans/2026-09-17-managed-graph-and-ui-fixes.md)                                                         | GUI 验收曾受 Provider 额度限制         |
| [执行追踪](plans/2026-09-22-execution-trace-gap-closure.md)                                                                | 仍被计量说明引用，包含当前契约         |
| [原生搜索](plans/2026-09-13-native-web-search.md)                                                                          | 保留真实正向搜索未验证的说明           |

[上下文验证](verification/context-validation-2026-09-23.md)、[功能验证](features/feature-validation.md)、[追踪面板验证](features/inspector-panel-validation.md)与[视觉验收](../design-qa.md)是各次验证记录，不代表每次提交都重新验证。

[Terminal-Bench 交付状态](../.delivery/terminal-bench-failure-recovery/state.json)仍保留发布、观察与接受待项。根目录的[Windows 内网说明](../内网使用说明.txt)与[启动脚本](../启动TUI.bat)保留双击入口。

公开文档配图保留正文使用的图片与可编辑源；本地截图、生成回执和临时报告放在已忽略的 `output/`，不进入仓库导航。
