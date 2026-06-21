# Loop / Guardrail / Budget 优化记录

## 当前 pico 实现思路

优化前的 Main Loop 只用 `maxTurns` 防止无限循环,到达上限后直接 `break`。`ReminderInjector` 只检测“同一工具 + 同一参数 + 连续失败”,且并发批次只分析第一个工具结果。这个实现非常适合课程演示,但对真实 Agent 来说盲区明显。

## Hermes 对应实现思路

Hermes 在 turn pipeline 中加入预算控制、工具 guardrail、无进展检测和 finalizer。预算耗尽后不是硬断,而是给模型一次不带工具的收尾机会。工具 guardrail 不只看失败,也看幂等工具是否重复返回相同内容。

## 优化后设计

- 新增 `src/engine/budget.ts`,用 `IterationBudget` 表达轮次、Token、成本三闸。
- `AgentEngine` 达到预算后触发 Grace Call,以空工具列表请求模型总结已完成、未完成、下一步。
- 新增 `ToolGuardrailController`,检测:
  - `exact_failure`: 同签名重复失败。
  - `same_tool_failure`: 同一工具不同参数连续失败。
  - `idempotent_no_progress`: 只读工具成功但输出 hash 不变。
- Main Loop 对并发批次中的每个工具结果都执行 guardrail 分析。

## 取舍说明

借鉴 Hermes 的 guardrail 和 grace call,但暂不实现中途 `/steer`、checkpoint manager、复杂 interrupt。pico 保持单进程、单 Session 语义,让主循环仍然可读。

## 油耗对比

本模块不直接降低单次 LLM 单价,但会降低失控调用风险。

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 达到 maxTurns | 直接中断,可能无总结 | 追加 1 次无工具 Grace Call |
| 重复失败 | 第 3 次同参失败提醒 | 同参失败、同工具失败、无进展均可提醒/阻断 |
| 并发只读批次 | 只看第一个结果 | 每个结果都进入 guardrail |

油耗影响:Grace Call 会增加一次低风险 LLM 调用,但能避免后续无意义工具循环和用户重新唤醒造成的额外 token。

## 验证记录

- `tests/reminder.test.ts`: 覆盖无进展、同工具失败、block 阈值。
- `tests/loop.test.ts`: 覆盖 Grace Call、IterationBudget、并发工具逐个 guardrail。
- 已运行: 相关测试通过。
- 已运行: `npm run typecheck`,通过。
- 最终全量验证: `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过;全量测试为 15 个测试文件、190 个测试。
