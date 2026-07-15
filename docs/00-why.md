# 第 0 章 · 为什么自己写？

2024 年，我在 GitHub 上搜索 "AI Agent"，看到了数以千计的项目：LangChain、AutoGPT、MetaGPT、CrewAI……它们都承诺用简洁的 API 帮你构建智能体。

我也用过它们。但说实话，每次用到第三周左右，我都会遇到同一个问题：**我想改一个东西，但不知道从哪下手。**

不是因为这些框架做得不好。恰恰相反——它们做得太多了。为了兼容所有场景，它们引入了层层封装。你想让 Agent 在调用 `rm` 之前弹一个飞书审批，对不起，你需要理解三层抽象、改十个文件、祈祷不要破坏别人的 Chain 逻辑。

这就像你只是想换一下汽车的火花塞，但引擎盖是焊死的。你得把整车拆了。

所以就有了 pico-harness。

---

## 不是框架，是"引擎"

我第一次意识到问题，是在用 LangChain 写一个代码审查 Agent 的时候。

需求很简单：Agent 读取一个 PR 的 diff，运行 lint，如果 lint 不过就自动修复，修完再跑一遍测试。听起来三句话就能描述清楚，对吧？

但在 LangChain 里，这个"简单"需求变成了：

```python
from langchain.agents import initialize_agent, Tool
from langchain.llms import OpenAI
from langchain.memory import ConversationBufferMemory
from langchain.chains import LLMChain

# 你需要理解：
# - Agent 类型（zero-shot / conversational / self-ask / ...一共 8 种）
# - Tool 定义与注册（JSON Schema 嵌套了两层）
# - Memory 管理（Buffer / Summary / Entity / ...又是 4 种）
# - Prompt 模板（System / Human / AI Message 三段式）
# - Chain 组合（LLMChain → SequentialChain → RouterChain）

agent = initialize_agent(
    tools=[...],
    llm=OpenAI(),
    agent="conversational-react-description",  # 这名字你第一次看到能猜出意思吗？
    memory=ConversationBufferMemory(memory_key="chat_history"),
    verbose=True
)
```

这只是初始化。接下来你还要处理：

- **工具调用的并发控制**：读三个文件可以并行，但写同一个文件必须串行。LangChain 没这概念——你自己管。
- **上下文窗口管理**：对话超过 32K Token 怎么办？LangChain 的 `ConversationBufferMemory` 只会一直往后堆，直到 API 返回 400。
- **错误恢复**：工具执行失败了，Agent 怎么知道该重试还是该换方案？框架不管——它只负责把报错贴回上下文。
- **成本追踪**：每次请求花了多少钱、多少 Token？没有内建支持。

我当时的感受是：**我不是在写 Agent，我是在学一门"框架学"。** 框架的复杂度已经超过了问题本身的复杂度。

---

## 框架失效的三个原因

冷静下来想，这不是 LangChain 的问题。这是所有"大一统框架"的宿命。

### 1. 大模型每周都在变

GPT-4 Turbo、Claude 3.5 Sonnet、Gemini 2.0、DeepSeek-V3……每个模型的 API 协议、能力边界、最佳实践都在快速变化。

举个例子：Anthropic 的 Claude API 里，`system` 是独立的顶层字段，工具调用是 `content` 数组里的 `tool_use` block。而 OpenAI 的 API 里，`system` 是 `messages` 数组里的一条消息，工具调用是 `tool_calls` 字段。更麻烦的是，Anthropic 还搞了个 Prompt Cache，能在 system prompt 和 tools 定义上设置 `cache_control` 断点，把重复输入的成本降低 75%。

框架要兼容所有这些差异，只能在中间加一层又一层的适配器。等到新模型出来，适配器还没写好。

### 2. 你的需求是定制的

生产环境的 Agent 需要什么？

- 成本控制：简单任务用便宜的模型（GLM-4-Air，输入 1 元/百万 Token），复杂任务切贵的（Claude Sonnet，输入 22 元/百万 Token）
- 安全审批：`rm -rf`、`git push --force` 必须弹飞书卡片等管理员点"同意"
- 链路追踪：每个决策点都要记录下来，事后能逐帧复盘 Agent 为什么选了那条路
- 人机协同：管理员可以随时介入，发一条飞书消息打断 Agent 的当前任务

框架能给你其中一两项。但要全部满足？你大概率得 fork 源码自己改。

### 3. 抽象的代价太高

这是最核心的问题。框架的每一层抽象都在做同一件事：**替你做决定。**

"Agent 类型应该用 conversational-react-description 还是 zero-shot-react-description？"

你根本没想过这个问题。你只是想让它读文件、跑命令。但这个决定已经被框架替你做了——它预设了 ReAct 循环的终止条件、工具调用的格式、上下文的管理方式。当这些预设不匹配你的场景时，你就得绕过去。

**绕不过去的时候，你开始怀疑：我还需要这个框架吗？**

---

## 一次真实的对比：同一个需求，两种写法

让我用一个具体的例子说明差距有多大。

需求：让 Agent 在工作目录下创建一个 `hello.ts` 文件，写入一段 TypeScript 代码，然后用 `tsc` 编译它。如果编译失败，读取错误信息并修复。

**用 LangChain（伪代码，因为实际代码更长）：**

```python
from langchain.agents import create_openai_tools_agent
from langchain.tools import Tool, StructuredTool
from langchain.memory import ConversationBufferMemory
from langchain.chains import LLMChain
from pydantic import BaseModel, Field

# 定义工具参数 Schema
class WriteFileInput(BaseModel):
    path: str = Field(description="文件路径")
    content: str = Field(description="文件内容")

class BashInput(BaseModel):
    command: str = Field(description="要执行的命令")

# 注册工具
tools = [
    StructuredTool.from_function(func=write_file, args_schema=WriteFileInput),
    StructuredTool.from_function(func=run_bash, args_schema=BashInput),
]

# 配置 Memory
memory = ConversationBufferMemory(
    memory_key="chat_history", return_messages=True
)

# 组装 Agent（注意这个字符串，名字变了两次）
agent = create_openai_tools_agent(
    llm=ChatOpenAI(model="gpt-4"),
    tools=tools,
    prompt=CHAT_PROMPT,  # 你还需要自己维护 Prompt 模板
)

# 执行（传入 Memory）
agent_executor = AgentExecutor(
    agent=agent,
    tools=tools,
    memory=memory,
    max_iterations=15,
    handle_parsing_errors=True,  # JSON 解析失败的处理策略
)
result = agent_executor.invoke({"input": "创建 hello.ts 并编译"})
```

**用 pico-harness：**

```bash
npx tsx src/cli/main.ts "在工作目录下创建 hello.ts，写入一段 TypeScript 代码，然后编译它。如果编译失败，读取错误并修复。"
```

区别不是在代码量——虽然确实差了一个数量级。区别在于**心智负担**。

LangChain 版本里，你需要理解：Pydantic Schema、Agent 类型枚举、Memory 类型枚举、Prompt 模板格式、AgentExecutor 的配置项（`max_iterations` vs `max_execution_time` vs `early_stopping_method` 的区别是什么？）、JSON 解析失败的处理策略……你在写胶水代码。

pico 版本里，你不需要写任何代码。引擎内置了 `write_file`、`bash`、`read_file`、`edit_file` 四个工具——它们对应了你 90% 的日常操作。你只需要用自然语言描述任务。Agent 自己决定该调用什么工具、以什么顺序。

这不是"pico 比 LangChain 好"的问题。这是两种哲学的区别：**框架替你定义一切，引擎让你控制一切。**

---

## "驾驭工程"的思考方式

我换了一种思路。

不要框架。要一个**引擎**。

框架和引擎的区别是什么？

- **框架**替你定义了一切：Agent 怎么初始化、工具怎么注册、上下文怎么管理。你只能填充回调函数。框架在驾驶座上，你是乘客。
- **引擎**只做一件事：忠实地执行 ReAct 循环。它不替你定义任何东西——Provider 是你接的，工具是你写的，Prompt 是你组的。**你在驾驶座上，引擎只是油门。**

我把这种思考方式叫做"驾驭工程"（Harness Engineering）。它的核心假设是：

> 大模型是 CPU，上下文是内存，工具是外设。你在写一个微型操作系统。

既然大模型就是 CPU，那你需要的不是一个"Agent 开发框架"，而是一个**操作系统内核**——管理内存（上下文）、调度 IO（工具调用）、处理中断（错误恢复）、记录日志（可观测性）。

pico-harness 就是这个内核。它只有四个核心工具（read / write / edit / bash），因为 UNIX 也只有几十个系统调用。它把 Provider 抽象成一个只有 `generate(messages, tools)` 方法的接口，因为内核不关心你插的是什么型号的 CPU。

### 驾驭工程的三条原则

我在设计 pico-harness 的过程中，逐渐提炼出三条原则。它们不是设计文档里的抽象声明——每条都是被实际问题逼出来的。

**原则一：状态必须外化。** 大模型没有持久记忆。上下文一旦压缩或丢失，Agent 就"失忆"了。所以 Plan Mode（第 6 章）强制 Agent 把计划写在文件系统里（PLAN.md、TODO.md），而不是记在"脑子"里。人类可以随时编辑这些文件来纠正 Agent 的方向——不需要打断它、不需要特殊指令。

**原则二：工具必须极简。** Agent 的能力来自组合，不是来自数量。给 Agent 50 个工具，它会迷失在选择里。给 4 个，组合起来能做一切：read 获取信息，write 创建文件，edit 修改内容，bash 执行任何命令。四个原语，无限可能。

**原则三：安全必须拦截，不是建议。** "请不要删除系统文件"是 Prompt 级别的建议，大模型可能忽略。Middleware 拦截是在执行层强制阻断——无论大模型多自信，`rm -rf /` 不会被执行，除非人类审批通过。安全必须是硬约束，不是软提示。

---

## 四层架构：一个微型 OS 的骨架

如果 Agent Harness 是一个微型 OS，它的架构自然就该是分层的。

我把它分成了四层：

```
┌──────────────────────────────────────┐
│  入口层 (Entry)                       │
│  CLI · 飞书 Bot · HTTP Server        │
├──────────────────────────────────────┤
│  引擎层 (Engine)                      │
│  Main Loop · Session · Reporter      │
├──────────────────────────────────────┤
│  能力层 (Capability)                  │
│  Provider · Tools · Context · Memory │
├──────────────────────────────────────┤
│  基座层 (Foundation)                  │
│  Schema · Logger · Tracer · Pricing  │
└──────────────────────────────────────┘
```

**基座层**是最底层的共享设施。`Schema` 定义了整个系统里流通的数据结构——什么是 Message、什么是 ToolCall、什么是 ToolResult。`Logger` 提供结构化日志，`Tracer` 记录决策路径。这些模块不依赖任何其他 src 模块，是整个系统的"血液"。

**能力层**是四个独立的子系统：

- `Provider`：接大模型。管你是 OpenAI 还是 Claude，对上层只暴露一个 `generate()` 方法。
- `Tools`：接外设。四个基础工具（读写编跑），加上注册、调度、安全中间件。
- `Context`：管内存。上下文组装、压缩、Token 计数、状态外部化。
- `Memory`：管硬盘。跨 Session 的技能记忆、FTS5 全文检索。

它们之间的依赖方向是严格向下的：引擎层依赖能力层，能力层依赖基座层。反过来不行。Provider 不知道 Main Loop 的存在，Tool 不知道 Session 的存在。这种单向依赖让每个模块可以独立测试、独立替换。

**引擎层**只有一件事：Main Loop。它不关心 bash 怎么执行、Claude 的 HTTP 请求格式——它只负责维护一条"上下文时间线"：把模型的意图（ToolCall）交给执行层，再把物理世界的反馈（Observation）追加回内存。它像一个忠实的书记员。

**入口层**是外部世界的接口。CLI 命令行、飞书消息回调、HTTP API——它们都调用同一个 `engine.run()` 方法，只是 Reporter（输出方式）不同。这个设计来自一个痛苦的教训：早期版本我的 CLI 代码里散落着 `console.log`，当我想接入飞书 Bot 时，发现所有输出逻辑都和 CLI 的终端渲染耦合在一起。Reporter 接口（第 1 章会详细讲）就是为了解耦这一层引入的。

这四层加起来，核心代码大约 50 个文件。**没有框架插件系统，没有依赖注入容器，没有抽象工厂套抽象工厂。** 50 个文件，每个文件做一件事，做好。

---

## 为什么是 TypeScript？

pico-harness 的"前身"是课程中用 Go 实现的 `go-pico`。我选择用 TypeScript 重写，有三个原因：

**第一，AI 工具的生态在 Node.js。** Claude Code、Cursor、OpenHands——这些 Agent 工具本身大多运行在 Node.js 生态上。用 TypeScript 写 Agent 引擎，让它天然可以嵌入这些工具做子代理。

**第二，JSON 处理是刚需。** Agent 与模型之间的通信全是 JSON——ToolCall 参数是 JSON，Provider 响应解析是 JSON，RuntimeEvent 也以结构化 JSON payload 写入 SQLite。Go 的 `encoding/json` 需要定义 struct，TypeScript 的 `JSON.parse` 配合 `interface` 零摩擦。

**第三，脚本工具的兼容性。** Agent 最常用的 `bash` 工具本质上是在执行 Shell 命令。Node.js 的 `child_process` 比 Go 的 `os/exec` 更适合作为"Agent 的 Shell 层"，因为大部分开发者的工作流本身就在 npm/node 生态中。

但这本书的重点不是 TypeScript。**语言只是载体，设计才是核心。** 如果你更熟悉 Go 或 Python，完全可以用同样的架构思路移植——Provider 接口、ReAct 循环、Middleware 管道……这些概念和语言无关。

---

## 这不是一本教程

这本书不是教程。我写它，是因为我想理清楚自己到底建了个什么东西。

每一章都是一个我真实遇到的问题：先是跑不通，然后想通了为什么跑不通，最后改了设计让它跑通。这就是费曼学习法——如果你不能简单地解释一件事，说明你还没真正理解它。

每一章的结构是一样的：

1. **问题**：我先描述一个真实遇到的麻烦——Agent 死循环了、上下文爆了、工具调用串行了。
2. **尝试**：我做了什么来修它。通常第一次尝试会失败。
3. **理解**：失败让我学到了什么——为什么 naive 的方案不行，真实约束是什么。
4. **解法**：最终的设计是什么，关键代码长什么样，为什么这次对了。

代码先行，设计后置。重要的不是"这个模块怎么用"，是"为什么会有这个模块"。

我们从最简单的开始：**一个 20 行的 Agent 循环。**

它很蠢——不会停、不会思考、只会死循环。但这就是一切的起点。我们从那里开始修。

[下一章：让它学会呼吸 →](01-breathing.md)
