# pico-harness · 课程式构建记录

> 这里按项目的演进顺序解释“为什么这样构建”。各章保留当时的问题、取舍和实现阶段，
> 是课程与构建记录，不是当前产品契约。

## 先确认当前事实

阅读课程前，先用下面两份文档建立当前基线：

- [根 README](../README.md)：当前产品入口、能力、安全边界、运行与验证方式。
- [架构总览](architecture/00-overview.md)：当前 Runtime、状态所有权、模块边界与架构索引。

如果课程章节中的命令、目录、工具数量、存储方案或入口形态与当前实现冲突，以上述当前
事实源和已跟踪代码为准。课程章节会保留历史阶段，因为理解被替换的方案仍有助于理解
今天的设计；这些内容不承诺兼容性，也不表示相应能力仍然存在。

## 这组课程讲什么

pico-harness 是一个用 TypeScript 实现的 Agent Harness。课程从最小 Agent 循环出发，
沿着 Provider、工具、会话、上下文、安全、子代理、可观测性和评测逐步展开。每一章都
围绕一个真实工程问题：先观察失败，再解释约束，最后引出当时采用的设计。

代码和产品继续演进，因此这里更关注设计推导，不枚举“当前共有多少文件、多少工具”
之类容易失真的快照。

## 课程目录

| 章节                     | 标题                   | 教学主题                                     | 阅读边界                               |
| ------------------------ | ---------------------- | -------------------------------------------- | -------------------------------------- |
| [0](00-why.md)           | 为什么自己写？         | Harness 的职责、失效模式与最初的分层思路     | 概念起点；当前分层见架构总览           |
| [1](01-breathing.md)     | 让它学会呼吸           | 最小循环、ReAct 与执行闭环                   | 早期演进记录                           |
| [2](02-provider.md)      | 接上不同的大脑         | Provider 协议差异与统一抽象                  | 配置和路由以当前 README 为准           |
| [3](03-tools.md)         | 教它用工具             | Registry、工具调用、匹配与调度               | 工具名称、数量和策略是历史快照         |
| [4](04-memory.md)        | 记住上次聊到哪         | Session、运行事实、工作记忆与持久化          | 存储布局已经演进，以当前架构文档为准   |
| [5](05-compaction.md)    | 别让它撑爆上下文       | 上下文预算、压缩、重试与信息保留             | 讲解设计动机；参数与实现可能继续变化   |
| [6](06-steering.md)      | 给它装上方向盘         | 计划、恢复提示与重复失败控制                 | 交互命令和权限语义以当前产品文档为准   |
| [7](07-safety.md)        | 建一道安全防线         | 执行前门禁、审批与安全边界                   | 不替代当前安全模型与基础设施安全文档   |
| [8](08-subagent.md)      | 一个人不够，招几个帮手 | 子代理角色、隔离与协作                       | 当前并发和写入约束见架构规范           |
| [9](09-observability.md) | 看清每一步在干什么     | Usage、Tracing 与结构化运行事实              | 具体事件和存储格式以当前实现为准       |
| [10](10-evaluation.md)   | 怎么知道它变聪明了     | 内部 Headless 合约与 Terminal-Bench 本地评测 | 描述当前内部评测边界，不是公开产品入口 |

## 配套架构阅读

- [Engine 与会话](architecture/01-engine.md)
- [工具系统](architecture/02-tools.md)
- [上下文工程](architecture/03-context.md)
- [Provider 与产品入口](architecture/04-provider-entry.md)
- [基础设施安全](architecture/05-infra-safety.md)
- [完整数据流](architecture/06-data-flow.md)
- [多 Agent 共享工作区并发规范](architecture/08-multi-agent-concurrency.md)
- [上下文压缩与 Tool Result 归档](architecture/12-compaction-and-tool-result.md)
- [渐进式披露](architecture/13-progressive-disclosure.md)
- [工作区记忆](architecture/14-workspace-memory.md)
- [前缀缓存](architecture/15-prompt-cache.md)
- [Pico 与 Maka 状态管理架构对比](architecture/16-pico-vs-maka-state-architecture.md)

## 怎么读

1. **按顺序理解设计推导。** 每一章的问题会自然引出下一章，但可以按需跳转到配套
   架构文档核对当前状态。
2. **边读边查已跟踪代码。** 章节中的文件路径首先帮助定位概念；路径不存在或实现不符
   时，不要据此推断当前 API。
3. **把历史结论当作假设。** 真正要运行、集成或扩展项目时，重新核对根 README、当前
   架构文档、`package.json` 脚本和实现。

这不是单独维护的一套 API 手册，也不再区分不存在的 `docs/feynman/` 或
`docs/tutorial/` 目录；本目录中的 `00-why.md` 至 `10-evaluation.md` 就是课程正文。
