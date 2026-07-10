# pico-harness

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)
![Tests](https://img.shields.io/badge/tests-1914%20passed-brightgreen.svg)

用 TypeScript 从零实现的工业级 Agent Harness 引擎,对标课程《从 0 开始构建 Agent Harness》中的 `go-pico`。

## 核心理念

**`Agent = Model + Harness`**。本工程不写业务框架,而是为大模型(CPU)编写一个微型 OS:管理 Context(内存)、调度极简工具(外设)、拦截危险操作(中断)。

## ✨ 特性

- **Two-Stage ReAct**:独立 Thinking 阶段剥离,空 tools 强制纯文本规划,再恢复工具执行
- **双协议 Provider**:OpenAI 兼容 + Claude 原生,统一 Message Schema 双向翻译
- **极简工具集**:read_file / write_file / edit_file / bash 四原语,多级模糊匹配容错
- **Fork-Join 并行**:全只读批次 Promise.all 并发,含写操作退化为串行
- **Session 物理隔离**:TUI 单入口按项目目录绑定会话,WorkingMemory 滑动窗口 + 孤儿 ToolResult 丢弃
- **阶梯降级 Compactor**:远期历史全量掩码 + 保护区掐头去尾,防 Context OOM
- **Plan Mode 状态外部化**:PLAN.md / TODO.md 持久化记忆,断点续传 + 零成本人机协同
- **ErrorRecovery 锦囊**:工具报错时按类型注入恢复建议,引导模型走向正确排障 SOP
- **SystemReminders 防死循环**:MD5 哈希指纹监控连续失败,3 次同参数失败强行打断
- **Middleware 高危审批**:rm/sudo 等命令挂起执行流,在 TUI 中展示审批提示
- **Subagent 任务委派**:spawn_subagent 拉起隔离上下文子智能体干脏活,爆炸半径只读限制
- **CostTracker 成本追踪**:装饰器模式无侵入拦截 Token 消耗与耗时,按模型计费
- **Tracing 链路追踪**:决策树导出 JSON,逐帧复盘 Agent 失败时的全量决策路径

## 📦 安装

```bash
# 需要 Node.js >= 22
git clone <repo-url> pico-harness
cd pico-harness
npm install
npm run build
npm link

# 复制环境变量模板并填入你的 API Key
cp .env.example .env
```

## 🚀 快速开始

Pico 当前唯一公开产品入口是 `pico` 启动的交互式 TUI。`npm run dev` 是仓库开发入口，进入同一 TUI。

```bash
# 在当前项目目录启动 TUI
npm run dev

# 指定工作区 / provider / model
npx tsx --env-file=.env --import ./src/tui/preload-env.ts src/cli/main.ts \
  --dir /path/to/project \
  --provider openai \
  --model glm-5.2
```

想像 Claude Code 一样在任意项目目录启动交互式 Pico,见 [Pico Claude Code 风格交互启动指南](./docs/tui-claude-code-parity.md)。

### 当前范围

- `src/cli/run-agent.ts` 中的 `runAgentFromCli` 是 TUI 内部装配函数，不是可支持的 one-shot/headless CLI 入口。
- 文件历史在 TUI 内使用 `/snapshots` 和 `/rewind`。
- REST/WebSocket、ACP、飞书与 one-shot CLI 外壳曾在历史阶段完成，后已退役。
- Cron/headless 调度、Docker 部署和 Plugin runtime 不在当前产品范围。

## 🏗️ 架构概览

```
pico-harness/
├── src/
│   ├── cli/              # TUI 启动外壳 + TUI 内部 run-agent 装配
│   ├── tui/              # 交互式终端界面
│   ├── engine/           # 核心引擎层:Main Loop (ReAct) / Session / Reporter / Reminder
│   ├── provider/         # 模型适配层:OpenAI 兼容 / Claude 原生 + 工厂 + fallback
│   ├── schema/           # 公共数据结构:Message / ToolCall / Usage
│   ├── context/          # 上下文工程层:Prompt 组装 / Compaction / Recovery / Skill
│   ├── tools/            # 工具执行层:Registry + Middleware + Read/Write/Edit/Bash + Subagent
│   ├── approval/         # 安全防线:高危命令拦截 + 人工审批管理器
│   ├── observability/    # 可观测性:CostTracker 成本追踪 + Tracing 链路追踪 + Logger
├── tests/                # 单元/集成测试
├── AGENTS.md             # 动态系统提示词来源(PromptComposer 自动加载)
├── .env.example          # 环境变量模板
└── package.json
```

## 🔧 环境变量

| 变量           | 必填 | 说明                                      |
| -------------- | ---- | ----------------------------------------- |
| `LLM_BASE_URL` | ✅   | 大模型 API 端点(OpenAI 兼容)              |
| `LLM_API_KEY`  | ✅   | API Key                                   |
| `LLM_MODEL`    | ✅   | 模型名(如 `glm-5.2`)                      |
| `LOG_LEVEL`    | 可选 | 日志级别:debug/info/warn/error(默认 info) |

## 🧪 测试与评估

```bash
npm test           # 运行默认单元/集成测试(不含真实 e2e)
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint 代码检查
npm run build      # 编译到 dist/
npm run test:e2e   # 无密钥、无外网的确定性 E2E
npm run smoke:tui  # 构建后在 PTY 中驱动 TUI 并调用本地 fake OpenAI
npm pack --dry-run # 验证发布包内容与 pico bin
```

## 📖 课程进度

跟随《从 0 开始构建 Agent Harness》22 讲螺旋增量推进,全部实现完毕。详见 [AGENTS.md](./AGENTS.md)。

## 📄 License

[MIT](./LICENSE)
