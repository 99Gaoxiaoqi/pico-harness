# 第 8 章 · 一个人不够，招几个帮手

Agent 现在是一个能干的独行侠。但有些任务一个人做太慢了。

比如"分析这个项目的架构"——需要读几十个文件，理解模块依赖，画出结构图。串行读取的话，每个文件需要 IO + 模型理解时间，50 个文件就是几十秒。

但如果能同时派出几个"探子"，每人负责一个子目录，读完各自写总结，最后汇总——效率就是几倍提升。

这就是 Subagent。

---

## 子代理就是一个工具

Subagent 的实现哲学是极简的：**它不是新概念，就是在 Tool Registry 里多注册了一个工具。**

```typescript
// src/tools/subagent.ts
// spawn_subagent 就是一个普通工具，和其他工具一样注册、一样调用
class SubagentTool implements BaseTool {
  name() { return "spawn_subagent"; }

  async execute(args: string): Promise<string> {
    const { task, mode } = JSON.parse(args);

    // 1. 创建受限的只读 Registry（爆炸半径限制）
    const readOnlyRegistry = createReadOnlyRegistry(this.baseRegistry);

    // 2. 启动子代理循环（阻塞等待完成）
    const result = await this.runner.runSub(task, readOnlyRegistry);

    // 3. 返回总结给主 Agent
    return result.summary;
  }
}
```

主 Agent 调用 `spawn_subagent(task="分析 src/tools/ 目录的结构")`，就像调用 `read_file` 一样。子代理跑完返回一段总结，主 Agent 把它当工具输出读。

为什么是"阻塞等待"而不是"异步通知"？因为主 Agent 需要子代理的结论才能做下一步决策。异步通知意味着主 Agent 要在不知道结果的情况下继续推理——这违背了 ReAct 的"观察后推理"原则。

---

## 上下文隔离：子代理的脑子是干净的

这是 Subagent 最核心的设计：**子代理拥有全新的、独立的上下文。**

它不是主 Agent 上下文的一个分支——它是一张白纸。子代理看不到主 Agent 的历史对话、看不到主 Agent 之前的推理、看不到其他子代理的工作。

```
主 Agent 上下文                 子 Agent 上下文
┌──────────────────┐           ┌──────────────────┐
│ System Prompt    │           │ System Prompt    │
│ 用户: 分析项目    │           │ 任务: 分析 tools/ │
│ Agent: 我先看看.. │    ≠     │ Agent: read_file  │
│ Tool: read_file  │           │ Tool: ls tools/   │
│ Agent: 结构是...  │           │ Agent: 总结...    │
└──────────────────┘           └──────────────────┘
        ↕ 只有最终总结传递
```

子代理疯狂 `read_file`、跑 `bash`、分析代码——但它产生的上下文不会污染主 Agent。子代理完成后，只有一段总结（几百字）回到主 Agent 的上下文。

这解决了两个问题：

1. **上下文膨胀**：如果主 Agent 自己读 50 个文件，每条 read_file 的结果都会留在上下文里，迅速撑爆窗口。子代理把 50 个文件的探索结果浓缩成一段总结。
2. **注意力污染**：探索过程中的错误、弯路、无关发现——都不会进入主 Agent 的视野。主 Agent 只看到"结论"，不看到"过程"。这就像你让实习生去调研一个技术方案——你不需要看他查了多少 StackOverflow、走了多少弯路，你只需要看他的调研报告。

---

## 爆炸半径限制：子代理只能读，不能写

子代理没有 `write_file` 和 `edit_file` 工具。只有 `read_file`、`bash`（受限）和 `spawn_subagent`（递归委派）。

这是安全底线——"爆炸半径限制"。如果子代理出错（幻觉、死循环、错误分析），它能造成的破坏是有限的：最多浪费一些 Token 和时间。它不能改代码、不能删文件、不能提交 Git。

```typescript
// 创建子代理专用 Registry：只读 + 递归委派
function createReadOnlyRegistry(baseRegistry: Registry): Registry {
  const subRegistry = new ToolRegistry();

  // 只复制只读工具
  for (const tool of baseRegistry.getAllTools()) {
    if (tool.readOnly) {
      subRegistry.register(tool);
    }
  }

  // 子代理也可以委派（递归深度有限制）
  subRegistry.register(new SubagentTool(subRegistry, { maxDepth: 2 }));

  return subRegistry;
}
```

递归委派的深度限制（默认 2 层）防止无限递归——子代理派孙代理，孙代理派曾孙代理……最终把系统资源耗尽。深度限制就像操作系统的进程树深度限制，是防止 fork bomb 的必要措施。

---

## 两种模式：explore 和 worker

子代理有两种工作模式，对应两种典型的委派场景：

**explore 模式**（探索者）：用于调研、分析、信息收集。子代理只读，不生产任何产物。典型场景："探索这个目录的结构，告诉我每个文件的作用"。

**worker 模式**（工作者）：虽然工具集仍然受限（只读），但可以通过主 Agent 间接产生副作用。子代理提出方案 → 主 Agent 审查 → 主 Agent 执行写入。典型场景："分析 src/api/ 目录的性能瓶颈，给出优化方案"。

两种模式的区别在于 System Prompt：explore 模式下 Prompt 强调"你是调研者，你的目标是信息收集"；worker 模式下 Prompt 强调"你是执行者，请给出可操作的具体方案"。

---

## 并发委派：同时派出多个子代理

单个子代理已经能提速，但真正的威力在于**并发委派**。

```typescript
// src/tools/delegation-manager.ts
export class DelegationManager {
  async delegateBatch(
    tasks: Array<{ task: string; mode: SubagentMode }>,
    registry: Registry,
  ): Promise<DelegationBatchResult> {
    const results = await Promise.all(
      tasks.map(t =>
        this.runSingleSubagent(t.task, t.mode, registry)
      )
    );
    return mergeResults(results);
  }
}
```

主 Agent 可以在一轮中同时派出 3-5 个子代理，分别负责不同的子任务。子代理之间的上下文完全隔离，互不干扰。全部完成后，主 Agent 汇总所有总结，形成全局判断。

### Agent Profile：每个子代理有自己的人设

不同类型的委派需要不同的"人设"。explore 代理需要是"严谨的研究员"——只看不评，客观汇报。worker 代理需要是"务实的工程师"——给出可操作的方案。

```typescript
// src/tools/agent-profile.ts
export function getProfile(role: SubagentRole, mode: SubagentMode): AgentProfile {
  if (mode === "explore") {
    return {
      identity: "你是一个代码探索专家。你的任务是对指定目录或文件进行深入分析。",
      constraints: [
        "只读操作——只能 read_file 和 bash（ls/find/grep 等）",
        "不要修改任何文件",
        "结束时用纯文本输出结构化的分析总结",
      ],
    };
  }
  if (mode === "worker") {
    return {
      identity: "你是一个任务执行专家。主架构师给你分配了一个明确的子任务。",
      constraints: [
        "只读——你可以分析代码，但不能修改",
        "提出具体可操作的方案，主架构师会审查后执行",
        "如果有不确定的地方，明确指出而不是猜测",
      ],
    };
  }
}
```

Profile 决定了子代理的 System Prompt。它不是硬编码在主代理的逻辑里——主代理只是说"spawn a subagent for exploring src/"，子代理的 Registry 根据 mode 自动加载对应的 Profile。这保持了主代理的简洁性：它不关心子代理是怎么被"教育"的。

### Summary 质量控制

子代理返回的总结可能太短。如果 summary 少于 200 字符，可能暗示子代理"偷懒"了——它没有深入分析，只是草草应付。引擎会触发一轮续写：

```typescript
if (summary.length < SUBAGENT_SUMMARY_MIN_CHARS) {
  // 要求子代理重新输出更详细的汇报
  const continuation = await provider.generate([
    { role: "user", content: "你上一轮的总结过于简短。请重新输出一份结构完整、细节充分的总结汇报：包括你探索了哪些文件、发现了什么、关键结论、以及尚存的不确定点。不要调用任何工具，直接用纯文本回答。" }
  ], []);
  summary = continuation.content;
}
```

这保证了主 Agent 拿到的每一份子代理报告都有足够的信息密度来做决策。

---

## 现在有了什么

委派系统成形了：

- **spawn_subagent 工具**：把子代理伪装成普通工具，主 Agent 无感知
- **上下文隔离**：子代理白纸一张，不污染主上下文
- **爆炸半径限制**：只读工具集 + 递归深度限制
- **并发委派**：Promise.all 批量启动，效率数倍提升
- **Agent Profile**：explore/worker 两套人设，按任务类型自动加载
- **Summary 质量控制**：短总结自动触发续写

Agent 现在是"总指挥"——自己能做事，也能派探子做调研。

### 什么时候该用 Subagent，什么时候不该

Subagent 不是银弹。有些场景用了反而更慢：

**该用 Subagent：** 探索未知代码库、分析多个独立目录、并行收集信息。子代理之间无依赖，上下文互不污染。

**不该用 Subagent：** 需要修改代码的任务（子代理只读）、需要理解全局状态的任务（子代理看不到主 Agent 的推理链条）、简单的单文件操作（启动子代理的开销大于直接 read_file）。

一个经验法则：如果主 Agent 需要读超过 5 个文件来做一个决定，考虑派子代理。如果只需要读 1-2 个文件，自己做更快。
