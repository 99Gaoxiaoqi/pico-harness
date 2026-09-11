# pico-harness 技术文档索引

本页是仓库技术文档的统一入口。文档状态分为四类：

- **当前事实**：目标是与生产代码同步，发生架构变更时必须更新。
- **部分过期**：设计动机仍有价值，但存在已被代码或后续 ADR 取代的实现细节。
- **历史/研究**：只用于理解演进和取舍，不定义当前行为。
- **目标规格**：描述期望状态或验收标准，不能据此断言已经实现。

代码、测试和已实施 ADR 与正文冲突时，以代码和测试为准。

## 当前事实入口

| 文档                                                         | 作用                                             | 状态                 |
| ------------------------------------------------------------ | ------------------------------------------------ | -------------------- |
| [根 README](../README.md)                                    | 产品入口、快速开始、配置、安全与验证             | 当前事实             |
| [根架构文档](../ARCHITECTURE.md)                             | 系统边界、状态所有权、存储和安全边界             | 当前事实             |
| [架构导航](architecture/00-overview.md)                      | 执行路径、模块地图和阅读顺序                     | 当前事实             |
| [部署与运行](guides/deployment.md)                           | TUI/Desktop 启动、配置和运行边界                 | 当前事实             |
| [Desktop 架构](guides/desktop-architecture.md)               | Renderer、Main、daemon 与平台适配边界            | 当前事实             |
| [本机 IPC 安全](architecture/local-ipc-security.md)          | runtime-host endpoint、root authority 与信任模型 | 当前事实             |
| [Desktop 发布](guides/desktop-release.md)                    | macOS 发布工作流、签名、公证和门禁               | 当前事实             |
| [内部 Headless Runner](guides/internal-headless-one-shot.md) | 仓库内 benchmark/评测机器入口                    | 当前事实，非公开 API |

## 当前实现的关键边界

旧文档最容易在以下四处误导读者：

1. TUI 已从进程内 Runtime 迁移为 daemon 瘦客户端；TUI 与 Desktop 都通过
   `LocalRuntimeClient` 使用 runtime-host。
2. workspace 持久化已从 Session JSONL、目录锁和自研 commit journal 硬切为统一
   `pico.sqlite`；Session、TaskRun、Control、Todo 等通过独立 SQLite scope 保持所有权。长期
   记忆随后迁出到用户级 `$PICO_HOME/memory.sqlite`，按 global/workspace scope 隔离，经过
   提取和规范化直接保存，旧 Proposal/Worker 执行链已退役。
3. 新 ToolResult 不再进入 Evidence CAS；限内正文 inline 入库，超过 1 MiB 写合成错误，
   `read_evidence` 只剩退役协议的兼容/诊断边界。
4. Plan 不再使用 `PLAN.md` / `TODO.md`。Plan 是 Session RuntimeEvent 状态机，普通 Todo 位于
   SQLite `workspace_kv`。

## 架构深入文档

[记忆功能技术图解](pico-memory-technical-guide.md)：从用户证据、提取与规范化，到事务保存、失败恢复和关键词召回，附三张流程图。

[子智能体技术图解](pico-subagents-technical-guide.md)：从配置创建、持久执行到续用、活动卡片与统一权限边界，附概念封面和五张技术图，并区分旧委派工具与 Graph。

| 文档                                                                                 | 状态       | 阅读提示                                                   |
| ------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------- |
| [01 Engine](architecture/01-engine.md)                                               | 部分过期   | Engine 主线可参考；JSONL/commit marker 存储段已过期        |
| [02 Tools](architecture/02-tools.md)                                                 | 部分过期   | Registry/调度可参考；Evidence 与 `read_evidence` 已退役    |
| [03 Context](architecture/03-context.md)                                             | 部分过期   | Prompt/压缩可参考；Evidence、Todo 路径和摘要段数需回查代码 |
| [04 Provider 与入口](architecture/04-provider-entry.md)                              | 当前主线   | TUI daemon 路径已校准；协议细节仍以代码为准                |
| [05 Infra 与安全](architecture/05-infra-safety.md)                                   | 部分过期   | 安全分层可参考；文件存储描述已被 SQLite 取代               |
| [06 数据流](architecture/06-data-flow.md)                                            | 部分过期   | 主执行链可参考；ToolResult/Evidence 局部仍是旧方案         |
| [07 Hooks](architecture/07-hooks.md)                                                 | 当前主线   | Hook 来源、信任、热重载和前后台边界                        |
| [08 多 Agent 并发](history/architecture/08-multi-agent-concurrency.md)               | 历史提案   | Shared Worker/OCC 尚未成为当前可写 worker 主路径           |
| [09 架构债务](history/architecture/09-architecture-debt-remediation.md)              | 历史审计   | 不作为当前待办                                             |
| [10 架构质量评估](history/architecture/10-architecture-quality-assessment.md)        | 历史评估   | 评分和规模为阶段快照                                       |
| [11 ToolResult Evidence](history/architecture/11-tool-result-evidence-projection.md) | 已取代     | 由决策记录 26 取代                                         |
| [12 Compaction/ToolResult](architecture/12-compaction-and-tool-result.md)            | 部分过期   | Compaction 动机可参考；ToolResult 归档段已取代             |
| [13 渐进披露](architecture/13-progressive-disclosure.md)                             | 部分过期   | 工具披露看 ADR 30；ToolResult 看 ADR 26                    |
| [14 原子长期记忆](architecture/14-workspace-memory.md)                               | 当前事实   | 用户级原子库、提取/召回、管理及后台恢复边界                |
| [15 Prompt Cache](architecture/15-prompt-cache.md)                                   | 待专项复核 | 原理可参考，阈值和 Provider 细节以代码为准                 |
| [18 Graph Mode](architecture/18-graph-mode.md)                                       | 当前主线   | Graph v2 控制面、exact Run 与 yield/wake 恢复              |
| [19 核心概念地图](history/architecture/19-concepts-map.md)                           | 历史快照   | 旧 JSONL、Evidence 与 Graph v1 叙述不代表当前实现          |
| [Plugin scope](architecture/plugin-scope-contract.md)                                | 当前约束   | Plugin 物理根与 scope 边界                                 |

## 架构决策与研究

| 文档                                                                                          | 状态                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| [16 Pico 与 Maka 状态对比](history/architecture/16-pico-vs-maka-state-architecture.md)        | 迁移前研究快照                                |
| [17 Failure Journal](history/architecture/17-failure-journal.md)                              | 原子记忆迁移前研究；旧分类与链路已过期        |
| [20 架构审计与治理](history/architecture/20-architecture-audit-and-governance.md)             | 阶段性治理记录                                |
| [Pico / Maka 写入与故障流程调研](history/architecture/pico-vs-maka-flow-gap-investigation.md) | ADR 27–29 实施前调查，已收口                  |
| [21 Windows PowerShell Host](decisions/21-decision-windows-powershell-host.md)                | 已实施 ADR                                    |
| [22 Child Run Capacity](decisions/22-decision-child-run-capacity.md)                          | 已实施 ADR                                    |
| [23 Tool Disclosure Surface](decisions/23-decision-tool-disclosure-surface.md)                | 已被 ADR 30 取代                              |
| [24 SQLite Storage](decisions/24-decision-sqlite-storage-migration.md)                        | 已实施 ADR                                    |
| [24a Session Catalog](decisions/24a-decision-session-catalog.md)                              | 原 JSONL 形态已退役，当前为 SQLite projection |
| [25 Write Path Slimming](decisions/25-decision-write-path-slimming.md)                        | 已被 SQLite 硬切取代                          |
| [26 ToolResult Entry Shaping](decisions/26-decision-tool-result-entry-shaping.md)             | 已实施 ADR                                    |
| [27 Write Failure Recovery](decisions/27-decision-write-path-failure-recovery.md)             | 已实施 ADR                                    |
| [28 Conversation State SQLite](decisions/28-decision-conversation-state-sqlite.md)            | 已实施 ADR                                    |
| [29 Continuation Claim](decisions/29-decision-continuation-claim.md)                          | 已实施 ADR                                    |
| [30 Maka Tool Runtime](decisions/30-decision-maka-tool-runtime.md)                            | 已实施 ADR；取代 ADR 23                       |

## 专题实现说明

| 文档                                                            | 状态                                        |
| --------------------------------------------------------------- | ------------------------------------------- |
| [Goal 实现](guides/goal-implementation.md)                      | 部分过期；存储路径与无预算 stall 契约需复核 |
| [TodoList 实现](guides/todolist-implementation.md)              | 部分过期；当前存储为 SQLite `workspace_kv`  |
| [Desktop/TUI parity](guides/desktop-tui-parity.md)              | 目标/验收规格，不是完成清单                 |
| [TUI 交互指南](guides/tui-claude-code-parity.md)                | 使用前按当前 client commands 复核           |
| [架构配图指南](guides/pico-harness-architecture-guide-image.md) | 历史快照；基于 `a5d598f`，不定义当前行为    |

## 课程式构建记录

以下章节保留“为什么这样构建”的教学推导，不是当前产品契约。每章顶部已经标注主要失效
边界；代码示例、路径、工具数量、协议和阈值可能无法在当前版本直接运行。

| 章节                                    | 主题                             |
| --------------------------------------- | -------------------------------- |
| [0](history/course/00-why.md)           | 为什么自己写 Harness             |
| [1](history/course/01-breathing.md)     | 最小循环与 ReAct                 |
| [2](history/course/02-provider.md)      | Provider 抽象                    |
| [3](history/course/03-tools.md)         | 工具 Registry                    |
| [4](history/course/04-memory.md)        | Session 与上下文                 |
| [5](history/course/05-compaction.md)    | 上下文压缩                       |
| [6](history/course/06-steering.md)      | Plan、恢复与重复失败             |
| [7](history/course/07-safety.md)        | 安全与审批                       |
| [8](history/course/08-subagent.md)      | 子代理与隔离                     |
| [9](history/course/09-observability.md) | 成本、Trace 与日志               |
| [10](history/course/10-evaluation.md)   | 内部评测；本组中与当前实现最接近 |

## 实施计划与历史档案

`plans/` 只放正在执行的计划；当前没有活动计划。已结束计划移入 `history/plans/`，历史未勾选项不自动成为当前待办。最近归档包括[项目结构收敛](history/plans/2026-09-12-project-structure-convergence.md)、[提交与全方位验证](history/plans/2026-09-10-submit-full-validation.md)、[全量回归问题修复](history/plans/full-regression-repair.md)与 [Maka 运行时对齐](history/plans/maka-runtime-alignment.md)。

## 仓库资产与工作流记录

| 资产                                                                                       | 用途与状态                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [Desktop 全流程原型](../apps/desktop/prototypes/full-flow/README.md)                       | 可直接本地预览的目标交互原型；不代表当前实现                                                     |
| [Desktop 设计验收](history/design/desktop-design-qa.md)                                    | 一次性 Desktop 视觉验收快照                                                                      |
| [子智能体能力卡片验收](history/design/subagent-capability-card-qa.md)                      | 一次性能力卡片验收；本机截图未作为仓库资产保留                                                   |
| [Terminal-Bench 失败恢复交付状态](../.delivery/terminal-bench-failure-recovery/state.json) | 高风险机器工作流状态；当前仍为 `release-readiness: active`，发布、观察与接受待完成，因此保留原位 |

根目录的 `启动TUI.bat` 是 Windows 内网包可双击入口，配套说明见 `内网使用说明.txt`；两者保留在根目录以避免破坏离线包的相对路径与双击体验。

| 目录                                | 用途                                                   |
| ----------------------------------- | ------------------------------------------------------ |
| `architecture/`                     | 当前模块边界与实现说明；局部过期内容按上表提示核对代码 |
| `guides/`                           | 部署、发布与专题说明                                   |
| `decisions/`                        | 架构取舍和决策；实施状态见决策表                       |
| `plans/`                            | 当前实施与验收清单                                     |
| `history/course/`                   | 从最小 Harness 开始的课程记录                          |
| `history/architecture/`             | 已取代设计、研究和阶段审计                             |
| `history/plans/`、`history/design/` | 历史实施计划与设计记录                                 |

目录表达文档用途，表中状态表达它与当前代码的关系；归档文档不定义当前行为。
