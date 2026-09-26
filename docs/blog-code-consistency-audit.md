# 技术博客与代码一致性核对

核对日期：2026-09-21。生产代码基线：`0092022f`。本轮由主代理与三个只读子代理分组检查，主代理统一修改文档、配图及过期测试样本。范围是本仓库的技术博客长文，不包括外部发布平台，也不把全部 ADR、实施计划和模块文档视为博客。

## 结论与范围

三篇专题博客已校准；原先过期的一篇架构长文与十一篇课程，现已完整重写为当前实现。更新包含正文机制、代码示例、工具名、存储模型、协议、验证命令和技术图，不再用历史标签代替更新。文件路径保留以兼容已有链接，旧正文由 Git 历史保存。

| 文章                                                        | 核对结果与处理                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [长期记忆](pico-memory-technical-guide.md)                  | 修正用户级共用开关、remember 独占步骤规则、Research 边界及 12 处源码链接；同步召回图                       |
| [子智能体](pico-subagents-technical-guide.md)               | 修正 bypass 继承、网络边界、续用准入对齐、函数名和 15 处源码链接；重绘权限图，补 Hook 验证器入口           |
| [上下文压缩](pico-context-compaction-technical-guide.md)    | 触发、归档、检查点主流程一致；澄清五段模板与四段硬性校验、累计修复阶段、手动入口未装配压缩 Hook            |
| [架构长文](guides/pico-harness-architecture-guide-image.md) | 完整重写客户端/daemon、三协议 Provider、SQLite、真实 usage 压缩、持久子任务及非破坏性 Rewind；替换旧技术图 |
| [00 为什么构建](history/course/00-why.md)                   | 重写为当前产品边界、包结构和完整执行链                                                                     |
| [01 最小循环](history/course/01-breathing.md)               | 重写为 AgentEngine、RuntimeRun、工具协议配对、事件与取消；删除旧 Two-Stage 流程                            |
| [02 Provider](history/course/02-provider.md)                | 重写为 AiSdkProvider 三协议、能力元数据、请求适配、错误及真实 usage                                        |
| [03 工具](history/course/03-tools.md)                       | 重写注册与安全链、资源调度、输出入口上限、归档能力和 Code Mode                                             |
| [04 记忆](history/course/04-memory.md)                      | 重写 SQLite Session、模型视图、用户级原子记忆与预算召回                                                    |
| [05 压缩](history/course/05-compaction.md)                  | 重写真 usage 触发、安全切点、摘要校验、检查点及归档回读                                                    |
| [06 Steering](history/course/06-steering.md)                | 重写事件化 Plan、SQLite Todo、steer、恢复与工具失败护栏                                                    |
| [07 安全](history/course/07-safety.md)                      | 重写 managed/bypass/external、权限模式、hardline、审批和边界扩展                                           |
| [08 子代理](history/course/08-subagent.md)                  | 重写配置型持久 Session/Run、父子授权、续用和 Graph 边界                                                    |
| [09 可观测性](history/course/09-observability.md)           | 重写 usage 与成本状态、计费归属、Trace/日志和归档证据                                                      |
| [10 评测](history/course/10-evaluation.md)                  | 重写 schemaVersion 2 headless、模式分离、full/cached-full 及证据验收                                       |

## 关键差异的代码证据

| 事实                                                                        | 代码依据                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 记忆开关所有项目共用，内容仍按 global/workspace 范围过滤                    | [sqlite-memory-item-store.ts](../packages/storage/src/sqlite/sqlite-memory-item-store.ts)：`getSettings` / `updateSettings`；[用户设置页](../apps/desktop/src/renderer/pages/UserMemorySettingsPage.tsx) |
| remember 在混合步骤首位可执行，并拒绝兄弟工具；非首位拒绝 remember          | [agent-engine.ts](../packages/runtime/src/agent-engine.ts)：remember 独占步骤处理                                                                                                                        |
| 父 bypass 可向专用子执行器传入 bypass；web_research 的 managed 边界启用网络 | [configured-subagent-executor.ts](../packages/pico-host/src/configured-subagent-executor.ts)：`createConfiguredSubagentExecutor`、`configuredSubagentExecutionBoundary`                                  |
| 续用边界由本次宿主准入决定；手动续聊恢复 profile managed 边界               | [agent-runtime.ts](../packages/pico-host/src/agent-runtime.ts)：`reconcileConfiguredChildExecutionBoundary` 及能力恢复装配                                                                               |
| 摘要模板五段，必要有序章节四段，Key Decisions 不属于硬性必需段              | [history-compact-summary-validation.ts](../packages/runtime/src/history-compact-summary-validation.ts)：`SUMMARY_FORMAT_TEMPLATE`、`REQUIRED_SUMMARY_SECTIONS`                                           |
| 截断重试与格式修复可先后发生，每阶段还有受限异常重试                        | [full-compactor.ts](../packages/runtime/src/full-compactor.ts)：`generatePreview`                                                                                                                        |
| 桌面手动压缩调用未传入 hookService                                          | [desktop-runtime-service.ts](../packages/pico-host/src/desktop-runtime-service.ts)：手动 `recordRuntimeCompactionCheckpoint` 装配                                                                        |
| 当前 TUI 为 daemon 客户端，工作区状态使用 pico.sqlite                       | [client-repl.tsx](../packages/cli/src/tui/client-repl.tsx)、[sqlite-workspace-storage.ts](../packages/storage/src/sqlite/sqlite-workspace-storage.ts)                                                    |

## 验证与测试样本修正

初次执行发现六个记忆测试失败：五个恢复场景共享旧单句摘要 fixture，另一项 checkpoint 生命周期测试也返回单句。新摘要格式校验会拒绝这些样本，测试因此在检查点断言处失败，尚未进入原本要测的恢复逻辑。

本轮将这两处模拟 Provider 返回值改成有实际内容的分段摘要，保持测试场景及原有断言不变，未修改生产代码。最终运行以下针对性集合：

```sh
node scripts/run-integration-tests.mjs \
  compaction-trigger compaction-summary hook-verifier-compaction archive-read-tool \
  configured-subagent-execution configured-subagent-continuation configured-subagent-output \
  desktop-configured-child-sessions atomic-memory-budget atomic-memory-recall \
  atomic-memory-recovery user-memory-settings atomic-memory-runtime
```

最终结果：**41 项通过，0 失败，0 跳过**。运行使用本地已有 packages 构建产物；干净环境需先执行 `npm run build:packages`。

另已检查文章相对链接、图片与封面路径，重新渲染并查看权限图、记忆召回图和压缩触发图，执行 Markdown 格式与差异空白检查。

本轮没有重新调用真实模型或执行桌面 Computer Use。博客中原有实机与真实模型记录仍是历史验收记录，不能当成本轮新结果。确定性测试证明这些具体分支，不证明所有任务的语义记忆质量。

## 过期正文重写的补充验证

包依赖检查 `npm run check:architecture` 通过。架构长文对应的工具调度、结果契约、运行投影和 Rewind 测试共 39 项；首次 38 项通过，另一项同样使用旧单句摘要，更新该 fixture 后，受影响文件 9 项全部通过。加上前一轮 41 项，最终状态下这两个集合共 80 个不同测试均已通过；不将重跑计为新测试。生产代码未修改。

```sh
node scripts/run-integration-tests.mjs \
  tool-scheduler-contract runtime-tool-result-contract \
  tool-result-runtime-projection rewind-atomic-contract
```

课程各章给出相应验证入口；未把所有列出的命令都实际执行一遍，也未重跑真实模型、Harbor 容器或桌面 UI 验收。

文档静态检查覆盖 16 份文档（15 篇博客及本报告）：240 个本地链接、27 个测试路径均存在，代码围栏配对正常。重写文章中的 15 张 Mermaid 图均成功渲染，并抽查记忆架构与 Rewind 两张 PNG 的文字和布局。
