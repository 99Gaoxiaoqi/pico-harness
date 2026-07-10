# 第 5 章 · 别让它撑爆上下文

WorkingMemory 解决了历史条数的问题，但还有一个漏洞：**单条消息暴击。**

Agent 读了一个 1MB 的日志文件。即使 WorkingMemory 只保留最近 3 条消息，只要其中一条 ToolResult 包含了这 1MB 文本，发给大模型时就是 1MB。API 瞬间返回 400：`context length exceeded`。

WorkingMemory 只控制了条数，没有控制每条的大小。我需要一个"垃圾回收器"——在上下文超出预算时，自动清理不那么重要的内容。

---

## 一次真实的崩溃

这个故事让我意识到压缩不是可选项。

有一天我让 Agent 排查一个生产环境的 bug。它的操作序列是：

1. `bash "cat /var/log/app.log"` → 工具返回 48,000 字符的日志
2. `read_file("src/middleware/auth.ts")` → 文件 3,200 字符
3. `bash "grep ERROR /var/log/app.log | tail -50"` → 又 12,000 字符
4. `read_file("src/database/connection.ts")` → 4,100 字符

第 5 轮时，上下文累计超过 200K Token。API 返回 400。Agent 没有自动恢复机制——它只是沉默了。用户等了 30 秒后收到一条"任务失败"的飞书消息。

不只是失败。前三轮推理花费了大约 ¥2.8 的 API 费用，全部白费。因为 Agent 在第 5 轮失败时无法恢复任何进度——所有成果都在内存里，随着进程重启消失。

这让我明白：**上下文压缩不是性能优化，是生存必需品。**

---

## 为什么不用模型摘要

直觉上，解决上下文过长的方案是让大模型自己写摘要——把 100 轮对话浓缩成 500 字。很多框架就是这么做的。

但我不选这条路。原因有三个：

1. **太贵。** 摘要本身需要一次 API 调用，消耗的 Token 可能比它节省的还多。如果 100 轮对话有 50K Token，一次摘要需要把 50K 全部发给模型再收回 500 字——这 50K 输入就要 ¥0.15（按 DeepSeek 价格），省下的输出可能只有 ¥0.02。

2. **太慢。** 等待摘要生成需要几秒到几十秒。在 Agent 的实时交互中，每多等一秒，用户体验就下降一截。

3. **丢失细节。** 摘要可能丢掉关键信息。"那个报错里有一个 IP 地址 `10.0.3.42`"被摘要成了"有个网络错误"。Agent 在后续排查中需要那个 IP 地址，但已经被摘要吃掉了。

我选择了一种更轻量的方案：**字符级阶梯降级。** 不调用模型，纯字符串操作。像操作系统的内存管理——先把不常用的页面换出，实在不够了才杀进程。

---

## 阶梯降级：四道防线

压缩器的核心逻辑是 `compactToBudget(contextHistory)`——接收完整上下文，输出裁剪后的版本，保证下发给模型时总字符数不超过预算。

降级顺序从"最不伤害"到"最伤害"：

### 第一道防线：远期历史温和摘要

离当前对话最远的那些消息，它们的工具输出不再保留全文，而是替换成一行可读的摘要：

```
原文: "Error: Cannot find module './utils' at Object.<anonymous>..."
摘要: [工具 read_file 输出已清理, exit 1, 原始 2341 字符, 47 行]
```

摘要保留了关键信息（工具名、退出码、规模），释放了 99% 的空间。Agent 仍然知道"刚才读文件失败了"，只是不记得文件里每一行的具体内容。

```typescript
// src/context/compactor.ts
function makeToolResultSummary(msg, allMsgs, index): string {
  const toolName = findMatchingToolCall(allMsgs, msg.toolCallId)?.name;

  // 生成 1 行摘要: "[工具 {name} 输出已清理, 原始 {N} 字符, {M} 行]"
  return `[工具 ${toolName ?? "unknown"} 输出已清理, 原始 ${msg.content.length} 字符, ${lineCount} 行]`;
}
```

### 第二道防线：远期历史全量掩码

如果温和摘要还不够，对更早期的工具输出直接掩码：

```
[为了节省内存,早期的工具输出已被系统清理。原始长度: 8453 字节]
```

比摘要更激进——连工具名和退出码都不保留了。但注意：**ToolCall 本身绝不删除。** 删了 ToolCall，Agent 会困惑"我的命令发出去没有？"。删了 ToolResult 但保留 ToolCall，Agent 至少知道"那个时间点我调用过 read_file，但结果已经被清理了"。掩码替换（保留调用记录，删除结果内容）既释放内存又保住推理链条。

### 第三道防线：工作区掐头去尾

WorkingMemory 保护区内的消息也不能幸免。如果一条 ToolResult 超过 1000 字符，保留首尾各 500 字符，中间截断：

```
[前 500 字符内容...]

...[内容过长,中间 8234 字节已被系统截断]...

[后 500 字符内容...]
```

`HEAD_TAIL_KEEP = 500` 是一个精心选择的值。首尾各保留 500 字符意味着总共 1000 字符——足够让 Agent 看到报错的开头（通常是错误类型）和结尾（通常是堆栈的最后几帧），但不会撑爆上下文。

这个值来源于反复实验。200 字符太少，Agent 看不到足够的上下文；1000 字符太多，三条截断消息就占了 3000 字符。500 是一个甜点。

### 第四道防线：模型摘要（最后手段）

如果字符级降级全部用尽仍然溢出，才会调用一次模型摘要压缩——把早期对话浓缩成结构化摘要，替换原始消息。

```typescript
// 13-section 结构化摘要模板
const SUMMARY_SECTIONS = [
  "1. 任务目标",
  "2. 当前进度",
  "3. 已完成的步骤",
  "4. 关键发现",
  "5. 遇到的问题",
  "6. 错误与修复",
  "7. 当前状态",
  "8. 文件变更摘要",
  "9. 待办事项",
  "10. 重要上下文",
  "11. 用户偏好与约束",
  "12. 下一步计划",
  "13. 不确定/待确认事项",
];
```

13 个固定 section 确保摘要的结构完整——不会遗漏关键信息。每个 section 都是一个具体的"信息槽位"，模型只需要填空，不需要自己判断该写什么。

但有硬限制：**每次 Main Loop 调用最多触发一次模型摘要压缩。** 原因很惨：有一次 Agent 的第 5 轮触发了摘要压缩，压缩后上下文仍然超预算，又触发了一次……然后又触发了一次。总共执行了 7 次摘要压缩，每次都要把压缩后的内容再发给模型再压缩——Token 消耗反而比不压缩更多。从此加了硬上限：每轮最多一次。

---

## 不止是压缩：Token 计数必须精确

字符级压缩需要一个准确的计量单位。我一开始用 `chars / 4` 估算 Token 数——简单但误差很大。中文一个字符可能等于 1.5-3 个 Token，代码里的符号分布也和自然语言完全不同。

后来换成了 BPE（Byte Pair Encoding）精确计数：

```typescript
// src/context/token-counter.ts
export class TokenCounter {
  private readonly encoder: BPEEncoder;

  countTokens(text: string): number {
    // 对长文本分片计数，避免单次编码 OOM
    const chunks = this.chunkByMaxLength(text, 50_000);
    return chunks.reduce((sum, chunk) => sum + this.encoder.encode(chunk).length, 0);
  }
}
```

BPE（Byte Pair Encoding）是大模型训练时使用的分词算法。cl100k_base 是 GPT-4 和 Claude 通用的编码器。使用真实的分词器计数，误差在 1% 以内。加上 LRU 缓存避免重复计数，高频文本（比如固定的 System Prompt 部分）只算一次。

精确计数至关重要——误差 10% 意味着 200K 预算的实际用量可能是 180K 到 220K。如果你以为是 180K 但实际是 220K，API 就会 400。**压缩需要精确的"秤"，否则你不知道什么时候该触发。**

---

## 上下文预算管理：一扇可调的门

有了计数和压缩，还需要一个"什么时候触发"的决策层：

```typescript
// src/context/context-budget.ts
export class ContextBudget {
  constructor(
    private maxTokens: number, // 硬上限，如 180K
    private softLimit: number = 0.8, // 软限制比例，达到 80% 时开始温和压缩
  ) {}

  shouldCompact(currentTokens: number): "none" | "gentle" | "aggressive" | "full" {
    const ratio = currentTokens / this.maxTokens;
    if (ratio < this.softLimit) return "none";
    if (ratio < 0.9) return "gentle"; // 温和摘要
    if (ratio < 1.0) return "aggressive"; // 掩码 + 掐头去尾
    return "full"; // 模型摘要兜底
  }
}
```

预算不是固定的。不同模型有不同的上下文窗口——DeepSeek V3 支持 128K，Claude Sonnet 支持 200K，GLM-4 支持 128K。Budget 从 Provider 配置中读取模型的实际窗口大小，动态调整阈值。

还有额外保护：**溢出重试。** 如果 API 返回 400（context length exceeded），引擎不直接放弃——而是强制触发一次 full compaction，用模型摘要大幅缩减上下文，然后重试。这是最后一道防线，在日志中标注 `[overflow-retry]`。

---

## 现在有了什么

上下文的"垃圾回收"系统形成了：

- **四道阶梯防线**：温和摘要 → 全量掩码 → 掐头去尾 → 模型摘要。从轻到重，不越级
- **精确 Token 计数**：BPE 编码器 + LRU 缓存，误差 < 1%
- **动态预算管理**：根据模型窗口大小自动调整阈值，80% 预警 / 90% 主动压缩 / 100% 全力压缩
- **溢出重试**：API 400 不放弃，强制 compact 后重试

Agent 现在有记忆（Session）、有心跳（Main Loop）、有大脑（Provider）、有手脚（Tools）、有垃圾回收（Compaction）。但它还是会跑偏——任务做到一半忘了目标、工具报错就机械重试、陷入同一个错误来回打转。

接下来，给它装上方向盘和刹车。

[下一章：给它装上方向盘 →](06-steering.md)
