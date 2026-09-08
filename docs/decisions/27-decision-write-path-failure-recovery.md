# 决策记录 27：写路径故障恢复协议——工具半执行 indeterminate 判定 + 写失败读回仲裁（2026-08-19）

> 分支：`scratch/maka-gap-analysis`（调研依据：`.scratch/pico-vs-maka-flow-gaps.md` §2 P0/P1；
> 对照系 maka：`docs/architecture/runtime-resume-architecture.md` Ch.8、`runtime-recovery-resolver-adr.zh-CN.md`）。

## 背景与实证

两处故障路径的不诚实/过保守（调研实录）：

1. **P0**：`RuntimeRun.reconcileIncompleteRuns`（src/runtime/runtime-run.ts:362）对悬空 tool call
   无条件合成 tool.result——把"不知道执行了没有"定形为普通失败。副作用可能实际已发生
   （文件已写/请求已发），合成结果从账本上抹掉这一事实。graph 多轮实测"子代理失败被自报
   完成掩盖"为同类变体。maka 对应为 T1/T2 台账 + 决策表（completed / indeterminate /
   definitely_not_dispatched / corruption）。
2. **P1**：任何 durable 写失败 → `markWriteUncertain`（src/engine/session.ts:1614）→
   write_uncertain 封会话停写。保守正确但一次瞬时失败废掉整个会话。maka 对应为写失败后
   `eventLandedInLedger(id)` 读回去歧义（agent-run.ts:988-1007）。

pico 前提：事件即事实（无第二状态机）；event_id 库级主键 + canonical payload 幂等
（同 id 同载荷返回原 seq，异载荷 fail-closed）——读回仲裁有现成基础。

## 决策（P0：轻量 indeterminate 分类）

1. **不新增 journal/operations 表**。恢复期从既有事件流推导分类：
   `message.committed(toolCalls)` / `tool.started` / `tool.result.recorded` 三类事实
   已含判定所需全部信息。
2. **恢复决策表**：

   | 崩溃点（failpoint）         | 事件流状态                                      | 分类             | 恢复动作                                                        |
   | --------------------------- | ----------------------------------------------- | ---------------- | --------------------------------------------------------------- |
   | F0 模型输出提交前           | 无 toolCall 事实                                | —                | 无需处理                                                        |
   | F1 assistant 已提交、未派发 | message.committed 含 toolCalls，无 tool.started | `not_dispatched` | 合成 result：声明**未执行**                                     |
   | F2 已派发、无结果           | tool.started 已落库，无 result                  | `indeterminate`  | 合成 result：显式标记**可能已执行、结果未知**，模型可见文案如实 |
   | F3 结果已落库               | started + result 齐全                           | `completed`      | 不动，绝不重执行                                                |

3. **事件形状**：复用 `tool.result.recorded` kind，data 携带
   `recovery: { classification: "indeterminate" | "not_dispatched" }`。不新增事件 kind
   （避免 assertRuntimeEvent/schema 注册面扩大）；若实现中发现 data 校验不容纳，按最小
   扩展改 schema，仍不新增 kind。
4. **派发顺序硬约束**：`tool.started` 必须先于 `registry.execute` 落库（现状即如此，
   它 是 F1/F2 分类的判定边界）。守护测试（2026-08-20 对抗审查 Finding 2 补）：
   `tests/integration/tool-dispatch-order-guard.test.ts` 走真实 AgentEngine 断言账本序
   `message.committed(toolCall) < tool.started < tool.result.recorded`；派发点
   （src/engine/loop.ts runOneTool）带不变量注释。

### P0 已知盲区（2026-08-20 对抗审查确认，接受不改）

- **子代理 transcript-only 工具调用**：子代理循环向父 run 写 `tool.started`
  （src/engine/loop.ts 子代理并发路径），但子代理 assistant 消息走 transcript 可见性、
  不产生 model-history pending entry——这类调用的悬空 `tool.started` 无恢复事实
  （孤儿 start）。外层 agent 调用的 indeterminate 分类在语义上覆盖内层副作用，
  属设计取舍；若未来子代理消息转 model-history 投影，此盲区自动消失。
- FIFO 多 start/多 result 交错推演安全（错分只会偏 indeterminate），以写序不变量成立
  为前提（见决策 4）。

### P0 验收不变量

- I1 恢复期绝不重执行悬空工具（测试断言 registry 零调用）。
- I2 `indeterminate` 合成结果必须携带显式标记，且对模型文案如实（"可能已执行"）。
- I3 `not_dispatched` 合成结果声明未执行。
- I4 恢复幂等：二次 reconcile 不重复产生事件（eventId 确定性派生，重放走幂等分支）。
- I5 failpoint 矩阵 F1/F2/F3 各有集成测试覆盖，分类唯一且互斥。

## 决策（P1：写失败读回仲裁）

1. durable appendBatch 失败（异常）时，**先读回该批全部 event_id**（点查，复用幂等读
   路径）：
   - 全部落地且 canonical payload 等价 → 视为成功，用读回结果继续，会话保持可写；
   - 任一缺失或载荷不等价 → 照旧 `markWriteUncertain` → write_uncertain；
   - 读回自身失败（存储不可用）→ 保守走 write_uncertain。
2. **owner lease 丢失不仲裁**：lease 语义优先，仍直接 fail-closed。

### P1 验收不变量

- A1 仲裁只允许"确认全部落地"一种翻案；缺任一事件不得恢复可写。
- A2 仲裁路径自身不得产生新写入。
- A3 仲裁异常等价于不仲裁（保守回落 write_uncertain）。

集成测试注入面：成功 append 后使上层收到失败信号（或以 seam 包装 store 抛错），
断言"回读全落地 → 会话仍可写"；任一事件缺席 → write_uncertain 照旧。

## 弃案

- **maka 式 tool_journal_events/tool_operations 两张表**：第二状态机，pico"事件即事实"
  下引入解释漂移（maka ADR 自述："事务一致不能消除两套状态机的解释漂移"）。弃。
- **新事件 kind `tool.result.indeterminate`**：kind 面与断言耦合扩大，data 字段足够。弃。
- **P1 失败后直接重试 append**：可能撞高水位断言/序号重排；读回仲裁才幂等安全。弃。

## 代价与已知局限

- P0 indeterminate 文案进入模型上下文（如实但略增 token）。
- P1 失败路径增加一次点查读放大（可忽略）。
- 分类边界依赖 tool.started 落库时序稳定（§决策 4 固定）。

## 复评条件

- 需要按 operation 查询工具执行状态（运维面）→ 复评 tool_operations 投影。
- ADR 29 续跑协议需要更细工具边界 → 复评 failpoint 表。
