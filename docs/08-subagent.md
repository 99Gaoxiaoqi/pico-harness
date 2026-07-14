# 第 8 章 · 一个人不够，招几个帮手

Agent 现在是一个能干的独行侠。但有些任务一个人做太慢了。

比如"分析这个项目的架构"——需要读几十个文件，理解模块依赖，画出结构图。串行读取的话，每个文件需要 IO + 模型理解时间，50 个文件就是几十秒。

但如果能同时派出几个"探子"，每人负责一个子目录，读完各自写总结，最后汇总——效率就是几倍提升。

这就是 Subagent。

> 本章保留委派、上下文隔离和总结收敛的教学主线。`spawn_subagent` 是只读 Explore 的兼容入口；可写任务通过 `delegate_task(mode="worker")` 进入 Shared Worker 或 Isolated Worker。Shared Worker 的目标并发契约见[多 Agent 共享工作区并发规范](architecture/08-multi-agent-concurrency.md)，当前强制 worktree 的 worker 实现将在 OCC 完成后迁移。

---

## 子代理就是一个工具

Subagent 的实现哲学是极简的：**它不是新概念，就是在 Tool Registry 里多注册了一个工具。**

```typescript
// src/tools/subagent.ts
// spawn_subagent 就是一个普通工具，和其他工具一样注册、一样调用
class SubagentTool implements BaseTool {
  name() {
    return "spawn_subagent";
  }

  async execute(args: string): Promise<string> {
    const { task_prompt } = JSON.parse(args);

    // 1. spawn_subagent 专用于 Explore，创建受限的只读 Registry
    const readOnlyRegistry = createReadOnlyRegistry(this.baseRegistry);

    // 2. 启动子代理循环（阻塞等待完成）
    const result = await this.runner.runSub(task_prompt, readOnlyRegistry);

    // 3. 返回总结给主 Agent
    return result.summary;
  }
}
```

主 Agent 调用 `spawn_subagent(task_prompt="分析 src/tools/ 目录的结构")`，就像调用 `read_file` 一样。子代理跑完返回一段总结，主 Agent 把它当工具输出读。

`spawn_subagent` 默认阻塞等待，因为主 Agent 通常需要探索结论才能继续推理。`delegate_task` 还支持批量和后台生命周期；它通过任务状态与完成事件收敛结果，不要求把所有委派都伪装成同步工具。

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

## 爆炸半径限制：按角色授予最小能力

“所有子代理只能读”只适合探索任务，不能作为多 Agent 开发的通用模型。Pico 按任务角色缩小爆炸半径：

- **Explore**：只读 Registry，用于搜索、阅读和分析，不能修改工作区。
- **Shared Worker**：在同一工作目录内写入，仅能触碰 Coordinator 分配的 `writeScopes`；写文件时使用内容指纹 OCC，Git 不是前提。
- **Isolated Worker**：在独立 worktree/沙箱写入，用于高重叠、动态写、强隔离或独立交付；该模式需要 Git。

只读是 Explore 的安全底线；Worker 的安全底线则是最小写入范围、写前版本验证、敏感路径防护和 fail-closed 冲突处理。

```typescript
// Explore Registry：只读 + 有界递归委派
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

## 两种任务模式，两种 Worker 执行模式

子代理有两种工作模式，对应两种典型的委派场景：

**explore 模式**（探索者）：用于调研、分析、信息收集。子代理只读，不生产任何产物。典型场景："探索这个目录的结构，告诉我每个文件的作用"。

**worker 模式**（工作者）：接受明确的交付目标和写入范围，直接产生代码或文档变更。默认选择 Shared Worker；高冲突、动态脚本写入或独立分支交付时选择 Isolated Worker。典型场景："修改 `src/api/` 中的缓存实现并运行相关测试"。

任务模式决定目标和工具能力，`WorkspaceExecutionMode` 决定 Worker 的隔离强度。`explore` 始终只读；`worker` 必须带任务范围，并在 `shared` 与 `worktree` 之间选择。这里不改变现有 `SubagentRole = "leaf" | "orchestrator"` 的编排语义。工作区是否为普通文件夹或 Git 仓库只决定可用能力，不决定 Worker 是否能写。

---

## 并发委派：同时派出多个子代理

单个子代理已经能提速，但真正的威力在于**并发委派**。

```typescript
// 简化伪代码；真实生命周期由 DelegateTaskTool + DelegationManager 协作
export class DelegationManager {
  async delegateBatch(
    tasks: Array<{ task: string; mode: SubagentMode }>,
    registry: Registry,
  ): Promise<DelegationBatchResult> {
    const results = await Promise.all(
      tasks.map((t) => this.runSingleSubagent(t.task, t.mode, registry)),
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
        "只修改任务授权的 writeScopes，超出范围时停止并报告",
        "写入冲突后重新读取并重新生成修改，绝不覆盖后来变化",
        "完成最小相关验证并报告实际变更",
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
  const continuation = await provider.generate(
    [
      {
        role: "user",
        content:
          "你上一轮的总结过于简短。请重新输出一份结构完整、细节充分的总结汇报：包括你探索了哪些文件、发现了什么、关键结论、以及尚存的不确定点。不要调用任何工具，直接用纯文本回答。",
      },
    ],
    [],
  );
  summary = continuation.content;
}
```

这保证了主 Agent 拿到的每一份子代理报告都有足够的信息密度来做决策。

---

## 现在有了什么

委派系统成形了：

- **spawn_subagent 工具**：把子代理伪装成普通工具，主 Agent 无感知
- **上下文隔离**：子代理白纸一张，不污染主上下文
- **分层爆炸半径**：Explore 只读；Worker 使用 writeScopes、OCC 或可选 worktree
- **并发委派**：Promise.all 批量启动，效率数倍提升
- **Agent Profile**：explore/worker 两套人设，按任务类型自动加载
- **Summary 质量控制**：短总结自动触发续写

Agent 现在是"总指挥"——自己能做事，也能派探子做调研。

### 什么时候该用 Subagent，什么时候不该

Subagent 不是银弹。有些场景用了反而更慢：

**该用 Subagent：** 探索未知代码库、分析多个独立目录、并行收集信息，或把可写任务拆成文件范围清晰、相互独立的交付。子代理上下文隔离，但 Shared Worker 看到的是同一个实时工作区。

**不该并行使用 Shared Worker：** 多个任务必须反复修改同一文件、主要工作依赖不可追踪的动态脚本，或子任务强依赖主 Agent 未传递的全局状态。前两类任务应串行，或显式升级到 Isolated Worker；简单单文件操作通常仍由主 Agent 直接完成更快。

一个经验法则：如果主 Agent 需要读超过 5 个文件来做一个决定，考虑派子代理。如果只需要读 1-2 个文件，自己做更快。
