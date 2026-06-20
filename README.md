# pico-harness

用 TypeScript 从零实现的工业级 Agent Harness 引擎,对标课程《从 0 开始构建 Agent Harness》中的 `go-pico`。

## 定位

`Agent = Model + Harness`。本工程不写业务框架,而是为大模型(CPU)编写一个微型 OS:
管理 Context(内存)、调度极简工具(外设)、拦截危险操作(中断)。

## 架构分层(第 01 讲)

```
pico-harness/
├── src/
│   ├── cli/          # 入口交互层:命令行入口
│   ├── engine/       # 核心引擎层:Main Loop (ReAct)
│   ├── provider/     # 模型适配层:Claude / OpenAI 兼容
│   ├── schema/       # 公共数据结构:Message / ToolCall
│   ├── context/      # 上下文工程层:Prompt 组装 / Compaction
│   ├── tools/        # 工具执行层:Registry + Read/Write/Edit/Bash
│   └── memory/       # 状态与记忆层:文件系统 PLAN/TODO
├── tests/
├── workspace/        # Agent 运行时工作区
├── AGENTS.md         # 动态系统提示词来源(第 10 讲加载)
└── package.json
```

## 开发

```bash
pnpm install          # 安装依赖
pnpm dev              # tsx 直接运行入口
pnpm typecheck        # 类型检查
pnpm test             # vitest 单测
pnpm build            # 编译到 dist/
```

## 进度

跟随课程 22 讲螺旋增量推进,详见 [AGENTS.md](./AGENTS.md)。
