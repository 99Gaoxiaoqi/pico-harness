# 第 3 章 · 教它用工具

Agent 有了大脑（Provider），有了心跳（Main Loop），但还没有手脚。

Main Loop 里有一行 `registry.execute(tc.name, tc.arguments)`，但如果 registry 是空的，Agent 只能聊天，不能做事。现在我要给它装上真正的工具。

---

## 工具注册：一个总机接线员

Main Loop 不应该知道工具有哪些、怎么执行。它只是一个"信使"——把模型说的话（ToolCall）原封不动地传给执行层。

这个执行层就是 **ToolRegistry**。我把它设计成"总机接线员"模式：

```typescript
// src/tools/registry.ts
export interface BaseTool {
  name(): string;                     // 工具名称，模型通过这个名字调用它
  definition(): ToolDefinition;       // 返回工具的 JSON Schema，供模型理解用法
  execute(args: string): Promise<string>;  // 执行工具，接收 JSON 字符串参数
  readOnly?: boolean;                 // 是否只读（并行调度用）
  accesses?(args: string): ToolAccesses;   // 声明资源访问意图（冲突检测用）
}
```

每个工具是一个 `BaseTool` 实例。注册后，Registry 用 `Map<name, BaseTool>` 做 O(1) 路由。

```typescript
// src/tools/registry-impl.ts
export class ToolRegistry implements Registry {
  private readonly tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    const name = tool.name();
    if (this.tools.has(name)) {
      logger.warn(`工具 '${name}' 已被注册,将被覆盖。`);
    }
    this.tools.set(name, tool);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      // 找不到工具？模型幻觉了。返回 isError 让它自纠。
      return {
        toolCallId: call.id,
        output: `未知工具: ${call.name}`,
        isError: true,
      };
    }
    const output = await tool.execute(call.arguments);
    return { toolCallId: call.id, output, isError: false };
  }
}
```

一个值得注意的设计：`execute` 的参数是 `args: string`（JSON 字符串），不是 `args: object`。解析 JSON 是工具自己的事——Main Loop 不知道、也不该知道每个工具的参数结构。**延迟解析，极致解耦。**

---

## 四个工具，够了

UNIX 只有几十个系统调用，但能组合出无限可能。pico-harness 只有四个工具：

| 工具 | 能力 | 为什么只读/写 |
|------|------|-------------|
| `read_file` | 读取文件内容 | 只读，加行号前缀 |
| `write_file` | 创建或覆盖文件 | 自动创建父目录 |
| `edit_file` | 局部字符串替换 | 四级模糊匹配 |
| `bash` | 执行 Shell 命令 | 超时控制 + 工作区锁定 |

选择这四个工具，是因为观察了 Agent 的实际行为模式。Agent 做任何代码相关任务时，只会做四件事：读文件、写新文件、改已有文件、跑命令。没有第五种。给多了反而让它困惑——它会在"该用 replace 还是 edit"之间犹豫。

### read_file：三个坑

读文件听起来简单，但有几个容易被忽略的坑：

**坑 1：路径穿越。** 模型可能被诱导读取 `../../etc/passwd`。必须在读取前校验路径在工作区之内：

```typescript
function safeResolve(workDir: string, path: string): string {
  const base = resolve(workDir);
  const fullPath = resolve(base, path);
  const rel = relative(base, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`路径越界: '${path}' 不在工作区之内`);
  }
  return fullPath;
}
```

**坑 2：文件太大。** 一次性读 10MB 的日志文件会撑爆上下文。默认上限 12000 字节，超出截断并标注。这是早期版本遗漏的细节——有一次 Agent 读了一个 50MB 的 JSON 文件，直接把上下文塞爆了，400 错误。

**坑 3：行号对齐。** 模型看到文件内容后需要用 `edit_file` 改它，所以每行必须加行号前缀。格式是 `行号\t内容`（制表符分隔），这样模型可以直接引用行号。

```typescript
// read_file 的核心逻辑
const content = await readFile(fullPath, "utf8");
let truncated = content;
if (truncated.length > MAX_BYTES) {
  truncated = truncated.slice(0, MAX_BYTES) + "\n... (文件过大,已截断)";
}
const lines = truncated.split("\n");
const width = String(lines.length).length;
const numbered = lines.map((line, i) =>
  `${String(i + 1).padStart(width, " ")}\t${line}`
).join("\n");
return numbered;
```

行号前缀用的是制表符而不是空格——因为代码本身可能包含空格缩进，用制表符确保行号和内容的边界清晰可解析。

### write_file：极简覆盖

只做一件事：把内容写到文件。没有追加模式、没有版本管理、没有权限设置——保持工具语义最小化，复杂操作让模型自己组合（先 read 再 edit）。

唯一额外做的事：自动创建父目录。

```typescript
await mkdir(dirname(fullPath), { recursive: true });
await writeFile(fullPath, content, "utf8");
```

这样模型不需要先 `bash mkdir -p` 再 `write_file`——一步到位。减少不必要的工具调用就是减少出错机会和 Token 消耗。

### bash：四条底线

Shell 是功能最强大的工具，也是最危险的。我给它设了四条硬底线：

1. **超时控制**：30 秒超时。超过则 SIGTERM 杀死进程，防止 Agent 在无限循环的命令上卡死。
2. **工作区锁定**：`cwd` 强制绑定到工作区目录，Agent 不能跳出沙箱。
3. **错误原样回传**：合并 stdout 和 stderr。Agent 需要看到完整的输出才能判断成功还是失败。
4. **长度截断**：输出上限 8000 字节，超出截断并标注。

```typescript
// bash 的核心逻辑
const { stdout, stderr } = await execAsync(command, {
  ...execOptions,
  cwd: this.workDir,          // 锁定工作区
  timeout: 30_000,            // 30 秒超时
  maxBuffer: 10 * 1024 * 1024,
});

let output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
if (output.length > MAX_BYTES) {
  output = output.slice(0, MAX_BYTES) + "\n... (输出已截断)";
}
```

---

## edit_file：最难的工具

`read_file`、`write_file`、`bash` 都很直接。但 `edit_file` 让我 debug 了整整两天。

问题出在大模型的行为上。模型被要求"把第 42 行的 `const x = 1` 改成 `const x = 2`"，它会：

1. 调用 `read_file` 读取文件
2. 在回复里写 `edit_file(old_text="const x = 1", new_text="const x = 2")`
3. 但 `old_text` 里的缩进可能和文件里的不一样——模型"记错"了是 2 空格还是 4 空格
4. 精确匹配失败，Agent 报错，然后陷入"重读 → 重试 → 又失败"的死循环

这是 LLM 的"缩进幻觉"——它记住了语义但丢失了格式。我需要一种容错机制。

解决这个问题用了三步。

### 第一步：四级模糊匹配

一个降级匹配链（Chain of Responsibility）。每一级失败后自动降级到更宽松的匹配：

```typescript
function fuzzyReplace(originalContent, oldText, newText) {
  // L1: 精确匹配 —— 最严格，要求一模一样
  const exactCount = countOccurrences(originalContent, oldText);
  if (exactCount === 1) return originalContent.replace(oldText, newText);
  if (exactCount > 1) throw new Error("匹配到多处，请提供更多上下文");

  // L2: 换行符归一化 —— \r\n → \n
  const normalized = originalContent.replaceAll("\r\n", "\n");
  const normalizedOld = oldText.replaceAll("\r\n", "\n");
  if (countOccurrences(normalized, normalizedOld) === 1)
    return normalized.replace(normalizedOld, newText);

  // L3: 去首尾空白 —— 忽略模型多/少加的空行和空格
  const trimmedOld = normalizedOld.trim();
  if (countOccurrences(normalized, trimmedOld) === 1)
    return normalized.replace(trimmedOld, newText);

  // L4: 逐行去缩进 —— 只比较每行的"内容"，不比较缩进
  return lineByLineReplace(normalized, normalizedOld, newText);
}
```

L4 是最精妙的一级。它把 `old_text` 和文件内容都按行切割，去掉每行的首尾空白，然后用滑动窗口匹配。找到匹配后，还有一个关键步骤——**缩进重对齐**。

模型的 `new_text` 可能用了和文件不同的缩进风格（比如模型用 2 空格，文件用 4 空格）。直接写进去会破坏代码风格。所以 L4 会检测文件中匹配区域的真实缩进，把 `new_text` 的缩进对齐到文件风格。

### 第二步：当一切匹配都失败时——EditHint

有时候连 L4 都匹配不到。可能是模型在幻觉——它"记住"的代码根本不在文件里。这时不能只返回"未找到"，需要帮模型定位。

```typescript
// src/tools/edit-hint.ts
function findClosestLines(content, oldText) {
  // 按 oldText 行数滑动窗口，用字符 Dice 系数算相似度
  const windows = slidingWindows(content, oldText);
  const scored = windows.map(w => ({
    ...w,
    similarity: charDice(w.text, oldText),
  }));
  // 返回 top 3 最相似的候选段
  return scored
    .filter(s => s.similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);
}
```

返回给 Agent 的不仅是"未找到"，还附带三行候选提示：

```
未找到 old_text。以下是文件中最相似的 3 段代码，供您参考：

候选 1 (相似度 92%):
42 |   const formatDate = (date: Date, locale?: string) => {
43 |     return date.toLocaleDateString(locale);
44 |   }

候选 2 (相似度 67%):
89 |   const formatDate = (date: Date) => {
90 |     return `${date.getFullYear()}-${date.getMonth() + 1}`;
91 |   }
```

模型看到这些候选后，通常会选最相似的那个，修正 old_text 再试一次。这比让它从头重读文件高效得多。

### 第三步：跨平台换行符

还有一个长期隐藏的 bug：Windows 的 `\r\n` 和 Unix 的 `\n`。Agent 在 macOS 上跑，但读取的文件可能是从 Windows 机器 clone 的。精确匹配 `"hello\n"` 会失败，因为文件里是 `"hello\r\n"`。

这就是 L2 在做的事——在匹配前把所有 `\r\n` 统一成 `\n`。一个小小的归一化，解决了一个跨平台的头疼问题。

---

## 工具不是孤岛：并行调度

当 Agent 一次性调用多个工具时（比如同时读三个文件），顺序执行是浪费。三个 `read_file` 调用完全可以同时进行。

但并行不是无条件的。如果 Agent 同时调用了 `read_file("src/a.ts")` 和 `write_file("src/a.ts", ...)`，它们操作同一个文件——必须先读后写，否则读到的是旧内容还是新内容是不确定的。

我需要一个调度器，它知道每个工具访问了哪些资源，并据此决定哪些可以并行、哪些必须串行。

### ToolAccesses：声明资源意图

首先，每个工具需要声明自己会碰什么资源：

```typescript
// src/tools/tool-access.ts
export const ToolAccesses = {
  /** 无副作用(如 echo)。不与任何工具冲突。 */
  none(): ToolAccesses { return []; },

  /** 全量互斥。与一切冲突(bash 等无法静态分析的工具用此值)。 */
  all(): ToolAccesses { return [{ kind: "all" }]; },

  /** 读单个文件 */
  readFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "read", path }];
  },

  /** 写单个文件 */
  writeFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "write", path }];
  },

  /** 读改写单个文件(edit 必须先读后写，与并发写同文件冲突) */
  readWriteFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "readwrite", path }];
  },
};
```

冲突判定三层短路逻辑：

1. 任一方是 `kind: "all"` → 冲突（bash 和一切串行）
2. 双方都不含写操作 → 不冲突（read + read 可以并行）
3. 至少一方含写，且路径重叠 → 冲突（同文件读写串行）

举个例子：

```
read_file("src/a.ts") + read_file("src/b.ts")  → 并行 ✅
read_file("src/a.ts") + edit_file("src/a.ts")  → 串行 ❌ (edit 含写，同文件)
write_file("src/a.ts") + write_file("src/b.ts") → 并行 ✅ (写不同文件)
bash("npm test")       + read_file("src/a.ts") → 串行 ❌ (bash 是 "all")
```

### ToolScheduler：贪心并行

有了冲突判定，调度器就很简单了：

```typescript
// src/tools/tool-scheduler.ts
class ToolScheduler<R> {
  async add(task: ToolCallTask<R>): Promise<R> {
    // 等待，直到 task 与所有正在运行的任务都不冲突
    while (this.conflictsWithActive(task)) {
      await Promise.race(this.active.map(t => t.running));
    }
    // 启动执行
    return this.startTask(task);
  }

  private conflictsWithActive(task): boolean {
    return this.active.some(active =>
      ToolAccesses.conflict(active.accesses, task.accesses)
    );
  }
}
```

每次添加新任务时，调度器检查它是否与正在运行的任务冲突。如果冲突，就等冲突任务完成后再启动。如果不冲突，立即启动。

最终引擎中的调度：

```typescript
// src/engine/loop.ts —— 工具并行调度
const scheduler = new ToolScheduler<ToolResult>({ maxConcurrency: 8 });
const results = await Promise.all(
  toolCalls.map(tc =>
    scheduler.add({
      accesses: registry.getToolAccesses(tc.name, tc.arguments),
      start: () => registry.execute(tc),
    })
  )
);
```

`Promise.all` 保证结果按 Provider 返回的顺序排列（调度器内部按 add 顺序保序 resolve）。`maxConcurrency: 8` 限制最大并发数——毕竟 Node.js 是单线程的，太多并发只会争抢 CPU。

---

## 现在有了什么

四把工具已经装好：

- **read_file**：安全读取，路径校验 + 大小截断 + 行号标注
- **write_file**：原子覆盖，自动 mkdir
- **edit_file**：四级模糊匹配 + EditHint 智能定位 + 缩进重对齐
- **bash**：30 秒超时 + 工作区锁定 + 错误回传

加上 **ToolAccesses** 冲突模型和 **ToolScheduler** 贪心调度器，Agent 可以在同一轮中安全地并行执行多个不冲突的工具，在冲突时自动串行。

Agent 现在能读、能写、能改、能跑命令。但它还有两个问题：

1. 它不记得上次聊了什么——每次启动都是"失忆"状态
2. 上下文越来越长，Token 账单飞涨

所以接下来，给它装上记忆和理解上下文的能力。

[下一章：记住上次聊到哪 →](04-memory.md)
