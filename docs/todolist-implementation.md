# pico TodoList 实现详解

> 本文以 pico-harness 的实际代码为基础，完整梳理 TodoList 功能从存储到提示词注入的全链路实现。

## 一、设计定位

pico 的 TodoList 解决一个问题：**让模型在多轮 ReAct 循环中保持对任务进度的感知**。

核心设计选择是**系统注入式**——不依赖模型"自觉"维护列表，而是由 harness 每轮自动把最新状态注入上下文。这与 Claude Code 的"全量替换"模式（模型通过 TodoWrite 工具自己维护列表）是两种不同思路。

| 维度         | pico（系统注入）                       | Claude Code（全量替换）          |
| ------------ | -------------------------------------- | -------------------------------- |
| 谁维护列表   | 系统（每轮读存储注入）                 | 模型（每次调工具传完整列表）     |
| 列表出现位置 | user 消息末尾 `<current-turn-context>` | assistant 的 `tool_use` 参数     |
| 工具操作模式 | 增量（add/update/toggle/remove）       | 全量替换（TodoWrite 传整个数组） |
| 操作返回值   | 操作确认 + 完整列表快照                | 短确认 "Todos updated"           |
| 模型不操作时 | 系统仍每轮注入最新列表                 | 靠上下文里的旧 tool_use          |

---

## 二、三层架构

```
┌─────────────────────────────────────────────────┐
│                  LLM（大模型）                    │
│         生成 tool_call / 读取注入的列表            │
├─────────────────────────────────────────────────┤
│              TodoTool（工具层）                    │
│    add / update / toggle / remove / list          │
│    操作后返回完整列表快照                           │
├─────────────────────────────────────────────────┤
│             TodoStore（存储层）                    │
│    内存缓存 + todo.json 持久化                     │
├─────────────────────────────────────────────────┤
│          PromptComposer（注入层）                   │
│    每轮从 TodoStore 读取最新状态                    │
│    渲染成 Markdown 注入 turnTail                   │
└─────────────────────────────────────────────────┘
```

---

## 三、存储层：TodoStore

**文件**：`src/context/todo-store.ts`

### 数据结构

```typescript
interface TodoItem {
  id: number; // 自增 ID，从 1 开始
  content: string; // 任务内容
  status: TodoStatus; // "pending" | "in_progress" | "completed"
  priority: TodoPriority; // "high" | "medium" | "low"
}

interface TodoState {
  items: TodoItem[];
  nextId: number;
}
```

### 存储路径

```
<workspace>/.pico/state/todo.json
```

### 持久化机制

```typescript
export class TodoStore {
  private state: TodoState = { items: [], nextId: 1 };
  private loaded = false;

  // 首次操作时从磁盘加载，之后走内存缓存
  async load(): Promise<TodoState> {
    if (this.loaded) return this.state;
    // 读 todo.json → 解析 → normalizeState → 缓存到内存
    this.loaded = true;
    return this.state;
  }

  // 每次变更后落盘
  async save(): Promise<void> {
    // mkdir recursive → writeFile todo.json (mode 0o600)
  }
}
```

**关键设计**：

- **内存优先**：所有变更先落到内存缓存，再异步落盘
- **幂等加载**：`load()` 只首次真正读盘，之后走缓存
- **单例共享**：host 注入同一 TodoStore 实例给 TodoTool 和 PromptComposer，保证跨组件实时可见

### 五个操作方法

```typescript
// 添加任务
async add(content: string, priority: TodoPriority = "medium"): Promise<TodoItem>

// 更新任务（部分字段）
async update(id: number, patch: Partial<Pick<TodoItem, "content" | "priority" | "status">>): Promise<TodoItem | undefined>

// 循环切换状态：pending → in_progress → completed → pending
async toggle(id: number): Promise<TodoItem | undefined>

// 删除任务
async remove(id: number): Promise<boolean>

// 获取排序列表（优先级高→低，同优先级按 id 升序）
list(): TodoItem[]
```

### 渲染为 Markdown

```typescript
async buildTodoContext(): Promise<string> {
  await this.load();
  const items = this.list();
  if (items.length === 0) return "";  // 空列表不注入

  const lines = ["## 📋 当前 TodoList"];
  for (const item of items) {
    lines.push(`- ${statusMark(item.status)} #${item.id} (${item.priority}) ${item.content}`);
  }
  return lines.join("\n");
}
```

输出示例：

```markdown
## 📋 当前 TodoList

- [~] #1 (high) 实现登录
- [ ] #2 (medium) 实现注册
- [x] #3 (low) 写测试
```

---

## 四、工具层：TodoTool

**文件**：`src/tools/todo.ts`

TodoTool 是模型可以调用的工具，提供 `add/update/toggle/remove/list` 五个操作。

### 工具定义

```typescript
definition(): ToolDefinition {
  return {
    name: "todo",
    description: "管理任务清单,支持 add/update/toggle/remove/list 操作",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["add", "update", "toggle", "remove", "list"] },
        content: { type: "string", description: "任务内容(add 时必填)" },
        id: { type: "number", description: "任务 id" },
        priority: { enum: ["high", "medium", "low"] },
        status: { enum: ["pending", "in_progress", "completed"] },
      },
      required: ["action"],
    },
  };
}
```

### 返回值：操作确认 + 完整快照

每次写操作后返回**操作确认 + 完整列表快照**，让模型看到全局状态：

```typescript
// 新增 renderSnapshot 方法
private async renderSnapshot(): Promise<string> {
  const context = await this.store.buildTodoContext();
  return context || "📋 当前清单为空";
}

// handleAdd — 返回确认 + 快照
const item = await this.store.add(content, priority);
return `✅ 已添加任务 #${item.id} (${item.priority}): ${item.content}\n\n${await this.renderSnapshot()}`;

// handleToggle — 返回确认 + 快照
const toggled = await this.store.toggle(id);
return `✅ 已切换任务 #${toggled.id} 状态: ${formatItem(toggled)}\n\n${await this.renderSnapshot()}`;
```

返回示例：

```
✅ 已切换任务 #1 状态: [~] (high) 实现登录

## 📋 当前 TodoList
- [~] #1 (high) 实现登录
- [ ] #2 (medium) 实现注册
```

---

## 五、注入层：PromptComposer + turnTail

**文件**：`src/context/composer.ts`、`src/engine/loop.ts`

### 分层设计

pico 的上下文分为两层，以 **prompt cache** 为分界线：

```
systemPrompt（冻结，缓存命中）
├── 核心身份
├── 用户级 AGENTS.md（~/.pico/AGENTS.md）
├── 项目级 AGENTS.md（project/AGENTS.md）
└── Skills 技能清单

turnTail（每轮重建，追加到 user 消息）
├── <env> 环境信息（date 每轮刷新）
├── TodoList 状态（每轮最新）         ← 这里
├── Goal 状态（每轮最新）
└── Memory recall
```

**为什么 TodoList 放 turnTail 而不是 systemPrompt**：

- TodoList 状态每轮都可能变化
- 放 systemPrompt 会破坏前缀缓存
- 放 turnTail（user 消息）不影响 system 前缀缓存

### PromptComposer 组装

```typescript
// composer.ts — buildLayers()
async buildLayers(): Promise<PromptLayers> {
  const stableParts: string[] = [];
  const turnTailParts: string[] = [];

  // --- turnTail 部分 ---
  // 0. 环境信息
  turnTailParts.push(`# 环境信息\n<env>...\n</env>`);

  // 4. TodoList 状态（每轮从 TodoStore 读取最新）
  const todoContext = await this.todoStore.buildTodoContext();
  if (todoContext) turnTailParts.push(todoContext);

  // 5. Goal 状态
  if (this.goalManager) {
    const goalCtx = this.goalManager.buildGoalContext();
    if (goalCtx) turnTailParts.push(goalCtx);
  }

  return {
    systemPrompt: stableParts.join("\n\n"),
    turnTail: turnTailParts.join("\n\n"),
  };
}
```

### Engine Loop 每轮重建

```typescript
// loop.ts — runInMainCompactorScope()

// systemPrompt 冻结（循环前构建一次）
const { systemPrompt } = await this.buildPromptLayers(currentUserPrompt, signal);
let turnTail = "";

for (;;) {
  turnCount++;

  // ★ 每轮重建 turnTail（TodoStore/GoalManager 是共享单例，返回最新状态）
  if (this.promptLayersFactory) {
    const fresh = await this.buildPromptLayers(currentUserPrompt, signal);
    turnTail = fresh.turnTail;
  }

  // 用最新的 turnTail 组装上下文
  const context = appendTurnTail(
    sanitizeToolPairs([{ role: "system", content: systemPrompt }, ...rawHistory]),
    turnTail,
  );

  // 发送给 LLM
  const response = await this.provider.generate({ messages: context, tools });
}
```

### appendTurnTail 追加到 user 消息

```typescript
// loop.ts:251
function appendTurnTail(messages: Message[], turnTail: string): Message[] {
  // 找到最后一条可见 user 消息
  const currentUserIndex = messages.findLastIndex(
    (m) =>
      m.role === "user" &&
      m.toolCallId === undefined &&
      m.providerData?.picoHiddenFromTranscript !== true,
  );

  // 把 turnTail 追加到这条消息末尾
  messages[currentUserIndex] = {
    ...currentUser,
    content: `${currentUser.content}\n\n<current-turn-context>\n${turnTail}\n</current-turn-context>`,
  };
  return messages;
}
```

---

## 六、完整流程：一次多轮对话

### 场景：用户说"帮我实现登录注册"

```
═══════════════════════════════════════════
Turn 1：创建任务清单
═══════════════════════════════════════════

系统组装上下文：
  system: "你名叫 pico...（冻结）"
  user: "帮我实现登录注册\n\n<current-turn-context>
    # 环境信息
    <env>Working directory: /project</env>
    </current-turn-context>"
    （TodoList 为空，不注入）

LLM 回复：
  assistant: "我来帮你实现。先创建任务清单。"
  + tool_call: todo({ action: "add", content: "实现登录", priority: "high" })
  + tool_call: todo({ action: "add", content: "实现注册", priority: "medium" })

harness 执行 todo add × 2：
  TodoStore.add("实现登录", "high") → todo.json 写入 #1
  TodoStore.add("实现注册", "medium") → todo.json 写入 #2

tool_result × 2：
  "✅ 已添加任务 #1 (high): 实现登录\n\n## 📋 当前 TodoList\n- [ ] #1 实现登录\n- [ ] #2 实现注册"
  "✅ 已添加任务 #2 (medium): 实现注册\n\n## 📋 当前 TodoList\n- [ ] #1 实现登录\n- [ ] #2 实现注册"

═══════════════════════════════════════════
Turn 2：开始工作 + 标记进行中
═══════════════════════════════════════════

系统每轮重建 turnTail（读到 todo.json 有 2 条任务）：
  system: "你名叫 pico...（冻结，字节不变）"  ← 缓存命中
  user: "帮我实现登录注册\n\n<current-turn-context>
    <env>Working directory: /project</env>
    ## 📋 当前 TodoList
    - [ ] #1 (high) 实现登录     ← 系统自动注入最新列表
    - [ ] #2 (medium) 实现注册
    </current-turn-context>"

LLM 看到列表 → 开始写代码 + 标记进行中：
  assistant: "开始实现登录。"
  + tool_call: todo({ action: "toggle", id: 1 })

harness 执行 toggle：#1 pending → in_progress
tool_result: "✅ 已切换任务 #1 状态: [~] 实现登录\n\n## 📋 当前 TodoList\n- [~] #1 实现登录\n- [ ] #2 实现注册"

═══════════════════════════════════════════
Turn 3：继续工作
═══════════════════════════════════════════

系统每轮重建 turnTail：
  system: "你名叫 pico...（冻结，字节不变）"  ← 缓存命中
  user: "帮我实现登录注册\n\n<current-turn-context>
    <env>Working directory: /project</env>
    ## 📋 当前 TodoList
    - [~] #1 (high) 实现登录     ← 状态已是 in_progress
    - [ ] #2 (medium) 实现注册
    </current-turn-context>"
  assistant: tool_call(todo, toggle #1)
  user: tool_result("✅ ...")
  assistant: "登录功能已实现。写注册..."
  + tool_call: todo({ action: "toggle", id: 1 })   ← 标记完成

harness 执行 toggle：#1 in_progress → completed
tool_result: "✅ 已切换任务 #1 状态: [x] 实现登录\n\n## 📋 当前 TodoList\n- [x] #1 实现登录\n- [~] ..."

═══════════════════════════════════════════
Turn N：所有任务完成
═══════════════════════════════════════════

系统注入最新列表：
  user: "帮我实现登录注册\n\n<current-turn-context>
    ## 📋 当前 TodoList
    - [x] #1 (high) 实现登录     ← 全部完成
    - [x] #2 (medium) 实现注册
    </current-turn-context>"

LLM：所有任务已完成，输出最终总结。
```

---

## 七、缓存安全性验证

### 核心原理

```
Provider 的 prompt cache 只看 system 消息前缀。

system 消息：[冻结不变] → SHA-256 哈希每轮相同 → 缓存命中
user 消息：  [turnTail 变化] → 不影响 system 前缀缓存
```

### 实测验证

```
[systemHash 各轮]
  1472f731408d374c6aac...  (Turn 1)
  1472f731408d374c6aac...  (Turn 2)  ← 完全相同！缓存命中 ✅

[userTailHash 各轮]
  5eeb258d58666870f577...  (Turn 1)  todo: [ ] pending
  a63c9af6586aa7801854...  (Turn 2)  todo: [~] in_progress  ← 变了
```

### 为什么安全

| 层                     | 是否变化 | 缓存影响                   |
| ---------------------- | -------- | -------------------------- |
| system prompt          | 冻结     | 前缀哈希不变 → 命中        |
| tool schema            | 冻结     | 前缀哈希不变 → 命中        |
| user 消息末尾 turnTail | 每轮变   | 在 system 之后，不影响前缀 |
| 对话历史               | 每轮增长 | 在 system 之后，不影响前缀 |

---

## 八、与 Claude Code 的对比

### 操作对比

```
pico（增量操作）：
  模型：todo({ action: "toggle", id: 1 })           ← 只传 ID
  系统：改 todo.json → 返回快照 → 下轮注入最新列表

Claude Code（全量替换）：
  模型：TodoWrite({ todos: [全部列表，改了1条] })    ← 传完整数组
  系统：覆盖存储 → 返回 "updated" → 下轮不注入
```

### 感知对比

```
pico：
  模型不操作时 → 系统仍然每轮注入最新列表
  模型操作后 → tool_result 返回快照 + 下轮 turnTail 刷新

Claude Code：
  模型不操作时 → 靠上下文里自己的旧 tool_use 记住列表
  模型操作后 → tool_result 只说 "updated"，列表在 tool_use 参数里
  长时间不操作 → 系统 <system-reminder> 催促 "TodoWrite hasn't been used recently"
```

### Token 消耗对比

| 场景             | pico                                 | Claude Code                          |
| ---------------- | ------------------------------------ | ------------------------------------ |
| 10 条任务，20 轮 | 每轮注入 10 条 × 20 = 200 次列表渲染 | 模型每次调 TodoWrite 传 10 条        |
| toggle 1 条      | `{action:"toggle",id:1}` ≈ 10 token  | `{todos:[10条完整列表]}` ≈ 500 token |
| 不操作时         | 系统注入 10 条 ≈ 200 token/轮        | 零消耗                               |

---

## 九、设计权衡总结

### 选择系统注入式的原因

1. **断点续传友好**：恢复会话时第一轮就能看到列表，不需要模型"回忆"
2. **不依赖模型自觉**：即使模型不主动调 todo 工具，也能看到当前进度
3. **maka-agent 验证过**：`<task-ledger>` 每轮注入 turnTail 是可行方案
4. **与缓存不冲突**：turnTail 在 user 消息，system 前缀缓存不受影响

### 已知的代价

1. **token 冗余**：每轮重复注入完整列表
2. **模型可能养成依赖**：不主动调 todo 工具，等系统喂

### 缓解措施

1. **TodoTool 返回快照**：模型操作后立即看到全局状态（双保险）
2. **空列表不注入**：`buildTodoContext` 返回空字符串时不追加到 turnTail
3. **turnTail 追加而非替换**：只影响最后一条 user 消息，不改变历史

---

## 十、相关文件索引

| 文件                                             | 职责                                                |
| ------------------------------------------------ | --------------------------------------------------- |
| `src/context/todo-store.ts`                      | 存储层：内存缓存 + todo.json 持久化 + Markdown 渲染 |
| `src/tools/todo.ts`                              | 工具层：add/update/toggle/remove/list + 返回快照    |
| `src/context/composer.ts`                        | 注入层：组装 turnTail（含 TodoList）                |
| `src/engine/loop.ts`                             | 调度层：每轮重建 turnTail + appendTurnTail          |
| `tests/e2e/prompt-cache-freeze.real-llm.test.ts` | 缓存安全性验证测试                                  |
| `tests/e2e/prompt-layering.real-llm.test.ts`     | 分层结构验证测试                                    |
