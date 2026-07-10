# 第 10 章 · 怎么知道它变聪明了

Agent 的所有能力都到位了。但一个根本问题悬而未决：**它真的在变好吗？**

加了一个新功能——比如 Two-Stage ReAct 思考阶段——怎么知道它提高了成功率而不是浪费了 Token？改了压缩策略——怎么知道信息保留质量没有下降？换了模型——Claude 真的比 GPT-4 更适合代码任务吗？

我需要**自动化评测**。

---

## Benchmark：可重复的考试

Benchmark 系统的核心思想很简单：**定义标准考题，跑 Agent，自动判分。**

```typescript
// src/eval/benchmark.ts
interface BenchmarkCase {
  id: string;
  name: string;
  prompt: string; // 给 Agent 的任务描述
  setupScript?: string; // 可选的靶机初始化脚本
  validateScript?: string; // 验收脚本，exit 0 = 通过
}

// 示例用例
const cases = [
  {
    id: "refactor-1",
    name: "提取重复代码",
    prompt: "重构 src/utils.ts，把重复的日期格式化逻辑提取为独立函数。",
    setupScript: "cp -r fixtures/refactor-1/* .", // 准备靶机环境
    validateScript: "npx tsc --noEmit && npm test", // 编译通过 + 测试通过
  },
  {
    id: "fix-bug-1",
    name: "修复空指针异常",
    prompt: "src/api.ts 第 42 行有空指针异常，请修复。",
    validateScript: "npm test -- --testPathPattern=api",
  },
];
```

每个用例是一个独立的"考场"——隔离的工作区、初始化的靶机环境、明确的验收标准。Agent 不知道自己在被考试，它只是正常接收任务、执行工具、返回结果。

验收标准是一段 Shell 脚本——`exit 0` 表示通过，非零表示失败。为什么是 Shell 脚本而不是程序化的断言？因为 Shell 脚本是最通用的"验收语言"——你可以用它检查文件是否存在、是否包含特定字符串、测试是否通过、编译是否成功。它是 Agent 自己也在用的语言。

---

### 三阶段执行

Benchmark Runner 的执行流程分三个阶段：

```
1. Setup    → rm -rf caseDir && mkdir caseDir && run setupScript
2. Run      → agentEngine.run(session, prompt)
3. Validate → run validateScript (exit 0 = PASS)
```

每个阶段都有独立的错误处理。Setup 失败意味着靶机环境有问题（不是 Agent 的错），标记为 `setup_error`。Validate 失败意味着 Agent 没有完成目标——这才是真正的 `failed`。

```typescript
async runCase(c: BenchmarkCase): Promise<BenchmarkCaseResult> {
  const caseDir = join(this.rootDir, c.id);

  // 1. Setup: 清空 + 重建 + 初始化
  await rm(caseDir, { recursive: true, force: true }); // Windows 兼容
  await mkdir(caseDir, { recursive: true });
  if (c.setupScript) await runShell(c.setupScript, caseDir);

  // 2. Run: Agent 执行任务
  const session = new Session(c.id, caseDir);
  await this.runAgent(c.prompt, { case: c, workDir: caseDir, session });

  // 3. Validate: 验收
  if (c.validateScript) {
    await runShell(c.validateScript, caseDir);
    return { id: c.id, name: c.name, passed: true };
  }

  return { id: c.id, name: c.name, passed: false, message: "无验收标准" };
}
```

---

### 评测指标

跑完所有用例后，汇总报告：

```typescript
interface BenchmarkRunResult {
  total: number; // 总用例数
  passed: number; // 通过数
  failed: number; // 失败数
  passRate: number; // 通过率
  durationMs: number; // 总耗时
  usage: BenchmarkUsage; // 总 Token 消耗
  cases: BenchmarkCaseResult[]; // 每个用例的详细结果
}
```

这些指标可以回答核心问题：

- **通过率变化**：加 Two-Stage ReAct 后，5 个重构用例的通过率从 60% 升到 100%
- **Token 效率**：Claude Sonnet 完成同样任务的 Token 消耗比 GLM-5.2 少 30%，但成本高 10 倍
- **速度对比**：Two-Stage ReAct 平均慢 40%（每轮多一次 API 调用），但对重构任务的准确率提升 66%

没有 Benchmark，这些都是猜测。有了 Benchmark，它们是数据。

### 一个真实的 Benchmark 故事

我在实现 Two-Stage ReAct 后跑了 5 个重构用例。结果让我意外：通过率从 60%（3/5）提到了 100%（5/5），但平均每个用例多花了 40% 的 Token。为什么？

查 Trace 发现：Two-Stage ReAct 的规划阶段让 Agent 在动手前想清楚了方案，减少了"改错 → 回退 → 重改"的浪费。虽然每轮多一次 API 调用，但总轮次从平均 8 轮降到了 5 轮。**多花的 Token 在 Thinking 阶段，省下的 Token 在无效重试上。**

这个发现直接影响了我的设计决策：`enableThinking` 默认关闭，但 Benchmark 数据告诉我——对复杂任务（重构、架构设计）应该提示用户开启。于是 CLI 在检测到用户输入包含"重构"、"迁移"、"架构"等关键词时，自动建议加 `--thinking` flag。

这就是 Benchmark 的价值——它不只是报表，它**反向指导产品设计**。

---

## CLI：多种交互模式

写完引擎只是第一步。用户怎么用？

pico 支持五种交互模式，通过 CLI 参数切换：

```bash
# 基础模式：一句话任务
pico "重构 src/utils.ts"

# Plan Mode：长程任务，启用 PLAN.md/TODO.md 状态外部化
pico --plan "把项目从 JavaScript 迁移到 TypeScript"

# 思考模式：复杂任务，启用 Two-Stage ReAct
pico --thinking "排查 src/api.ts 的内存泄漏问题"

# 飞书模式：启动飞书 Bot，接收群消息
pico --feishu --plan --trace

# HTTP 模式：暴露 REST API，供外部系统调用
pico --serve --port 3000
```

CLI 的入口是 `src/cli/main.ts`，它负责解析参数、初始化 Provider 和 Registry、创建 Session、启动 Main Loop。每个入口模式（CLI / 飞书 / HTTP）都调用同一个 `engine.run()` 方法——只是 Reporter 不同：

- CLI 模式：`TerminalReporter`，彩色 Emoji 终端输出
- 飞书模式：Feishu Reporter，卡片消息格式
- HTTP 模式：JSON Reporter，REST API 响应
- Benchmark 模式：`SilentReporter`，零输出，只收数据

这体现了 Reporter 接口的价值——四个完全不同的交互场景，引擎代码零改动。

---

## 飞书 AgentOps

飞书模式是 pico 的"生产部署形态"。启动后，Bot 监听飞书群消息：

1. 用户在飞书群发送消息 → 飞书 Webhook 回调 pico
2. pico 提取 ChatID 作为 Session ID，查询或创建 Session
3. `engine.run(session, message)` 启动 Agent 循环
4. 高危命令触发审批 → 飞书卡片消息 → 管理员点"同意/拒绝"
5. 任务完成 → Reporter 格式化输出为飞书消息卡片

整个流程中，Session 持久化保证断点续传。用户关了飞书再打开，Agent 还记得之前的对话。管理员通过 PLAN.md / TODO.md 随时介入——在文件系统里直接编辑计划文件，无需任何飞书指令。

飞书 Bot 的核心代码在 `src/feishu/bot.ts`，大约 300 行。它做的事情很简单：接收 Webhook → 解析消息 → 调用 engine.run() → 格式化输出 → 发送回复。所有复杂逻辑都在 Engine 层，入口层只做胶水工作。这正是四层架构的设计意图。

### 审批流程在飞书中的实际体验

当 Agent 尝试执行 `rm -rf /var/log/*.gz` 时，Middleware 拦截请求。飞书群里会弹出一张卡片：

```
⚠️ 高危操作审批请求
Agent 试图执行: bash "rm -rf /var/log/*.gz"
同意回复: approve task_abc123
拒绝回复: reject task_abc123
[30 分钟后自动拒绝]
```

管理员回复 `approve task_abc123`，Bot 解析消息，调用 `resolveApproval("task_abc123", true)`，Agent 的执行流从挂起中恢复，正常执行命令。模型完全不知道中间发生了什么——它只感知到"这个 bash 调用比平时慢了几秒"。

---

## 从 0 到 1，再到生产

这本书到这里就结束了。但我们建的远不止一个"Demo 项目"。

pico-harness 是一套完整的 Agent 引擎，大约 50 个源文件。它的每一条能力线都是被真实问题逼出来的：

| 模块            | 被什么问题逼出来的                 |
| --------------- | ---------------------------------- |
| Main Loop       | Agent 需要循环推理，不是一次性回答 |
| Two-Stage ReAct | Agent 不思考就动手，改错代码       |
| Provider 抽象   | 换模型 = 重写全部逻辑              |
| 四工具          | 50 个工具不如 4 个组合             |
| 模糊匹配        | LLM 记不住缩进，edit 总是失败      |
| 并行调度        | 三个 read_file 串行太慢            |
| Session 隔离    | 多端共享上下文，Agent 精神分裂     |
| 阶梯压缩        | 1MB 日志塞爆上下文                 |
| Plan Mode       | 任务做到一半忘了目标               |
| 错误自愈        | Agent 看不懂报错，机械重试         |
| 死循环斩断      | 原地打转烧 Token                   |
| Middleware      | 不能靠 Prompt 防 rm -rf            |
| Subagent        | 串行探索太慢                       |
| CostTracker     | 月底账单对不上                     |
| Tracing         | 失败了不知道在哪一步               |
| Benchmark       | 不知道改进了还是倒退了             |

每一个模块单独看都不复杂。加起来就是一个能跑在 CLl、飞书、HTTP 下的工业级 Agent 引擎。

驾驭工程的核心理念从未改变：**大模型是 CPU，上下文是内存，工具是外设。你在写一个微型操作系统。** 现在你写完了。

[回到起点：为什么自己写？](00-why.md)
