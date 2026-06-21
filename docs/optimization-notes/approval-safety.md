# Approval Safety 优化记录

## 当前 pico 实现思路

优化前审批系统使用 `isDangerousCommand()` 正则黑名单,命中后等待人工 approve/reject。所有危险操作基本同级,没有区分“绝对不可执行”和“可以审批后执行”。也没有会话 allowlist 或 YOLO 模式。

## Hermes 对应实现思路

Hermes 区分 hardline 和 dangerous:hardline 永不审批绕过,dangerous 可由人工审批、会话策略、永久 allowlist 或 YOLO 模式决定。这样既能守住底线,又能减少重复审批。

## 优化后设计

- 新增 `isHardlineCommand()`。
- 新增 `ApprovalPolicy`:
  - hardline 直接拒绝。
  - safe 自动放行。
  - dangerous 先查永久 allowlist、会话 allowlist、YOLO,否则进入人工审批。
- 新增 `globalApprovalPolicy`,CLI 和飞书审批中间件统一通过策略决策。
- 飞书仍保留 AgentOps 策略:write/edit 在运维场景继续视为需审批。

## 取舍说明

借鉴 Hermes 的策略层,但暂不实现持久化 allowlist 文件和飞书卡片四按钮。当前先提供策略 API,后续 UI 可以调用 `allowForSession()`、`allowPermanently()`、`setYoloMode()`。

## 油耗对比

本模块不直接发起 LLM 调用。油耗影响来自减少重复审批等待导致的无效轮次,并防止 hardline 命令进入工具执行和后续错误恢复循环。

## 验证记录

- `tests/approval.test.ts`: 覆盖 hardline、session allowlist、YOLO 不覆盖 hardline。
- 已运行: 相关测试通过。
- 已运行: `npm run typecheck`,通过。
- 最终全量验证: `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过;全量测试为 15 个测试文件、190 个测试。
