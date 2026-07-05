# 第 9 章 · 看清每一步在干什么

Agent 能做事了。但我不知道它在做什么。

它调了多少次 API？每次花了多少 Token？哪个步骤最耗时？为什么选了方案 A 而不是方案 B？月底老板拿着几千块的 API 账单问我"哪个任务消耗最多"，我哑口无言。

我需要可观测性。三个维度：**成本、轨迹、日志。**

---

## CostTracker：装饰器模式的妙用

成本追踪最怕的是侵入性——在每次 API 调用前后手动写计时代码。Main Loop、Subagent、Plan Mode、Error Recovery……到处都是 `provider.generate()` 调用。每个地方都加一行计时，代码就烂了。

装饰器模式给出了完美的解法：**创建一个"假"的 Provider，包裹"真"的 Provider。** Main Loop 根本不知道自己在被监控。

```typescript
// src/observability/tracker.ts
export class CostTracker implements LLMProvider {
  constructor(
    private readonly next: LLMProvider,       // 真正的 Provider
    private readonly modelRoute: BillingRoute, // 计费路由（哪个模型，什么价格）
    private readonly session?: Session,        // 累计到哪个 Session
  ) {}

  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    const start = Date.now();
    const resp = await this.next.generate(messages, tools);  // 透明转发
    const latencyMs = Date.now() - start;

    if (resp.usage) {
      // 计算本次调用的成本
      const cost = estimateCost(this.modelRoute, resp.usage);

      // 累计到 Session
      if (this.session) {
        this.session.recordUsage(
          resp.usage.promptTokens,
          resp.usage.completionTokens,
          cost.costCNY,
        );
      }
    }

    return resp;  // 原封不动返回，Main Loop 无感知
  }
}
```

注入方式极其简洁：

```typescript
// 创建真实 Provider
const realProvider = createProvider("openai", config);

// 包裹一层 CostTracker
const trackedProvider = new CostTracker(realProvider, modelRoute, session);

// Main Loop 用的是 trackedProvider，但它以为是 realProvider
const engine = new AgentEngine({ provider: trackedProvider, ... });
```

这就像给 API 调用装了一个安检门——数据必须经过它，它盖上"时间戳"和"成本戳"，再原封不动放行。

装饰器模式的美妙在于：它不需要 Main Loop 的一行改动。所有 Provider 消费者——Main Loop、Subagent Runner、Error Recovery——都自动被追踪。因为 CostTracker 实现了相同的 `LLMProvider` 接口，对调用方完全透明。

---

## 计费：精确到分

成本计算不是简单的"Token × 单价"。不同模型有不同的计价维度：

```typescript
// src/observability/pricing.ts
const OFFICIAL_PRICING = {
  "glm-5.2": {
    inputPerMillion: 1.0,      // 输入 1 元/百万 Token
    outputPerMillion: 3.0,     // 输出 3 元/百万 Token
    cacheReadPerMillion: 0.1,  // 缓存命中 0.1 元/百万 Token
  },
  "claude-3-5-sonnet": {
    inputPerMillion: 22.0,     // 输入 22 元/百万 Token
    outputPerMillion: 88.0,    // 输出 88 元/百万 Token
    cacheReadPerMillion: 2.2,  // 缓存命中 2.2 元/百万 Token
    cacheWritePerMillion: 27.5, // 缓存写入 27.5 元/百万 Token
  },
};
```

Claude Sonnet 的输出价格是 GLM-5.2 的近 30 倍。这意味着同样一个任务，用 GLM 可能花 ¥0.50，用 Claude 花 ¥15。如果不追踪，你根本不知道这笔钱花在了哪里。

计价还分了四个维度：输入（新 Token）、输出（生成的 Token）、缓存读取（命中 Prompt Cache 的 Token，价格是输入的 10%）、缓存写入（创建缓存的 Token，价格是输入的 125%）。Prompt Cache 的使用效果直接体现在成本差异上——同一段 System Prompt，第一次写入时按 125% 计价，后续 20 轮都按 10% 计价。

---

## Tracing：逐帧复盘

成本告诉你"花了多少钱"，但没法告诉你"为什么这个任务失败了"。链路追踪就是为此而生的。

```typescript
// src/observability/trace.ts
export class Tracer {
  private rootSpan: Span;

  startTurn(turnNumber: number): Span {
    return this.rootSpan.startChild(`Turn #${turnNumber}`);
  }

  async traceToolCall(span: Span, toolName: string, args: string, fn: () => Promise<string>): Promise<string> {
    const toolSpan = span.startChild(`Tool.${toolName}`, { args });
    try {
      const result = await fn();
      toolSpan.finish({ status: "ok" });
      return result;
    } catch (error) {
      toolSpan.finish({ status: "error", error: String(error) });
      throw error;
    }
  }
}
```

追踪的数据结构是一棵 Span 树：

```
Session "refactor-utils"
├── Turn #1 (3.2s)
│   ├── Phase 1: Thinking (2.1s, 450 tokens)
│   └── Phase 2: Action (1.1s)
│       ├── Tool.read_file (50ms, src/utils.ts)
│       └── Tool.read_file (45ms, src/types.ts)
├── Turn #2 (4.8s)
│   ├── Phase 1: Thinking (2.3s, 520 tokens)
│   └── Phase 2: Action (2.5s)
│       ├── Tool.edit_file (80ms) ✓
│       └── Tool.bash (2.3s, npx tsc --noEmit) ✗ (exit 1)
└── Turn #3 (5.1s, final answer)
```

这棵树可以导出为 JSON，存到 `traces/` 目录。你可以看到：哪个 Turn 最耗时？哪个工具调用最常失败？Two-Stage ReAct 的 Thinking 阶段是否真的减少了工具错误？

### 用 Trace 回答真实问题

我在发现 Tracing 的价值之前，Agent 失败时只能猜测原因。"大概是 Third Turn 出了问题？"有了 Tracing，我可以问具体的问题：

- "为什么这次重构任务失败了？" → 查 Trace，发现 Turn 3 的 `edit_file` 因为 old_text 不匹配失败了，Recovery 注入了救援指南但 Agent 没遵从
- "为什么这个任务花了 ¥15？" → 查 Trace，发现 Turn 5 的 `read_file` 读了一个不需要的大文件（12K Token），后面几轮都在处理无效上下文
- "Two-Stage ReAct 对重构任务有帮助吗？" → 对比开启/关闭 thinking 的 Trace，发现 Thinking 阶段平均多花 2 秒但减少了 40% 的工具调用错误

没有 Trace，这些都是猜测。有了 Trace，它们是因果关系。

---

## 结构化日志

结构化日志是第三根支柱。它不是 `console.log`——那些在生产环境里搜索不到。

```typescript
// src/observability/logger.ts
export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => {
    console.log(JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      message: msg,
      ...meta,
    }));
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {/* 类似，level: "warn" */},
  error: (msg: string, meta?: Record<string, unknown>) => {/* 类似，level: "error" */},
};
```

每行日志都是独立的 JSON 对象。这意味着可以用 `jq` 过滤、用 ELK 聚合、用 Grafana 可视化。不是"读日志文件"，而是"查询日志数据库"。

这一点很重要。在飞书 AgentOps 场景中，用户可能报告"Agent 昨天下午的响应很慢"。你不用翻几百行日志——你只需要 `jq 'select(.timestamp > "2026-07-04T12:00:00" and .latencyMs > 5000)'`，三秒钟定位到慢请求。

### Artifact 外部化：不让大数据进上下文

还有一个容易被忽略的观测维度：artifact（产物）。Agent 执行 `bash "cat /var/log/app.log"` 时，输出可能有 50K 字符。如果这个输出原样进入上下文，会迅速撑爆窗口。但如果直接丢弃，主 Agent 又没法事后查阅。

解决方案是**外部化存储**。大型工具输出不进入上下文，而是写入磁盘文件（`workDir/.claw/artifacts/`），上下文中只保留一个引用路径：

```
[工具 bash 输出已外部化: .claw/artifacts/bash_1712345678.log, 原始 52341 字符]
```

主 Agent 在需要时可以 `read_file(".claw/artifacts/...")` 查看完整内容。子代理的探索结果也一样——大型文件读取的结果外部化，只有 summary 回到主上下文。

---

## 现在有了什么

可观测性系统就位：

- **CostTracker**：装饰器模式无侵入拦截，每轮 API 调用的 Token 和成本精确到分
- **Tracing**：Span 树导出 JSON，逐帧复盘 Agent 的全部决策路径
- **结构化日志**：每行 JSON，可被 jq/ELK/Grafana 消费

这三个系统合在一起，回答了三类问题：
- **成本**："这个 Session 花了 ¥3.42，其中 Claude 输出占了 ¥2.80"
- **轨迹**："Turn 3 的 edit_file 失败了，因为 old_text 不匹配。之后 Recovery 注入了救援指南，Turn 4 重试成功"
- **日志**："12:34:56 飞书 Bot 收到消息，分配 Session `wxid_abc`，开始处理"

Agent 现在能做一切：思考、执行、纠错、安全、委派、追踪。但最后一个问题：**它真的在变好吗？**

加了 Two-Stage ReAct，成功率从 60% 提到 75% 还是降低到 50%？改了压缩策略，上下文质量是提升还是下降？换了新模型，值得吗？

接下来，给它设计一场考试。

[下一章：怎么知道它变聪明了 →](10-evaluation.md)
