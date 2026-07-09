# pico-harness 架构总览

> 大模型是 CPU，上下文是内存，工具是外设，Main Loop 是极简的 ReAct 内核。

## 项目定位

pico-harness 是一个用 TypeScript 实现的**工业级 Agent Harness 引擎**——把大模型当作"CPU"，在极简的 ReAct Main Loop 中自主规划与行动。当前产品外壳收口为 TUI 单入口，核心仍保留会话管理、上下文压缩、工具调度和 provider 适配等运行时能力。

## 模块地图

```
                        ┌─────────────────────────────────────┐
   pico / npm run dev ─▶│ src/cli/          TUI 启动 + 装配      │──▶ AgentEngine
                        │ src/tui/          TUI 交互界面        │    (src/engine/loop.ts)
                        └─────────────────────────────────────┘      ▼
                                                          ┌──────────────────────┐
                                                          │ src/engine/          │
                                                          │  loop.ts (主循环)     │
                                                          │  session.ts (会话)    │
                                                          │  reporter.ts (I/O)   │
                                                          │  budget / reminder    │
                                                          │  goal-manager         │
                                                          │  steer-queue          │
                                                          └──────┬───────────────┘
                               ┌──────────────────────────────────┼───────────────────────┐
                               ▼                                  ▼                       ▼
                    ┌──────────────────┐         ┌──────────────────────┐    ┌──────────────────┐
                    │ src/tools/       │         │ src/context/          │    │ src/provider/    │
                    │  registry(接口)   │         │  composer(Prompt组装) │    │  openai/claude/   │
                    │  registry-impl   │         │  compactor(字符压缩)  │    │  gemini 适配      │
                    │  内置 15+ 工具    │◀───────▶│  full-compactor(摘要) │◀─▶│  factory(工厂)    │
                    │  调度/审批/hooks  │         │  todo/plan/skill store│    │  retry(重试)     │
                    │  子代理/渐进披露   │         │  artifact-store       │    │  credential-pool  │
                    └──────────────────┘         └──────────────────────┘    └──────────────────┘
                               │                          │                          │
                               ▼                          ▼                          ▼
                    ┌──────────────────┐         ┌──────────────────────┐    ┌──────────────────┐
                    │ src/safety/      │         │ src/observability/    │    │ src/schema/       │
                    │  file-history    │         │  logger/tracker/trace │    │  message.ts       │
                    │  checkpoint(旧)  │         │  pricing              │    │  (核心数据结构)    │
                    └──────────────────┘         └──────────────────────┘    └──────────────────┘
```

## 核心设计哲学

| 原则             | 说明                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| **极简工具集**   | 只用 Read/Write/Edit/Bash 四个原语组合出无限可能（第 06 讲）          |
| **状态外部化**   | 规划写在 PLAN.md，进度写在 TODO.md，不依赖内存状态机（第 13 讲）      |
| **边做边验证**   | 每完成一步就运行测试确认，不一次性堆砌代码                            |
| **Session 驱动** | 引擎是"打工执行器"，不维护状态，靠 Session 推理（随时休眠/唤醒）      |
| **I/O 解耦**     | Reporter 接口隔离引擎与终端，注入不同实现切换展现层                   |
| **单例注入**     | GoalManager/TodoStore/ToolDisclosure 由 host 创建唯一实例，经构造注入 |

## 文档索引

| 文档                                           | 内容                                                           |
| ---------------------------------------------- | -------------------------------------------------------------- |
| [01-engine.md](./01-engine.md)                 | 核心引擎层：主循环、会话、预算、死循环探测、Goal、Steer        |
| [02-tools.md](./02-tools.md)                   | 工具层：Registry 接口、内置工具、调度、子代理、渐进披露、Hooks |
| [03-context.md](./03-context.md)               | 上下文层：Prompt 组装、两级压缩、状态存储、技能记忆            |
| [04-provider-entry.md](./04-provider-entry.md) | Provider 适配 + 当前 TUI 单入口装配                            |
| [05-infra-safety.md](./05-infra-safety.md)     | 基础设施：文件历史、审批系统、MCP、可观测性、Schema            |
| [06-data-flow.md](./06-data-flow.md)           | 数据流：一轮 ReAct 循环的完整时序、压缩协作、凭证轮换链路      |

## 技术栈

- **语言**: TypeScript (ESM, target ES2024, 全开 strict)
- **运行时**: Node.js ≥ 22
- **核心依赖**: better-sqlite3（持久化/FTS5）、ink+react（TUI）、pino（日志）、gpt-tokenizer（BPE 计数）、js-yaml、picocolors
- **开发工具**: tsx（dev 运行）、vitest（测试）、eslint+prettier
- **启动**: `pico` 或 `npm run dev` 进入 TUI
