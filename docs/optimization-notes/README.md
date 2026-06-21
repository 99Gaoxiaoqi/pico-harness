# pico-harness 优化记录索引

> 本目录记录本轮对照 Hermes Agent 后的中文开发笔记。每份模块文档都按同一结构书写:当前 pico 实现思路、Hermes 对应实现思路、优化前问题、优化后设计、取舍说明、油耗对比、验证记录。

## 模块顺序与依赖

| 顺序 | 模块 | 文档 | 依赖关系 | 并行建议 |
|---|---|---|---|---|
| 1 | Usage / Pricing / CostTracker | `usage-pricing.md` | 无 | 可独立开发 |
| 2 | Loop / Guardrail / Budget | `loop-guardrail-budget.md` | 依赖 usage token 数据更完整 | `loop.ts` 相关任务串行 |
| 3 | Context Compaction | `context-compaction.md` | 无；增量摘要依赖 tool pair sanitize | 可独立开发 |
| 4 | Provider Profile | `provider-profile.md` | 依赖 Usage 扩展 | 可独立开发 |
| 5 | Tool Middleware | `tool-middleware.md` | 无；Approval/MCP 后续依赖它 | 可独立开发 |
| 6 | Skill Progressive Disclosure | `skill-disclosure.md` | 无 | 可独立开发 |
| 7 | Subagent Delegation | `subagent-delegation.md` | 无 | 可独立开发 |
| 8 | Approval Safety | `approval-safety.md` | 依赖 Middleware v2 更自然 | 建议在工具管线稳定后做 |

## 本轮共同油耗口径

- `promptTokens`: Provider 报告的总输入 token。
- `completionTokens`: Provider 报告的总输出 token。
- `inputTokens`: 归一化后的真实新输入 token,不含 cache read/write。
- `cacheReadTokens`: 命中 prompt cache 的输入 token。
- `cacheWriteTokens`: 创建 prompt cache 的输入 token。
- `reasoningTokens`: reasoning/thinking token。
- `latencyMs`: 单次 Provider 调用耗时。
- `costCNY`: 按 pricing 表估算出的人民币费用。
- `costStatus`: `estimated` / `included` / `unknown`。

## 当前验证记录

- 红灯验证:新增测试首次运行失败,失败点集中在缺失 `pricing.ts`、`budget.ts`、`profile.ts`、Guardrail、Middleware v2、Skill progressive disclosure、Subagent depth、ApprovalPolicy。
- 绿灯验证:相关模块测试已通过 `npm test -- tests/tracker.test.ts tests/reminder.test.ts tests/loop.test.ts tests/compactor.test.ts tests/provider.test.ts tests/registry.test.ts tests/composer.test.ts tests/subagent.test.ts tests/approval.test.ts`。
- 类型验证:已通过 `npm run typecheck`。
- 最终全量验证:
  - `npm run typecheck`: 通过。
  - `npm run lint`: 通过。
  - `npm test`: 15 个测试文件、190 个测试通过。
  - `npm run build`: 通过。
