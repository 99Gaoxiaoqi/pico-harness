# 第 6 章 · 给它装上方向盘

Agent 现在有了记忆、工具体系和上下文管理。但它还是会跑偏。

我见过三种典型的跑偏模式：

1. **任务漂移**：让它重构 `utils.ts`，做着做着它去改 `config.ts` 了——因为"重构 utils 需要先理解 config 的依赖关系"——然后它就忘了最初的任务。
2. **机械重试**：`edit_file` 匹配失败，它不换策略，用完全相同的参数再试一次。又失败。再试。三次之后还在原地打转。
3. **无限循环**：遇到一个超出认知的错误，它在同一个节点上不断重试，直到 Token 烧光。

这三个问题需要三种不同的方向盘。

---

## Plan Mode：把计划写在纸上

第一个问题的根源是：**Agent 的所有状态都在内存里。** 任务目标、当前进度、下一步计划——全在大模型的"脑海"中。问题是，大模型的"记忆"不可靠——它会被新信息冲淡、被上下文压缩裁剪、被注意力偏移覆盖。

你试过这样做吗？Agent 做到第 8 轮，你已经忘了最开始让它干什么。它自己也忘了。大模型的"近因偏差"让它在长对话中逐渐向末尾的上下文倾斜——它更关注最近的几轮对话，而不是最初的任务目标。

解决方法很反直觉：**不要让 Agent 记住计划。让它把计划写出来。**

Plan Mode 的核心机制很简单：在 System Prompt 里注入一条铁律——

```
你必须在工作区维护两个文件：
- PLAN.md: 你的总体计划和当前进度
- TODO.md: 待办事项清单

每次行动前后，检查这两个文件是否反映最新状态。
人类可能随时修改这些文件来纠正你的方向。
```

这听起来像是一个 Prompt 技巧，但实现上是**引擎主动嗅探磁盘**：

```typescript
// src/context/plan-store.ts
async buildPlanContext(): Promise<string> {
  const [plan, todo] = await Promise.all([this.readPlan(), this.readTodo()]);

  if (plan === null && todo === null) {
    // 全新任务：引导 Agent 创建计划文件
    return `这是全新任务。请先用 write_file 创建 PLAN.md（总体计划）和 TODO.md（待办清单）。`;
  }

  // 断点续传：把现有计划注入上下文
  let context = "检测到已有计划文件。请从上次中断处继续，绝对不要覆盖现有内容。\n\n";
  if (plan !== null) context += `## PLAN.md\n${plan}\n\n`;
  if (todo !== null) context += `## TODO.md\n${todo}\n\n`;
  return context;
}
```

关键设计：**人类可以随时改 PLAN.md 和 TODO.md。** 不需要打断 Agent、不需要特殊指令、不需要飞书卡片——直接编辑文件。Agent 下一轮启动时会读取最新版本，自动调整方向。

这是"人机协同"最自然的形态。Agent 不是黑箱——它的计划暴露在文件系统上，人类可以随时介入、随时纠偏。我在做 pico-harness 自己的 Plan Mode 时也这么用：我写 `TODO.md`，Agent 读它，按我的优先级执行。不需要"飞书消息打断"，不需要"Web UI 控制面板"，一个文本文件就够。

### 为什么 Plan Mode 是"状态外部化"的极致实践

Plan Mode 不仅解决了任务漂移。它还实现了**断点续传**。

早期版本里，如果 Agent 在做第 5 轮时进程崩溃了，重启后它是"失忆"的状态——所有上下文在内存里，随着进程一起消失。Plan Mode 把任务状态锚定在磁盘上——只要 PLAN.md 和 TODO.md 还在，新的进程就能从上次中断处继续。

这还意味着**跨 Session 的记忆传递**。你在 Session A 里启动了一个代码迁移任务，因为 Token 预算用完了被迫停止。下次打开 Session B，Agent 看到同一个工作区里的 PLAN.md，立刻就知道了自己上次的任务。

---

## Error Recovery：报错应该是行动指南

第二个问题——机械重试——的根因是：**大模型看不懂报错。**

当 `edit_file` 返回 "未找到 old_text" 时，模型的自然反应不是"让我重新 read_file 确认一下"，而是"可能是我写错了，再试一次"。它不理解这个报错意味着"文件内容已经变了"。

更惨的是 bash 的报错。Agent 执行 `npm install`，返回 200 行输出，最后两行是 `ERR! code E404` 和 `npm ERR! 404 Not Found`。Agent 看了这 200 行，提取出的关键信息是……"安装失败了"。但它不知道该怎么做——是换一个包名？是检查网络？是升级 npm？

我需要把报错从"陈述"变成"行动指南"。不是在工具执行失败时返回原始错误，而是**注入一条救援指令**：

```typescript
// src/context/recovery.ts
export class RecoveryManager {
  analyzeAndInject(toolName: string, rawError: string): string {
    const hint = this.matchHint(toolName, rawError);
    if (!hint) return rawError; // 没有匹配的救援方案，原样返回

    // 拼接：原始报错 + 系统救援指南
    return `${rawError}\n\n[系统救援指南]: ${hint}`;
  }

  private matchHint(toolName: string, rawError: string): string {
    switch (toolName) {
      case "edit_file":
        if (rawError.includes("未找到") || rawError.includes("old_text")) {
          return "你提供的 old_text 与文件当前内容不一致。请先使用 read_file 重新查看文件最新内容，确保 old_text 逐字符一致（含缩进与换行），然后再重试。";
        }
        if (rawError.includes("多处") || rawError.includes("不唯一")) {
          return "你的 old_text 不够具体，命中了多个相同代码块。请在 old_text 中增加更多上下文行数，使其唯一匹配后再重试。";
        }
        break;

      case "read_file":
      case "write_file":
        if (rawError.includes("ENOENT") || rawError.includes("no such file")) {
          return "路径似乎不正确。请不要凭空猜测，先使用 bash 工具执行 ls -la 或 find 确认文件真实路径，然后再重试。";
        }
        if (rawError.includes("permission denied") || rawError.includes("EACCES")) {
          return "你没有权限操作该文件。请检查工作区限制，或者思考是否需要修改其他文件。";
        }
        break;

      case "bash":
        if (rawError.includes("command not found")) {
          return "该命令不可用。请使用 which 确认命令是否存在，或尝试替代命令。";
        }
        if (rawError.includes("E404") || rawError.includes("404")) {
          return "包/模块不存在。请检查名称是否拼写正确，或换一个存在的替代方案。";
        }
        break;
    }
    return "";
  }
}
```

每一个 rescue hint 都遵循一个铁律：**带一个具体的行动指令。** 不是"请检查"，而是"请先使用 read_file 工具"。具体的祈使句，模型执行顺从度明显高于笼统的建议。

注意 RescueManager 用的是**关键字匹配**，不是错误码。这是故意的不优雅——我在注释里写了"生产环境应基于 POSIX 标准错误码做 switch-case"。但关键字匹配有一个好处：它对新出现的报错也能部分命中——只要报错文本里出现了 "not found"，不管是 `ENOENT`、`MODULE_NOT_FOUND` 还是 `404`，都能匹配。这也让 RescueManager 在不需要频繁更新的情况下覆盖了大部分常见错误。

---

## System Reminders：死循环斩断

第三个问题是最危险的：**死循环。** Agent 在同一个节点反复重试，每一轮都消耗 Token、增加成本，但没有任何进展。

为什么 System Prompt 拦不住？有两大行为陷阱：

1. **上下文内容分布偏移**：连续同质错误信息在上下文中占据主导，牵引模型下一步继续生成类似的内容。
2. **近因偏差（Recency Bias）**：模型对上下文末尾的信息响应权重显著高于头部。所以即使 System Prompt 开头写着"连续失败 3 次请停止"，模型也看不到——它眼里只有最近几条报错。

破局之道：**在模型做决定的前一刻，把高优先级引导指令伪装成最新一条 User Message，直接怼到它脸上。**

```typescript
// src/engine/reminder.ts
export class ReminderInjector {
  private readonly consecutiveFailures = new Map<string, number>();

  static fingerprint(toolName: string, args: string): string {
    return createHash("md5").update(toolName).update(args).digest("hex");
  }

  checkAndInject(lastToolCall: ToolCall, lastResult: ToolResult): Message | null {
    const fp = ReminderInjector.fingerprint(lastToolCall.name, lastToolCall.arguments);

    // 工具执行成功 → 清空计数器
    if (!lastResult.isError) {
      this.consecutiveFailures.clear();
      return null;
    }

    // 失败 → 累加
    const failCount = (this.consecutiveFailures.get(fp) ?? 0) + 1;
    this.consecutiveFailures.set(fp, failCount);

    // 连续 3 次同参数失败 → 注入打断消息
    if (failCount >= 3) {
      return {
        role: "user",
        content: `[SYSTEM REMINDER - 死循环警告]
你已经连续 ${failCount} 次用完全相同参数调用 ${lastToolCall.name} 且全部失败。
你的当前策略行不通。请从根本上反思你的方法，不要再次调用 ${lastToolCall.name}。
换一条路走，或者向用户说明当前的困境并寻求指导。`,
      };
    }
    return null;
  }
}
```

关键设计细节：

**指纹用 MD5(toolName + args)，不是只有 toolName。** 如果 Agent 用不同参数调用同一个工具但都失败了——比如 `read_file("src/a.ts")` 失败后又试 `read_file("src/b.ts")`——这不一定是死循环，可能是在排查。只有完全相同的参数重复失败，才是真正的"原地打转"。

**成功即清零。** 只要有一次工具执行成功，所有失败计数器清零。这意味着 Agent 在探索阶段可以有容错空间——它试了 A 方案失败了，试了 B 方案也失败了，但 C 方案成功了，计数器重置。只有"连续"失败才触发干预。

**注入位置是上下文的最末尾。** 利用了模型的近因偏差——把警告放在模型做下一轮决策前最后看到的位置，凭最强近因效应击碎局部执念。

---

## 现在有了什么

Agent 有了三套方向盘：

- **Plan Mode**：状态外部化到 PLAN.md/TODO.md，任务不漂移、断点可续传、人类随时纠偏
- **Error Recovery**：报错变成行动指南，带 15+ 场景的特定救援 Suggestion
- **System Reminders**：MD5 指纹监控死循环，3 次同参失败强行打断

Agent 现在会思考、会执行、会纠错、会停止。但它还有一个致命漏洞：**它可以执行任何 Shell 命令。**

`bash` 工具就是一把上了膛的枪。如果 Agent 被诱导执行 `rm -rf /`，没有任何东西能阻止它。

接下来，给它装上安全阀门。

[下一章：建一道安全防线 →](07-safety.md)
