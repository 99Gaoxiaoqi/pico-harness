# pico-harness 技术文档索引

本页是仓库技术文档的统一入口。文档状态分为四类：

- **当前事实**：目标是与生产代码同步，发生架构变更时必须更新。
- **部分过期**：设计动机仍有价值，但存在已被代码或后续 ADR 取代的实现细节。
- **历史/研究**：只用于理解演进和取舍，不定义当前行为。
- **目标规格**：描述期望状态或验收标准，不能据此断言已经实现。

代码、测试和已实施 ADR 与正文冲突时，以代码和测试为准。

## 当前事实入口

| 文档                                                  | 作用                                             | 状态                 |
| ----------------------------------------------------- | ------------------------------------------------ | -------------------- |
| [根 README](../README.md)                             | 产品入口、快速开始、配置、安全与验证             | 当前事实             |
| [根架构文档](../ARCHITECTURE.md)                      | 系统边界、状态所有权、存储和安全边界             | 当前事实             |
| [架构导航](architecture/00-overview.md)               | 执行路径、模块地图和阅读顺序                     | 当前事实             |
| [部署与运行](deployment.md)                           | TUI/Desktop 启动、配置和运行边界                 | 当前事实             |
| [Desktop 架构](desktop-architecture.md)               | Renderer、Main、daemon 与平台适配边界            | 当前事实             |
| [本机 IPC 安全](architecture/local-ipc-security.md)   | runtime-host endpoint、root authority 与信任模型 | 当前事实             |
| [Desktop 发布](desktop-release.md)                    | macOS 发布工作流、签名、公证和门禁               | 当前事实             |
| [内部 Headless Runner](internal-headless-one-shot.md) | 仓库内 benchmark/评测机器入口                    | 当前事实，非公开 API |

## 本轮代码对照发现的架构跃迁

旧文档最容易在以下四处误导读者：

1. TUI 已从进程内 Runtime 迁移为 daemon 瘦客户端；TUI 与 Desktop 都通过
   `LocalRuntimeClient` 使用 runtime-host。
2. workspace 持久化已从 Session JSONL、目录锁和自研 commit journal 硬切为统一
   `pico.sqlite`；Session、TaskRun、Control、Memory、Todo 等通过独立 SQLite scope 保持所有权。
3. 新 ToolResult 不再进入 Evidence CAS；限内正文 inline 入库，超过 1 MiB 写合成错误，
   `read_evidence` 只剩退役协议的兼容/诊断边界。
4. Plan 不再使用 `PLAN.md` / `TODO.md`。Plan 是 Session RuntimeEvent 状态机，普通 Todo 位于
   SQLite `workspace_kv`。

## 架构深入文档

| 文档                                                                         | 状态       | 阅读提示                                                   |
| ---------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| [01 Engine](architecture/01-engine.md)                                       | 部分过期   | Engine 主线可参考；JSONL/commit marker 存储段已过期        |
| [02 Tools](architecture/02-tools.md)                                         | 部分过期   | Registry/调度可参考；Evidence 与 `read_evidence` 已退役    |
| [03 Context](architecture/03-context.md)                                     | 部分过期   | Prompt/压缩可参考；Evidence、Todo 路径和摘要段数需回查代码 |
| [04 Provider 与入口](architecture/04-provider-entry.md)                      | 当前主线   | TUI daemon 路径已校准；协议细节仍以代码为准                |
| [05 Infra 与安全](architecture/05-infra-safety.md)                           | 部分过期   | 安全分层可参考；文件存储描述已被 SQLite 取代               |
| [06 数据流](architecture/06-data-flow.md)                                    | 部分过期   | 主执行链可参考；ToolResult/Evidence 局部仍是旧方案         |
| [07 Hooks](architecture/07-hooks.md)                                         | 当前主线   | Hook 来源、信任、热重载和前后台边界                        |
| [08 多 Agent 并发](architecture/08-multi-agent-concurrency.md)               | 历史提案   | Shared Worker/OCC 尚未成为当前可写 worker 主路径           |
| [09 架构债务](architecture/09-architecture-debt-remediation.md)              | 历史审计   | 不作为当前待办                                             |
| [10 架构质量评估](architecture/10-architecture-quality-assessment.md)        | 历史评估   | 评分和规模为阶段快照                                       |
| [11 ToolResult Evidence](architecture/11-tool-result-evidence-projection.md) | 已取代     | 由决策记录 26 取代                                         |
| [12 Compaction/ToolResult](architecture/12-compaction-and-tool-result.md)    | 部分过期   | Compaction 动机可参考；ToolResult 归档段已取代             |
| [13 渐进披露](architecture/13-progressive-disclosure.md)                     | 部分过期   | 工具披露看 ADR 23；ToolResult 看 ADR 26                    |
| [14 Workspace Memory](architecture/14-workspace-memory.md)                   | 部分过期   | 提案语义可参考；存储和生命周期已迁移                       |
| [15 Prompt Cache](architecture/15-prompt-cache.md)                           | 待专项复核 | 原理可参考，阈值和 Provider 细节以代码为准                 |
| [18 Graph Mode](architecture/18-graph-mode.md)                               | 当前主线   | 调度与恢复细节以 RuntimeEvent/SQLite 实现为准              |
| [19 核心概念地图](architecture/19-concepts-map.md)                           | 部分过期   | 概念关系可参考；旧文件布局和部分行号已漂移                 |
| [Plugin scope](architecture/plugin-scope-contract.md)                        | 当前约束   | Plugin 物理根与 scope 边界                                 |

## 架构决策与研究

| 文档                                                                                  | 状态                                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------- |
| [16 Pico 与 Maka 状态对比](architecture/16-pico-vs-maka-state-architecture.md)        | 迁移前研究快照                                |
| [17 Failure Journal](architecture/17-failure-journal.md)                              | 研究材料，不代表已实现能力                    |
| [20 架构审计与治理](architecture/20-architecture-audit-and-governance.md)             | 阶段性治理记录                                |
| [21 Windows PowerShell Host](architecture/21-decision-windows-powershell-host.md)     | 已实施 ADR                                    |
| [22 Child Run Capacity](architecture/22-decision-child-run-capacity.md)               | 已实施 ADR                                    |
| [23 Tool Disclosure Surface](architecture/23-decision-tool-disclosure-surface.md)     | 已实施 ADR                                    |
| [24 SQLite Storage](architecture/24-decision-sqlite-storage-migration.md)             | 已实施 ADR                                    |
| [24a Session Catalog](architecture/24a-decision-session-catalog.md)                   | 原 JSONL 形态已退役，当前为 SQLite projection |
| [25 Write Path Slimming](architecture/25-decision-write-path-slimming.md)             | 已被 SQLite 硬切取代                          |
| [26 ToolResult Entry Shaping](architecture/26-decision-tool-result-entry-shaping.md)  | 已实施 ADR                                    |
| [27 Write Failure Recovery](architecture/27-decision-write-path-failure-recovery.md)  | 已实施 ADR                                    |
| [28 Conversation State SQLite](architecture/28-decision-conversation-state-sqlite.md) | 已实施 ADR                                    |
| [29 Continuation Claim](architecture/29-decision-continuation-claim.md)               | 已实施 ADR                                    |

## 专题实现说明

| 文档                                                     | 状态                                        |
| -------------------------------------------------------- | ------------------------------------------- |
| [Goal 实现](goal-implementation.md)                      | 部分过期；存储路径与无预算 stall 契约需复核 |
| [TodoList 实现](todolist-implementation.md)              | 部分过期；当前存储为 SQLite `workspace_kv`  |
| [Desktop/TUI parity](desktop-tui-parity.md)              | 目标/验收规格，不是完成清单                 |
| [TUI 交互指南](tui-claude-code-parity.md)                | 使用前按当前 client commands 复核           |
| [架构配图指南](pico-harness-architecture-guide-image.md) | 视觉/教学资产，不定义 Runtime 行为          |

## 课程式构建记录

以下章节保留“为什么这样构建”的教学推导，不是当前产品契约。每章顶部已经标注主要失效
边界；代码示例、路径、工具数量、协议和阈值可能无法在当前版本直接运行。

| 章节                     | 主题                             |
| ------------------------ | -------------------------------- |
| [0](00-why.md)           | 为什么自己写 Harness             |
| [1](01-breathing.md)     | 最小循环与 ReAct                 |
| [2](02-provider.md)      | Provider 抽象                    |
| [3](03-tools.md)         | 工具 Registry                    |
| [4](04-memory.md)        | Session 与上下文                 |
| [5](05-compaction.md)    | 上下文压缩                       |
| [6](06-steering.md)      | Plan、恢复与重复失败             |
| [7](07-safety.md)        | 安全与审批                       |
| [8](08-subagent.md)      | 子代理与隔离                     |
| [9](09-observability.md) | 成本、Trace 与日志               |
| [10](10-evaluation.md)   | 内部评测；本组中与当前实现最接近 |

## Plans

`docs/plans/` 暂时保留，定位为阶段性实施、验收和交接记录，**不定义当前事实**。旧计划里的
未勾选项、“下一步”或“待实施”不能自动视为当前待办；需要继续执行时，先核对代码、最近提交
和计划顶部状态。

本轮不重写或重分类计划正文；后续只有在重新启动某项工作时，才为对应文件补充顶部状态。
