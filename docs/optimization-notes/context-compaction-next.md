# Context Compaction 下一阶段设计

## 当前课程版策略

当前 `Compactor` 的定位是防 OOM 的兜底层,不是语义最优的日志分析器。它采用轻量字符级策略:

- 远期历史超出保护区后,较大的 `ToolResult` 会被替换为 mask 文本,保留 `toolCallId` 与工具调用链条,释放主要上下文空间。
- 保护区内的 `ToolResult` 默认尽量保留,但单条内容过大时仍执行 head/tail 截断,保留前 500 字符和后 500 字符。
- `toolCalls` 不被删除,避免模型失去行动证据后误判工具没有执行。

这套策略的价值是简单、确定、低成本。它能在没有额外 LLM 摘要、没有 tokenizer、没有 artifact store 的情况下避免大输出直接挤爆 Context Window。代价是语义保真有限:关键错误如果落在日志中间,课程版 head/tail 可能看不到。

## 本次升级

本次不把压缩只当作字符截断,而是把它升级为面向 Provider、工具类型和运行反馈的闭环预算系统。

### Provider-aware budget

不同 Provider 的上下文窗口、计费口径、cache 行为和工具调用格式不同。Compactor 现在可以从 `ProviderProfile` 获取预算参数:

- `contextWindowTokens`: 模型上下文窗口。
- `maxOutputTokens`: 默认预留输出预算。
- `safetyMarginTokens`: 预算估算安全边界。

预算先折算成输入 token,再按当前课程实现的字符估算交给 `Compactor`。这仍是近似值,但已经比固定 20000 字符更接近实际模型窗口。

### Closed-loop compaction

`compact()` 保持课程版行为,作为稳定兼容层。新增 `compactToBudget()`:

- 先执行旧 `compact()`。
- 如果仍超预算,进一步压缩保护区 `ToolResult` 和早期普通对话。
- 如果 system prompt 或不可压缩的 tool call 链条本身超过预算,抛出 `ContextCompactionError`。

这样压缩从“尝试变小”变成“必须进入预算,否则显式失败”。

### Type-aware summarizer

大输出不再只按纯文本 head/tail 处理。`summarizeToolResult()` 会按工具类型选择策略:

- `bash` 测试输出:保留失败 suite、断言错误、失败摘要。
- `bash`/`tsc` 构建输出:保留 `TSxxxx` 和文件行号诊断。
- 普通 bash 日志:提取 `CRITICAL`、`ERROR`、`FATAL`、`Exception`、`E_*` 等中间错误行。
- `read_file`:保留路径、原始长度和 head/tail。
- `rg`:短输出原样,长输出保留匹配计数和前若干命中。

关键目标是让日志中间的错误也能被保留,弥补 head/tail 对中段信息不敏感的问题。

### ToolResult artifact externalization

本次没有把所有 `ToolResult` 都外部化,而是采用阈值触发。超过阈值的大输出会写入 `.claw/artifacts/tool-results/`,上下文里只保留 typed observation:

- `artifactId`
- `artifactPath`
- `originalChars`
- `summaryStrategy`
- 类型化 summary

模型仍能看到足够的决策信息;需要深挖时,可以通过 `artifactPath` 再读原始输出。

## 为什么不把所有 ToolResult 都外部化

全量外部化看似统一,实际会增加不必要的复杂度和 IO 成本:

- 小输出直接放上下文更便宜,也更利于模型连续推理。
- 很多工具结果只有几十到几百字符,外部化会制造额外路径、生命周期和清理负担。
- 过早外部化会破坏 prompt cache 前缀稳定性,并增加读取 artifact 的回合数。
- 不同工具结果价值不同,例如测试失败输出比普通 `ls` 输出更需要语义摘要。

更合适的策略是阈值/类型触发:按大小、工具类型、错误状态、Provider 剩余预算和历史压缩效果共同决定是否外部化。

## Artifact 生命周期

Artifact store 必须有清晰生命周期,否则只是把上下文 OOM 转移成磁盘膨胀。

详细设计见 [Session-scoped Artifact 生命周期设计](./artifact-lifecycle.md)。这里保留关键边界:

- `TTL`: 只是“可被 cleanup 删除”的资格,不是定时自动删除。
- `cleanupAfterWrite`: 只是写入 artifact 后顺手清理,不等价于 session 删除。
- `deleteSession`: 删除 session 时必须显式删除该 session 的 artifacts,且不受 pinned 保护。
- `session isolation`: 当前 session 已有 history/workDir 隔离,artifact 也已物理隔离到 `.claw/artifacts/sessions/<safeSessionId>/tool-results/<artifactId>.*`。
- `global quota sweep`: 保留为整个 `.claw/artifacts` 目录的磁盘兜底;它不是 QuickSwap,也不是 session 删除,只在总 quota 超限时跨 session 删除最旧的未 pinned artifact。
- `ToolResult lifespan`: 大段原文通常短期保留为 artifact,长期保留摘要、错误行、文件行号和关键片段。

## 集成验收

- baseline: 保持课程版远期 mask 与保护区 head/tail 行为可测。
- artifact externalization: 构造 100KiB synthetic log,确认上下文 observation 包含 artifact path、summary 和关键片段。
- typed summary: 把关键错误放在日志中间,确认摘要仍保留错误类型、错误行和必要上下文。
- quota/TTL: 构造多轮大输出,确认过期和超 quota artifact 被清理,pinned artifact 不被误删。
- session lifecycle: 删除 session 后 artifact 文件消失;`cleanupSession` 不影响其它 session;global sweep 在总 quota 超限时跨 session 删除最旧的未 pinned artifact。
