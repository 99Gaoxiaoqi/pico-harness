# 第 4 章 · 记住上次聊到哪

Agent 现在能做事了。但它有一个致命问题：**每次启动都失忆。**

上一轮它读了 `src/utils.ts`，分析了代码结构，想好了重构方案。下一轮启动时，这些全忘了。它又读了一遍 `src/utils.ts`，又分析了一遍代码结构——每次都在重复同样的工作。

更麻烦的是多会话场景。一个对话在重构代码，另一个对话在查日志；如果它们共享同一个上下文历史，Agent 就会把不相关的工具结果混在一起。

我需要两样东西：**Session 隔离**和**完整 Model Context 投影**。但很快我发现还需要第三样——**Prompt 动态组装**。因为 System Prompt 不能是一块硬编码的巨石。

---

## Session：每个对话一条独立运行链

Session 是最核心的记忆单元：**一个 Session = 一条独立的对话历史和运行态。**

```typescript
// src/engine/session.ts
export class Session {
  readonly id: string; // 会话标识
  readonly workDir: string; // 绑定的工作区
  private history: Message[]; // 完整对话历史

  // Token 累计统计
  totalPromptTokens = 0;
  totalCompletionTokens = 0;
  totalCostCNY = 0;
}
```

Session 隔离的是 `history`、设置、Goal、usage 投影和串行运行队列，不隔离工作区本身。同一工作区的多个 Session 仍共享文件、项目配置和同一个 `runtime.sqlite`，但事件都带明确 `session_id`，不会串进另一条模型历史。

新建 CLI Session 使用时间和随机 UUID 生成 ID；`resume` / `continue` 从 RuntimeEvent manifest 找回已有 ID。工作区路径决定状态命名空间和数据库位置，不直接充当 Session ID。

### 并发安全：Promise 链式队列

同一 Session 的多条消息可能同时到达；如果引擎并发处理，它们会竞争同一条 `history`，导致上下文错乱。

我用了一个 **Promise 链式队列**：

```typescript
// Session 内部的串行执行队列
private runQueue: Promise<unknown> = Promise.resolve();

serialize<T>(fn: () => Promise<T>): Promise<T> {
  const task = this.runQueue.then(() => fn());
  this.runQueue = task.catch(() => {}); // 错误不阻塞后续任务
  return task;
}
```

每条新消息排队等待前一条处理完。这保证了 `history` 的读写是串行的，不会出现"读到一半的消息被另一条并发请求修改"的竞态条件。

`catch(() => {})` 保证前一条任务失败后，后续任务仍能继续进入队列。

Promise 队列只约束单个进程。持久化 Session 还会在 workspace 状态根下取得按 `workspaceId + sessionId` 隔离的 owner lease，并持有到 `close()`；第二个进程不能同时打开同一 Session 写入。SQLite 负责事实事务，lease 只负责单写者仲裁，不承载对话数据。

---

## Model Context：完整历史，按 token 水位整理

Session 保存完整历史，主 Agent 通过 `getModelContext()` 获取副本，不再固定截取最近 20 条。正常阶段模型能看到完整工作链；输入估算达到预算的 85% 后，Engine 才先缩短旧 ToolResult，仍不足时在完整工具批次边界摘要旧前缀。

```typescript
getModelContext(): Message[] {
  return this.history.map(message => ({ ...message }));
}
```

工具协议清理发生在本轮请求投影中：孤儿和重复 ToolResult 被删除，历史缺失结果补占位符；同一批 `toolCalls` 与其全部 results 不会被切到边界两侧。投影修复不污染 Session 原始历史。

---

## 持久化：RuntimeEvent 是唯一真源

Model Context 解决了"发给大模型什么"的问题，但 `history` 不能同时充当内存状态和持久化真源。如果消息、run 状态、usage、rewind 和 fork 分散在几套文件中，崩溃后就无法判断哪份数据才是真的。

现在的设计是：**`RuntimeEventStore` 中的不可变事件是 Session/Agent 运行的唯一 durable authority，`Session.history` 只是内存投影。**

```text
AgentRuntime
    │
    ├─ message / tool / model / usage / rewind / fork 事件
    ▼
RuntimeEventStore
    └─ ~/.pico/workspaces/<workspace-id>/runtime.sqlite
             │
             ├─ Session.history 投影
             ├─ Session settings / Goal / usage 投影
             └─ CLI/TUI 会话列表与 Transcript 投影
```

写入顺序也变得明确：

1. 在 SQLite 事务中追加 RuntimeEvent。
2. 以 `(session_id, event_id)` 保证精确一次语义；同 ID 同 payload 可幂等重试，同 ID 不同 payload 直接拒绝。
3. durable commit 成功后，再更新 `Session.history` 等内存投影。
4. 启动时从 RuntimeEvent 重放消息、usage 和 Session state，不信任旧的内存状态。

```typescript
await session.commitMessages(
  { role: "user", content: "重构 utils.ts" },
  { role: "assistant", content: "我需要先读文件" },
);
```

`rewind` 不删除旧消息，而是追加 `history.rewound`事件改变有效历史投影。`fork` 先冻结源会话游标，再通过 forward-only Saga 克隆 sidecar，最后以 `session.forked` 事件作为唯一发布点。如果中途崩溃，下次 CLI/TUI 启动会自动继续未完成操作；在发布事件落盘前，目标 Session 对用户不可见。

这次收敛不再读取、写入或迁移旧 Session JSONL，也移除了重复的 run JSONL 账本。旧数据如果已明确放弃，保留第二套恢复路径反而会让真源重新变得模糊。

---

## Summary sidecar：辅助压缩生命周期

FullCompactor 成功提交 RuntimeEvent 历史后，会写一份 per-session Summary sidecar，供 compaction、rewind 和 fork 的辅助生命周期使用。旧 `memory/summaries.json` 只迁移一次并归档，运行期不再双写或 fallback。

这个 sidecar 不是 Session 恢复真源，也没有跨重启增量摘要读取者；有效模型历史仍从 RuntimeEvent 投影。Pico 当前也没有跨 Session 检索索引、自动学习 Skill 或进程内搜索兜底。

---

## Prompt 不是一块巨石

有了 Session 和持久化，最后一个问题是：System Prompt 怎么组织？

早期的版本里，System Prompt 是一大段硬编码字符串——身份定义、红线规则、ReAct 格式说明、工具使用指南……全部拼在一起。结果是 3000+ Token 的 System Prompt，而且所有 Session 共用同一个。无法按工作区定制，无法按需加载技能。

我把它做成了**模块化组装**：

```typescript
// src/context/composer.ts（简化展示，省略容错和日志）
async build(): Promise<string> {
  const parts: string[] = [MINIMAL_CORE];

  // 1. Plan Mode（可选）
  if (this.planMode) parts.push(await this.planStore.buildPlanContext());

  // 2. 工作区守则
  try {
    parts.push(await readFile(join(this.workDir, "AGENTS.md"), "utf8"));
  } catch {
    // 文件不存在时跳过
  }

  // 3. 显式项目/用户 Skills Catalog
  const skills = await this.skillLoader.loadAll();
  if (skills) parts.push(skills);

  // 4-5. Todo 与当前 Goal
  const todo = await this.todoStore.buildTodoContext();
  const goal = this.goalManager?.buildGoalContext();
  if (todo) parts.push(todo);
  if (goal) parts.push(goal);

  return parts.join("\n\n");
}
```

这些层就像操作系统模块：极简内核始终加载，AGENTS.md 提供项目级定制，显式 Skill Catalog、Plan、Todo 和 Goal 按状态注入。Skill 正文由 `skill_view` 按需读取，不注入运行期自动生成的 Skill。

### AGENTS.md：项目级的"宪法"

`AGENTS.md` 是工作区根目录的一个 Markdown 文件，人类手动编辑。它定义了 Agent 在该项目中的行为准则：

```markdown
# AGENTS.md

## 身份

你是 pico，一个 TypeScript 编码助手。

## 红线

- 不得执行 rm -rf、git push --force 等高危操作
- 修改文件前先读取确认，不盲目覆盖

## 工作风格

- 极简工具集：只用 Read / Write / Edit / Bash 四个原语
- 状态外部化：规划写在 PLAN.md，进度写在 TODO.md
```

Prompt Composer 启动时读取这个文件，拼接到 System Prompt 中。这意味着不同的项目可以有不同的 AGENTS.md——一个前端项目可能要求 Agent 用 Tailwind CSS 和 React hooks，一个后端项目则要求用 Express 和 Prisma。Agent 自动适应项目环境，不需要用户每次手动说明。

## 现在有了什么

Agent 的记忆系统成形了：

- **Session 逻辑隔离**：每条会话独立历史与运行态，Promise 队列和 owner lease 保证单写
- **完整 Model Context**：低于 token 水位时传完整历史，工具协议按局部批次修复
- **RuntimeEvent 事件溯源**：SQLite 事务、稳定游标与精确一次事件 ID 保证可重放
- **Summary sidecar**：只辅助 compaction/rewind/fork，不升级为第二事实源
- **Prompt 模块化组装**：内核 + AGENTS.md + Skills + Plan Context 动态拼接

Agent 能记住对话了。但上下文还在不断膨胀——下一章用 token 水位、artifact 与安全摘要控制体积。

所以接下来，给它装一个"垃圾回收器"。

[下一章：别让它撑爆上下文 →](05-compaction.md)
