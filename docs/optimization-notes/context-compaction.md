# Context Compaction 优化记录

## 当前 pico 实现思路

优化前的 `Compactor` 采用字符级双重降级:远期工具结果掩码、保护区大结果掐头去尾。它不删除 `toolCalls`,因此能维持基本推理链条。缺点是保护区按消息条数计算,一条巨大消息仍可能挤爆上下文；摘要压缩每次从零开始,且删除远期消息后可能出现 tool call/result 不成对。

## Hermes 对应实现思路

Hermes 使用 token 预算保护尾部,压缩前后修复 tool call/result 对,并维护 previous summary 做增量摘要。它还会记录无效压缩次数,避免每轮都调用摘要器却没有实际收益。

## 优化后设计

- 新增 `sanitizeToolPairs()`: 删除孤儿 tool result,并为缺失结果补 `[早期工具结果已归档]` stub。
- `Compactor` 增加 `retainLastTokens`,优先按近似 token 预算保护尾部。
- 增加 `ineffectiveCompressionCount`,连续两次收益低于 10% 后跳过压缩,避免反复抖动。
- `compactWithSummary()` 改为基于 `previousSummary + newMessages` 的增量摘要。

## 取舍说明

借鉴 Hermes 的 token budget、pair repair、incremental summary,但 token 估算暂用字符近似,未引入 tokenizer。这样符合 pico 的极简原则,后续可在 ProviderProfile 中声明精确 tokenizer。

## 油耗对比

| 指标 | 优化前 | 优化后 |
|---|---|---|
| `promptTokens` | 可能被单条大消息击穿 | 通过 token 预算保护尾部 |
| `cacheReadTokens` | 无直接影响 | 压缩更稳定,未来更利于 prompt cache 前缀稳定 |
| 摘要调用 | 每次从零摘要 | 增量摘要,降低重复输入 |
| API 400 风险 | 删除消息时可能孤儿 pair | sanitize 后降低风险 |

本模块不直接发起 LLM 调用,除非调用方启用 summarizer；启用时油耗影响为减少重复摘要输入。

## 验证记录

- `tests/compactor.test.ts`: 覆盖 pair sanitize、反抖守卫、token 预算、增量摘要。
- 已运行: 相关测试通过。
- 已运行: `npm run typecheck`,通过。
- 最终全量验证: `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过;全量测试为 15 个测试文件、190 个测试。
