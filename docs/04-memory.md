# 第 4 章 · 记住上次聊到哪

Agent 现在能做事了。但它有一个致命问题：**每次启动都失忆。**

上一轮它读了 `src/utils.ts`，分析了代码结构，想好了重构方案。下一轮启动时，这些全忘了。它又读了一遍 `src/utils.ts`，又分析了一遍代码结构——每次都在重复同样的工作。

更麻烦的是多端场景。飞书群 A 在重构代码、群 B 在查日志，它们共享同一个上下文历史——Agent 会精神分裂，把群 A 的 `read_file` 结果当成群 B 的上下文。

我需要两样东西：**Session 隔离**和**完整 Model Context 投影**。但很快我发现还需要第三样——**Prompt 动态组装**。因为 System Prompt 不能是一块硬编码的巨石。

---

## Session：每个对话一个沙箱

Session 是最核心的记忆单元。它的设计很简单：**一个 Session = 一个独立的对话上下文，物理隔离。**

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

Session 的关键特性是**物理隔离**。飞书群 A 的 Session 和群 B 的 Session 是完全独立的数据池——它们不共享 `history`、不共享工作区、不共享任何状态。Agent 在群 A 里读到的东西，群 B 完全看不到。

但飞书群 A 的 Session 从哪里来？飞书的 ChatID 就是天然的 Session ID——同一个群的每一条消息都归于同一个 Session。CLI 模式用工作区路径的哈希作为 Session ID。不管从哪个入口进来，Session ID 是唯一且稳定的——重连后还能找回之前的对话。

### 并发安全：Promise 链式队列

多端并发场景下有一个棘手的问题：同一 Session 的多条消息可能同时到达。比如用户在飞书里连发两条消息，引擎同时处理它们——两条消息都在往 `history` 里 push，竞态条件导致上下文错乱。

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

`catch(() => {})` 是一个刻意的不优雅——即使前一条任务失败了，队列也不能阻塞。宁愿放弃一条有问题的请求，也不能让整个飞书群的消息积压。

---

## Model Context：完整历史，按 token 水位整理

Session 保存完整历史，主 Agent 通过 `getModelContext()` 获取副本，不再固定截取最近 20 条。正常阶段模型能看到完整工作链；输入估算达到预算的 85% 后，Engine 才先缩短旧 ToolResult，仍不足时在完整工具批次边界摘要旧前缀。

```typescript
getModelContext(): Message[] {
  return this.history.map(message => ({ ...message }));
}
```

工具协议清理发生在本轮请求投影中：孤儿和重复 ToolResult 被删除，历史缺失结果补占位符；同一批 `toolCalls` 与其全部 results 不会被切到边界两侧。投影修复不污染 Session 原始历史。

`getWorkingMemory(limit)` 仍保留给兼容测试，但不再是主 Agent 的推理策略。

---

## 持久化：关机了也不丢

Model Context 解决了"发给大模型什么"的问题，但 `history` 还只在内存里。进程重启，全部丢失。

我需要持久化。但不想引入 Redis 或 PostgreSQL——太重了。最简单的方案：**事件溯源 JSONL。**

每条消息追加一行 JSON 到文件：

```jsonl
{"type":"message","seq":0,"message":{"role":"system","content":"你是 pico..."}}
{"type":"message","seq":1,"message":{"role":"user","content":"重构 utils.ts"}}
{"type":"message","seq":2,"message":{"role":"assistant","content":"我需要先读文件","toolCalls":[...]}}
{"type":"truncate","seq":15,"fromIndex":5}
```

启动时逐行读取、重建 `history`。关键是容忍错误：文件末尾可能不完整（进程在写入时崩溃），最后一行 JSON.parse 失败了就停，不报错。**健壮性 > 完美性。**

```typescript
// src/engine/session-store.ts
async load(): Promise<SessionRecord[]> {
  let content: string;
  try {
    content = await readFile(this.filePath, "utf8");
  } catch {
    return []; // 文件不存在(首次启动)视为空日志
  }
  const records: SessionRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      logger.warn(`session 末行撕裂: ${line.slice(0, 80)}...`);
      break; // 末行不完整,后面的都不读了
    }
  }
  return records;
}
```

`seq` 字段保证重放的顺序正确——写入是异步的，但 seq 单调递增，启动时按 seq 排序重建。这也是 Kimi Code 和 OpenCode 都遵循的不变量：序列号解耦"写入顺序"和"逻辑顺序"。

---

## FTS5：跨 Session 检索

持久化解决了 Session 内记忆的问题。但 Session 之间的记忆呢？

比如 Agent 在上一个 Session 里学会了一个 MongoDB 查询优化的技巧，下个 Session 遇到类似的慢查询，它应该能"回忆"起来。

这需要一个全文检索引擎。我用了 SQLite 的 FTS5——内嵌、零配置、足够快。

```typescript
// src/memory/fts5-store.ts
// 建表
CREATE VIRTUAL TABLE skills USING fts5(
  title, content, tags, source, token='trigram'
);
```

`token='trigram'` 是中文分词的关键。SQLite 默认的分词器只认空格——对英文工作良好，对中文全失效（"全文检索"被当成一个 Token）。trigram 分词按每三个字符一个 Token 切分，对中英文都适用。

FTS5 建在 Session 之外，存储每个 Session 中学到的"技能"——一段可复用的知识。当新 Session 的 System Prompt 组装时，SkillRegistry 从 FTS5 中搜索相关技能，注入上下文。

---

## Prompt 不是一块巨石

有了 Session 和持久化，最后一个问题是：System Prompt 怎么组织？

早期的版本里，System Prompt 是一大段硬编码字符串——身份定义、红线规则、ReAct 格式说明、工具使用指南……全部拼在一起。结果是 3000+ Token 的 System Prompt，而且所有 Session 共用同一个。无法按工作区定制，无法按需加载技能。

我把它做成了**模块化组装**：

```typescript
// src/context/composer.ts
async build(turnCount: number): Promise<string> {
  const parts: string[] = [];

  // 1. 极简内核 (< 1000 Token):硬编码的身份与红线
  parts.push(MINIMAL_CORE);

  // 2. 工作区守则:读取工作区根目录的 AGENTS.md
  const agentsMd = await this.readAgentsMd();
  if (agentsMd) parts.push(agentsMd);

  // 3. 技能外挂:从 FTS5 搜索相关技能，按需加载
  const skills = this.skillRegistry.search(/* query */);
  if (skills.length > 0) parts.push(formatSkills(skills));

  // 4. Plan Mode 上下文:如果启用，注入 PLAN.md 和 TODO.md
  if (this.planMode) {
    parts.push(await this.planStore.buildPlanContext());
  }

  return parts.join("\n\n---\n\n");
}
```

四层 Prompt，就像操作系统的内核模块：极简内核始终加载，AGENTS.md 提供项目级定制，技能外挂按需挂载，Plan Mode 上下文在需要时动态注入。

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

### 周期性记忆提醒（Memory Nudger）

FTS5 存储了跨 Session 学到的技能。但怎么让 Agent 在当前任务中"想起"这些技能？

Memory Nudger 的做法是：每隔 N 轮（比如每 5 轮），从 FTS5 中搜索与当前话题相关的历史技能，注入一条 User 消息：

```
[记忆提示] 在之前的 Session 中，你学到过以下相关经验：
- MongoDB 慢查询优化：先 explain()，再根据 executionStats 决定加索引还是改查询
- TypeScript 类型安全：遇到 any 类型，优先考虑 unknown + 类型守卫
```

这条消息作为上下文的一部分，模型在下一轮推理时会自然参考。不是强制性的"你必须这样做"，而是柔性的"你之前这样处理过"。这更像人类的记忆触发机制——不是逐字回忆，而是情境关联。

---

## 现在有了什么

Agent 的记忆系统成形了：

- **Session 物理隔离**：每端独立上下文，Promise 链式队列保证并发安全
- **完整 Model Context**：低于 token 水位时传完整历史，工具协议按局部批次修复
- **JSONL 事件溯源**：持久化到磁盘，末行撕裂容忍，seq 保证重放顺序
- **FTS5 跨 Session 检索**：trigram 中文分词，学到的技能跨会话复用
- **Prompt 模块化组装**：内核 + AGENTS.md + Skills + Plan Context 动态拼接

Agent 能记住对话了。但上下文还在不断膨胀——下一章用 token 水位、artifact 与安全摘要控制体积。

所以接下来，给它装一个"垃圾回收器"。

[下一章：别让它撑爆上下文 →](05-compaction.md)
