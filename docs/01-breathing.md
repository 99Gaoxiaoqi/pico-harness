# 第 1 章 · 让它学会呼吸

一开始，我写了一个非常蠢的 Agent。大概 20 行代码。

```typescript
// 最简版本：问 → 答 → 结束
const response = await provider.generate(
  [{ role: "user", content: "帮我看看 package.json 里有哪些依赖" }],
  [], // 没有工具
);
console.log(response.content);
```

它能聊天，但不能做事。我需要的是能读文件、改代码、跑命令的助手，不是一个 ChatGPT 套壳。

---

## 让大模型"伸手"

关键问题：大模型本身不能读文件。它只能生成文本。要让它"伸手"，需要给它工具。

ReAct 论文（Reason + Act，2022 年）给了答案：**让模型在"思考"和"行动"之间循环。** 模型先推理下一步该干什么（Reason），然后调用工具执行（Act），看到工具返回的结果（Observe），再推理下一步……直到任务完成。

```
用户输入 → [LLM 推理] → 需要工具? → 执行工具 → 观察结果 → 回到 LLM 推理
                ↓ 不需要
              返回答案
```

翻译成代码，核心循环长这样：

```typescript
// 上下文历史：从 System Prompt 开始，逐渐追加对话
const context: Message[] = [
  { role: "system", content: "你是 pico，一个有文件系统和 Shell 访问权限的编码助手。" },
  { role: "user", content: "帮我看看 package.json 里有哪些依赖" },
];

for (let turn = 0; turn < 50; turn++) {
  // 1. 调用大模型：给它看当前上下文和可用工具列表
  const response = await provider.generate(context, availableTools);

  // 2. 把模型的回复追加到上下文（无论它是说话还是调工具）
  context.push(response);

  // 3. 如果模型没有请求任何工具调用 → 任务完成，退出
  const toolCalls = response.toolCalls ?? [];
  if (toolCalls.length === 0) {
    break;
  }

  // 4. 执行工具调用，收集观察结果
  for (const tc of toolCalls) {
    const result = await registry.execute(tc.name, tc.arguments);
    context.push({
      role: "user",
      content: result.output,
      toolCallId: tc.id, // 把结果关联回对应的工具调用
    });
  }
}
```

这个循环有四个关键设计决策，我花了很长时间才搞清楚：

### 决策 1：`toolCallId` 是推理的"链条"

注意 `toolCallId` 这个字段。它不是可有可无的元数据——**它是维系推理链条的关键。**

大模型调用工具时，会给每次调用一个唯一 ID。当工具执行结果回来时，必须带上这个 ID，模型才知道"这个结果是刚才那个 read_file 的返回，不是那个 bash 的返回"。没有它，模型会在上下文中迷失——它不知道哪个结果对应哪个操作。

这是 ReAct 范式最容易被忽略但最致命的细节。很多框架把 toolCallId 藏在内部不暴露，结果就是当你需要调试"Agent 为什么在第三步做出了错误判断"时，你根本无法追溯因果链。

### 决策 2：`arguments` 是字符串，不是对象

```typescript
interface ToolCall {
  id: string;
  name: string;
  arguments: string; // 注意：是 JSON 字符串，不是 object
}
```

为什么？因为 Main Loop 根本不应该关心工具的参数长什么样。它只是"信使"——把模型说的话（JSON 字符串）原封不动地传给工具。解析 JSON 是工具自己的事。

如果 Main Loop 去 `JSON.parse(tc.arguments)`，它就必须知道每个工具的参数 Schema。那每次加新工具都得改 Main Loop 代码。**延迟解析 = 极致解耦。**

### 决策 3：`maxTurns = 50` 是"理智之墙"

`for (let turn = 0; turn < 50; turn++)` —— 这个 50 不是随便写的。

没有上限的循环 = Agent 可以永远跑下去。如果模型陷入困惑，反复调用同一个工具但始终得不到满意结果，它会一直烧 Token、烧钱、烧时间。

50 是一个经验值：大多数任务在 5-15 轮内完成，50 轮意味着 Agent 有充足的容错空间，但不会失控到烧穿你的 API 账单。

后来我给它加上了更精细的预算管理：

```typescript
// src/engine/budget.ts —— 三层预算体系
export class IterationBudget {
  private turnCount = 0;
  private tokenCount = 0;
  private costCents = 0;

  constructor(
    private maxTurns: number = 50,
    private maxTokens: number = 1_000_000, // 100 万 Token 硬上限
    private maxCostCents: number = 500, // 单次任务最多烧 5 块钱
  ) {}

  canContinue(): boolean {
    if (this.turnCount >= this.maxTurns) return false;
    if (this.tokenCount >= this.maxTokens) return false;
    if (this.costCents >= this.maxCostCents) return false;
    return true;
  }
}
```

三层防线：轮次上限防止死循环，Token 上限防止上下文爆炸，成本上限防止账单失控。缺一不可。我见过一个 Agent 在 12 轮内就烧了 80 块钱——因为它每轮都在读一个 10 万行的文件，Token 消耗是指数级的。

### 决策 4：上下文只会增长，不会缩小

注意 `context.push(response)` 和 `context.push(observation)` —— 每轮都在往数组末尾追加。这个数组永远不会缩短。

这是 ReAct 的"记忆"机制：Agent 能看到自己之前所有的推理和行动，所以它能从错误中学习（"刚才 read_file 失败了，因为路径拼错了，让我修正"）。

但这也是一个定时炸弹。上下文越长，API 调用越贵、越慢，最终会超出模型的上下文窗口（比如 Claude 的 200K Token 或 GPT-4 的 128K Token）。压缩问题我留到第 5 章处理。现在，先让它跑起来。

---

## 循环跑了。但我看不到它在干什么。

20 行代码的循环能跑，但所有输出都是 `console.log` 散落在代码各处。更麻烦的是，这些 `console.log` 是为终端设计的——带有 Emoji、彩色输出、换行符。当我后来想接入飞书 Bot 时，这些终端格式的输出在飞书消息里变成了乱码。

我需要把"引擎做了什么"和"怎么展示给别人看"解耦。

这就是 Reporter 模式：

```typescript
// src/engine/reporter.ts
export interface Reporter {
  onStart(workDir: string, enableThinking: boolean): void;
  onTurnStart(turn: number): void;
  onThinking(): void;
  onToolCall(toolName: string, args: string): void;
  onToolResult(toolName: string, result: string, isError: boolean): void;
  onMessage(content: string): void;
  onFinish(): void;
}
```

这个接口把引擎的生命周期事件全部暴露出来。引擎在关键节点调用 Reporter 的方法，但不关心 Reporter 怎么处理这些事件。你可以注入不同的实现：

- **TerminalReporter**：用 Emoji 和颜色渲染到控制台
- **SilentReporter**：所有方法都是空函数——用于测试或后台批量运行
- **FeishuReporter**（后来加的）：把工具调用结果格式化成飞书卡片消息

Reporter 模式是 pico-harness 里第一个"从痛苦中长出来的设计"。它不是一个架构图上的抽象方块——它来自我凌晨三点看着飞书里乱码的终端颜色代码时的那声叹息。

引擎不需要知道自己在哪运行。它只管跑循环，在关键节点"广播"事件。显示交给 Reporter。

---

## 它跑起来了。但有一个问题。

Agent 能读文件、改代码了。但它有一个让我抓狂的习惯：**它不思考。**

典型场景：我让它"重构 src/utils.ts，把重复的日期格式化逻辑提取出来"。它二话不说，直接调用 `read_file("src/utils.ts")`。

读到文件内容后，它又二话不说，直接调用 `write_file("src/utils.ts", ...)`——内容是一版未经思考的"重构"，实际上只是把函数换了个名字。

这不是我想要的。人类工程师在动手前会先分析：哪里重复了？提取什么函数？签名怎么设计？影响哪些调用方？Agent 也应该这样。

更糟糕的一次：我让它"把项目从 JavaScript 迁移到 TypeScript"。它第一轮就 `write_file("tsconfig.json", ...)`，第二轮到第十轮依次把所有 `.js` 文件改成 `.ts`，但没有更新 import 路径。所有文件都引用了错误的模块扩展名。我让它修复，它开始用 `edit_file` 逐个改 import——改了 40 个文件后，Token 预算耗尽，任务失败。

问题的根源是：**大模型的思考在调用工具的那一刻就中止了。** 它看到 `write_file` 工具可用，就直接调用。它不会停下来想"等等，迁移到 TypeScript 需要同时改文件扩展名和 import 路径，我应该先列个清单"。

---

## 让它先想再做

解决方案很直接，但实现起来有一个巧妙的 trick。

我把它叫做 **Two-Stage ReAct**：每一轮分成两个阶段。

**Phase 1：思考。** 调用大模型，但**不告诉它任何工具**。传入空的工具列表 `[]`。

```typescript
// Phase 1: Thinking —— 传入空工具列表，强制模型只能输出纯文本
const thinkingResponse = await provider.generate(context, []);
// thinkingResponse.content 是模型的思考过程，例如：
// "我需要重构 utils.ts。先分析当前代码结构：有三个地方重复了日期格式化。
//  我打算提取一个 formatDate(date, locale) 函数，放在 src/utils/date.ts。
//  然后更新所有调用点。让我先读一下当前的 utils.ts 确认结构。"
```

大模型看不到任何 JSON Schema，它只能输出纯文本。这强制它**规划**，而不是冲动行事。

**Phase 2：行动。** 把思考结果追加到上下文，然后恢复正常工具列表，让模型执行。

```typescript
// 把思考过程追加到上下文
context.push(thinkingResponse);

// Phase 2: Action —— 恢复完整工具列表
const actionResponse = await provider.generate(context, availableTools);
// 模型看到自己刚才的规划，顺着执行对应的工具调用
```

这里有一个微妙但关键的设计：**Phase 2 能看到 Phase 1 的输出。** 这是大模型自回归特性的巧妙利用——模型生成的下一个 Token 取决于之前所有 Token。当它看到自己刚才写的"让我先读一下当前的 utils.ts 确认结构"，下一个 Token 大概率就是 `read_file("src/utils.ts")` 的工具调用。

不需要额外的规划引擎、不需要 Tree of Thoughts、不需要显式的"计划队列"。**大模型自己就是规划器。**

如果 Phase 1 规划有误（比如模型判断错了文件结构），Phase 2 执行时它会发现"哦，实际读到的文件和我想的不一样"，然后自动调整。这也行得通，因为每一轮都有独立的 Phase 1——Agent 在每轮开始时都能重新审视局势。

---

## 开关设计：不是所有任务都需要思考

Two-Stage ReAct 好，但它会让每轮调用变成两次 API 请求。简单任务（"package.json 里有哪些依赖"）不需要思考阶段。每次思考阶段额外消耗几百 Token——累积起来，一个简单任务也会多花几毛钱。

所以我把思考阶段做成一个开关：

```typescript
// 构造 AgentEngine 时决定是否启用慢思考
const engine = new AgentEngine({
  provider,
  registry,
  workDir: "./project",
  enableThinking: false, // 默认关闭。简单任务不需要思考阶段。
});
```

`enableThinking` 默认是 `false`。对于复杂任务（重构、调试、架构设计），用户手动开启。这是一个实用主义的折中：**简单任务保持快速，复杂任务获得深度。**

在 CLI 中，用户通过 `--thinking` flag 控制：

```bash
# 简单任务，不开思考
pico "列出 package.json 的依赖"

# 复杂任务，开思考
pico --thinking "把这个项目从 JS 迁移到 TS，确保所有 import 路径正确"
```

后来我发现，这个开关和模型原生的"思考强度"（比如 Claude 的 extended thinking 或 OpenAI 的 reasoning_effort）是两个正交的维度：

- `enableThinking`：应用层控制——要不要在调用工具之前先强制模型输出一段文本规划。这是 pico 在 Prompt 层面做的，所有模型都支持。
- `thinkingEffort`：模型层控制——要不要让模型在生成每个 Token 时投入更多"内部思考"（对用户不可见）。这是模型厂商提供的功能，只有部分模型支持。

两者可以同时开启，互不干扰。`enableThinking` 强制模型"说出"它的计划（对人类可见），`thinkingEffort` 让模型在生成计划时投入更多算力。这个区分是 pico-harness 独有的——大多数框架把它们混为一谈。

---

## 回看：loop.ts 的真实结构

上面展示的 20 行循环是概念上的。实际的 `src/engine/loop.ts` 大约 500 行，因为要处理更多现实问题：

```typescript
// loop.ts 的真实签名（简化）
export async function runLoop(
  session: Session,
  provider: LLMProvider,
  registry: Registry,
  reporter: Reporter,
  options: {
    enableThinking: boolean;
    workDir: string;
    budget: IterationBudget;
    compactor: Compactor;
    tracer: Tracer;
    recoveryManager: RecoveryManager;
    reminderInjector: ReminderInjector;
    // ... 更多
  },
): Promise<void>;
```

看起来很多参数，但每一个都是被现实问题逼出来的：

- `Session`：我们不直接操作 `context` 数组了。Session 管理持久化——Agent 可以休眠、被中断、被唤醒（第 4 章）。
- `Compactor`：上下文太长的时候自动压缩（第 5 章）。
- `RecoveryManager`：工具报错时注入修复建议（第 6 章）。
- `ReminderInjector`：检测到死循环时强行打断（第 6 章）。
- `Tracer`：记录每次决策，事后复盘（第 9 章）。

这些都不是从架构图里来的。每一个都是"Agent 在生产环境里跑崩了"之后加上的。

---

## 现在有了什么

我们有一个约 500 行的引擎核心（算上 Reporter 和 Budget）。它能：

- 在"推理 → 行动 → 观察"的循环中自主完成任务
- 在需要深度规划时切换到 Two-Stage 模式（Phase 1 纯思考 + Phase 2 行动）
- 通过 Reporter 将执行过程广播给不同的展示层（终端 / 飞书 / HTTP）
- 在三层预算（轮次 / Token / 成本）的限制下安全运行

但它还有一个致命问题：**它只能用一种大模型。**

代码里直接写了 `provider.generate(context, tools)`，但如果我想从 OpenAI 换成 Claude 呢？两个 API 的请求格式完全不同——OpenAI 用 `messages` 数组和 `tool_calls` 字段，Claude 用 `system` 顶层字段和 `content` 数组里的 `tool_use` block。

如果 Main Loop 直接耦合某个厂商的协议，换模型等于重写全部逻辑。我踩过这个坑——最初用 OpenAI 写的循环，换成 Claude 后整整改了两天。

所以接下来，我要给它装一个"同声传译员"——Provider 抽象层。一个接口，多种实现，引擎不关心背后是谁在推理。

[下一章：接上不同的大脑 →](02-provider.md)
