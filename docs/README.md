# pico-harness · 从零构建 Agent 引擎

> 一本用费曼学习法写成的技术笔记。不是我教你，是我在理清自己到底建了什么。

---

## 这是什么

pico-harness 是一个用 TypeScript 实现的工业级 Agent Harness 引擎——大约 50 个源文件，四个核心工具，一套极简哲学。

这本书是它的"构建日志"。每一章对应一个我真实遇到的问题：先是跑不通，然后想通了为什么跑不通，最后改了设计让它跑通。代码先行，设计后置。

---

## 目录

| 章节                     | 标题                   | 核心问题                                                   |
| ------------------------ | ---------------------- | ---------------------------------------------------------- |
| [0](00-why.md)           | 为什么自己写？         | 框架失效的三个原因 / Harness 哲学 / 四层架构               |
| [1](01-breathing.md)     | 让它学会呼吸           | 最简 20 行循环 → ReAct → 为什么需要 Two-Stage              |
| [2](02-provider.md)      | 接上不同的大脑         | Provider 接口 / OpenAI 与 Claude 的协议差异 / Factory 模式 |
| [3](03-tools.md)         | 教它用工具             | Registry 路由 / 四工具 / 四级模糊匹配 / 并行调度           |
| [4](04-memory.md)        | 记住上次聊到哪         | Session 隔离 / WorkingMemory / JSONL 持久化 / FTS5         |
| [5](05-compaction.md)    | 别让它撑爆上下文       | 阶梯压缩 / Token 精确计数 / 溢出重试 / 预算管理            |
| [6](06-steering.md)      | 给它装上方向盘         | Plan Mode / 错误自愈 / System Reminders 死循环斩断         |
| [7](07-safety.md)        | 建一道安全防线         | Middleware 拦截 / 高危命令检测 / 人工审批                  |
| [8](08-subagent.md)      | 一个人不够，招几个帮手 | Explore / Shared Worker / Isolated Worker / 上下文隔离     |
| [9](09-observability.md) | 看清每一步在干什么     | CostTracker 装饰器 / Tracing Span 树 / 结构化日志          |
| [10](10-evaluation.md)   | 怎么知道它变聪明了     | Benchmark 自动化评测 / CLI 入口 / 飞书 AgentOps            |

---

## 架构规范

- [多 Agent 共享工作区并发规范](architecture/08-multi-agent-concurrency.md)：多 Agent 写入、`writeScopes`、文件 OCC、动态 Bash、Rewind 与可选 worktree 的唯一权威来源。

---

## 怎么读

**顺序阅读**。每一章的问题自然引出下一章的解法。跳着读会丢失"为什么要这样设计"的上下文。

**边读边查源码**。每章涉及的关键文件标注在文中。文档在 `docs/feynman/`，源码在 `src/`。

**不要速读**。这不是 API 文档，是设计决策的记录。重要的不是"怎么用"，是"为什么这样设计"。

---

## 与 tutorial 系列的关系

`docs/tutorial/` 是课堂讲义——有教学目标、有前置阅读、有课后练习。

`docs/feynman/`（本书）是费曼笔记——第一人称、问题驱动、渐进式构建。

内容覆盖相同的技术主题，但组织方式和叙述口吻完全不同。如果你更喜欢"跟着一个人一起构建"而非"坐在教室里听课"，这本书更适合你。

---

## 版本

- 文档版本：v1.0.0
- 基于源码 commit：`8bc825c`
- 更新日期：2026-07-05
