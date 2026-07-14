# pico-harness

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)
![Tests](https://img.shields.io/badge/tests-1915%20passed-brightgreen.svg)

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
- `/rewind` 按用户消息列出提示词、时间和该轮文件变化，恢复后会同步截断对话并把原提示词放回输入框；`/snapshots` 保留为诊断入口。
- 默认交互模式是 `yolo`：主 Agent 以当前 OS 用户权限执行普通读写、Bash 和网络操作，不弹日常审批。仅保留不可审批绕过的 hardline、Plan 写操作/可写委派守卫和显式 Hook deny。需要逐次确认高风险操作时使用 `/mode default`。
- `/permissions` 是 `/mode` 的兼容别名，不再维护第二套权限状态。
- `/usage` 展示 provider 实际报告的 token/成本覆盖，缺失字段保持 `unknown`；`/context` 展示当前 route 的上下文预算、来源和能力。
- REST/WebSocket、ACP、飞书与 one-shot CLI 外壳曾在历史阶段完成，后已退役。
- 周期任务优先通过自然语言创建，例如“请创建一个每个工作日上午 9 点生成日报的任务”。Pico 会展示时区、工作区、模型、凭证、daemon、联网范围和未来三次运行时间；只有确认后才写入 Job。第一版不支持一次性定时任务。
- `/cron` 保留为高级入口；任务由当前 OS 用户的本机 daemon 执行，不新增 one-shot/headless 公共 CLI。持久 Cron 仅接受可信工作区的 YOLO Job，Provider 凭证自动检查并导入系统凭证库，SQLite 只保存非秘密 `credentialRef`。
- 新任务默认允许所有符合后台资格的工具联网；该策略覆盖 `fetch_url`、`web_search`、Bash、严格后台 Hook 与固定配置 MCP，但不改变工作区、敏感文件、hardline、Hook deny 和 SSRF 边界。可用 `/cron add --tool-network=allow|disabled|allowlist:host1,host2 ...` 显式覆盖；模型 Provider 网络是独立通道。
- Docker 部署和 Plugin runtime 不在当前产品范围。

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

## 🔐 工作区信任

首次在一个工作区启动 `pico` 时，会在进入 TUI 前询问是否信任该真实目录。只有明确选择信任后，Pico 才会读取项目 `AGENTS.md` / Skills / Session，启用 `.pico/config.json` 中的 Provider 与 LSP，以及 `.claw` 中的 MCP 和 Hook。

信任记录按 `realpath` 持久化到用户目录 `~/.pico/trusted-workspaces.json`；项目内文件不能自行声明信任。未信任工作区在非交互环境中会直接停止，不会默认放行。

## 🔧 环境变量

| 变量           | 必填 | 说明                                      |
| -------------- | ---- | ----------------------------------------- |
| `LLM_BASE_URL` | ✅   | 大模型 API 端点(OpenAI 兼容)              |
| `LLM_API_KEY`  | ✅   | API Key                                   |
| `LLM_MODEL`    | ✅   | 模型名(如 `glm-5.2`)                      |
| `LOG_LEVEL`    | 可选 | 日志级别:debug/info/warn/error(默认 info) |

### 多模型路由

旧的 `LLM_BASE_URL` / `LLM_API_KEY[S]` / `LLM_MODEL` 配置继续可用；Pico 会把它们视为 `legacy/<model>` 路由。需要在 DeepSeek、GLM 等不同端点之间安全切换时，在工作区的 `.pico/config.json` 配置 provider map：

```json
{
  "version": 1,
  "model": "deepseek/deepseek-v4-pro",
  "providers": {
    "deepseek": {
      "protocol": "openai",
      "baseURL": "https://your-deepseek-gateway.example/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"]
    },
    "zhipu": {
      "protocol": "openai",
      "baseURL": "https://your-glm-gateway.example/v1",
      "apiKeyEnv": "ZHIPU_API_KEY",
      "models": ["glm-5.2"]
    }
  }
}
```

把密钥导出到启动 `pico` 的进程环境，配置文件只保存环境变量名：

```bash
export DEEPSEEK_API_KEY=your-deepseek-key
export ZHIPU_API_KEY=your-zhipu-key
```

已安装的 `pico` 不会自动读取当前工作区的 `.env`。仓库内的 `npm run dev` 会通过 `--env-file=.env` 加载 Pico 仓库根目录的 `.env`；其他启动方式请先 `export`，或使用自己的环境加载工具。

`/model` 使用 `providerID/modelID` 作为稳定标识。OpenAI 兼容 provider 默认请求 `GET /models`；显式 `models` 是允许列表，也是端点不支持模型发现时的可靠 fallback。可用 `"discoverModels": false` 完全关闭发现。密钥值不会写入 SessionSettings、状态栏或命令输出。

### 模型能力、worker 沙箱与代码智能

需要请求前能力预检时，可把 `models` 从字符串数组改为 OpenCode 风格的模型能力对象。未显式声明的 vision/reasoning/tool-call/cache 会显示为 `unknown`，不会根据兼容协议擅自推断：

```json
{
  "version": 1,
  "model": "zhipu/glm-5.2",
  "providers": {
    "zhipu": {
      "protocol": "openai",
      "baseURL": "https://your-glm-gateway.example/v1",
      "apiKeyEnv": "ZHIPU_API_KEY",
      "discoverModels": false,
      "models": {
        "glm-5.2": {
          "context": 131072,
          "output": 8192,
          "vision": false,
          "reasoning": true,
          "toolCall": true,
          "cache": false,
          "fallback": false,
          "price": {
            "inputPerMillion": 0.5,
            "outputPerMillion": 0.5,
            "cacheReadPerMillion": null,
            "cacheWritePerMillion": null
          }
        }
      }
    }
  },
  "sandbox": { "network": "deny" },
  "lsp": {
    "servers": [
      {
        "id": "typescript",
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "languages": ["typescript", "javascript"]
      }
    ]
  }
}
```

`sandbox.network` 只约束 Pico 创建的 explore/worker 子代理，不约束主 TUI 的 YOLO。worker 无论主会话处于 `default` / `auto` / `plan` / `yolo` 都使用独立 worktree 和 OS 沙箱；默认禁止 worker Bash 联网，需要时可将 `sandbox.network` 设为 `allow`。macOS 使用 `sandbox-exec`；当前 Linux 没有等价后端时，worker Bash 按 fail-closed 拒绝，主 Agent 的 YOLO 不受影响。

worker 完成后由宿主在最小环境中提交，禁用 Git hooks、fsmonitor、签名和凭据助手；仓库启用自定义 filter/merge driver 时拒绝自动提交/合并。任务关联和合并队列是主 Agent 的内部能力，不向用户暴露 task ID 命令。

代码智能优先使用项目配置的 LSP server，其次发现 PATH 中已安装的 TypeScript/Python/Rust/Go server；不可用时快速降级为渐进式 Repo Map。当前每个 TUI Session 只启动第一个匹配的 LSP，`languages` 尚未实现多 server 路由；混合语言 server pool 已列入后续收口。`lsp.servers[].command` 是宿主直接启动的 language-server 可执行文件，`args` 是其参数；它不是 shell 脚本，也不是 TUI slash command。`code_definition`、`code_references`、`code_symbols`、`code_diagnostics`、`code_call_hierarchy` 和 `repo_map` 属于模型按需激活的内部工具，用户无需手动执行 `/lsp`。

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
