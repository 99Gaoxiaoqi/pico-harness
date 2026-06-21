# Usage / Pricing / CostTracker 优化记录

## 当前 pico 实现思路

优化前的 pico 使用 `Usage { promptTokens, completionTokens }` 表示一次模型调用油耗。`CostTracker` 内置一个小型模型价格表,未知模型使用固定兜底价计算成本。优点是代码很短、课程讲解清楚；缺点是会把未知模型算成假价格,也无法区分 cache、reasoning 等真实计费桶。

## Hermes 对应实现思路

Hermes 将厂商响应先归一为 canonical usage,再通过 billing route 解析 provider、model、base_url 和 billing mode。未知价格不会伪造,而是返回 unknown；订阅内模型返回 included。这样运营数据更诚实,也能解释 cache 命中为什么降低了实际油耗。

## 优化后设计

- `src/schema/message.ts` 扩展 `Usage`,新增 `inputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`。
- 新增 `toCanonicalUsage()`,把不同 Provider 的字段归一成五桶。
- 新增 `src/observability/pricing.ts`,提供 `BillingRoute`、`PricingEntry`、`CostResult`、`estimateCost()`。
- `CostTracker` 不再使用未知模型兜底价；未知模型记录 token,但 `costStatus=unknown` 且费用为 0。
- `Session` 新增累计五桶字段和 `lastCostStatus`,便于后续报告。

## 取舍说明

借鉴 Hermes 的“unknown 不伪造”和 canonical usage,但暂不接入在线价格目录、余额 header 和复杂 provider route 解析。pico 保留本地静态价格表,避免把教学项目变成运营系统。

## 油耗对比

| 指标 | 优化前 | 优化后 |
|---|---|---|
| `promptTokens` | 记录 | 记录 |
| `completionTokens` | 记录 | 记录 |
| `inputTokens` | 无 | 记录真实新输入 |
| `cacheReadTokens` | 无 | 记录 |
| `cacheWriteTokens` | 无 | 记录 |
| `reasoningTokens` | 无 | 记录 |
| `latencyMs` | 日志打印 | 日志打印 |
| `costCNY` | 未知模型也兜底估算 | 仅 known/included 计算 |
| `costStatus` | 无 | `estimated` / `included` / `unknown` |

## 验证记录

- `tests/tracker.test.ts`: 覆盖 unknown 模型不兜底、五桶归一、Session 累计 cache/reasoning。
- 已运行: `npm test -- tests/tracker.test.ts ... tests/approval.test.ts`,相关断言通过。
- 已运行: `npm run typecheck`,通过。
- 最终全量验证: `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过;全量测试为 15 个测试文件、190 个测试。
