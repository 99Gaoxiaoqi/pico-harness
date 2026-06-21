# Subagent Delegation 优化记录

## 当前 pico 实现思路

优化前 `spawn_subagent` 是普通工具,主 Agent 调用后通过 `AgentEngine.runSub()` 拉起只读子循环。隔离做得很清楚:子代理只有 read/bash,不污染主 Session。但它没有显式 depth/role 概念,未来如果给子代理再挂委派工具,容易无限递归。

## Hermes 对应实现思路

Hermes 的 delegate tool 区分 orchestrator 和 leaf,并记录 `_delegate_depth` 与 `max_spawn_depth`。默认 leaf 不再继续委派,orchestrator 才能 fan-out,并且有深度上限。

## 优化后设计

- `AgentRunner.runSub()` 新增 `SubagentRunOptions`。
- `SubagentTool` 新增 `depth`、`maxSpawnDepth`、`role`。
- 达到 `maxSpawnDepth` 时直接拒绝继续委派。
- 当前主代理委派出去的子代理默认 role 为 `leaf`。

## 取舍说明

借鉴 Hermes 的深度边界与角色概念,但暂不实现 background handle、批量 fan-out、子代理独立凭据和 kill switch。pico 先防无限套娃。

## 油耗对比

本模块不直接改变单次 LLM 价格。油耗影响是限制子代理递归 fan-out,避免子任务树失控放大 `promptTokens`、`completionTokens` 和工具调用次数。

## 验证记录

- `tests/subagent.test.ts`: 覆盖 depth 上限拒绝、orchestrator 委派时透传 leaf 配置。
- 已运行: 相关测试通过。
- 已运行: `npm run typecheck`,通过。
- 最终全量验证: `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过;全量测试为 15 个测试文件、190 个测试。
