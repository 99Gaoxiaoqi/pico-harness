# Tool Middleware 优化记录

## 当前 pico 实现思路

优化前的 `ToolRegistry` 只有一层 `MiddlewareFunc`,只能在执行前返回 allow/deny。它适合第 16 讲审批演示,但无法改写参数、包裹执行、统一截断、审计或重试。

## Hermes 对应实现思路

Hermes 有 request middleware 和 execution middleware。request 阶段可以改写参数或拒绝调用；execution 阶段通过 `next_call` 包裹真实工具执行,适合审计、限流、截断、重试。

## 优化后设计

- `src/tools/registry.ts` 新增 `RequestMiddleware` 和 `ExecutionMiddleware`。
- `ToolRegistry.use()` 保持兼容,内部映射到 `useRequest()`。
- 新增 `useRequest()` 支持改写 `ToolCall`。
- 新增 `useExecution()` 支持包裹工具执行。
- `BaseTool.maxResultSizeChars` 支持由 Registry 统一截断工具结果。

## 取舍说明

借鉴 Hermes 的双层管线,但保留 pico 的 Map 注册和极简工具接口。暂不实现工具自注册、toolset check_fn 和 MCP 动态 schema；这些可以建立在当前 Middleware v2 上。

## 油耗对比

本模块不直接发起 LLM 调用。油耗影响来自统一截断工具结果,减少后续 `promptTokens` 被大工具输出撑爆的风险。

## 验证记录

- `tests/registry.test.ts`: 覆盖 request 改参、execution 包裹、统一截断。
- 已运行: 相关测试通过。
- 已运行: `npm run typecheck`,通过。
- 最终全量验证: `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过;全量测试为 15 个测试文件、190 个测试。
