# Runtime 一致性收敛计划

> 状态：已完成
> 建立日期：2026-07-16
> 基线：`main@d56b74e`
> 集成分支：`codex/runtime-convergence-fixes`

本轮不做大型重写，只消除已确认的路由、生命周期、幂等、恢复事件、Usage 与工具失败状态分叉。保持 RuntimeEvent 作为 Session/Run 事实主线，不新增 Repository、DI、Outbox 或额外兼容框架。

## 范围

- 包含：修复 6 个已确认问题，补齐崩溃/关闭边界，完成静态校验和临时行为 smoke。
- 不包含：已明确保留的 GC/retention 模块、其他未接入能力、新 Schema/迁移、测试目录恢复、无关重构。

## 实施清单

- [x] 收紧恢复会话的模型路由：已存在 `modelRouteId` 必须精确匹配，只为真正 legacy 会话提供唯一 provider+model 迁移。✔️
- [x] 重置工具连续失败状态：成功调用清除 exact/tool 计数及阻断原因，保留 no-progress 判定。✔️
- [x] 建立 Desktop 关闭栅栏：关闭期间仅持久化终态，禁止新请求和 queued input 消费。✔️
- [x] 贯通发送幂等键：将 direct send/queueId 的稳定身份传入 SQLite `run.start`，并将 execution 纳入请求指纹。✔️
- [x] 原子恢复中断 Run：同一 SQLite 事务内更新 `daemon_runs` 并写入确定性 `run.finished` 事件，补齐 commit-before-notify 窗口。✔️
- [x] 统一 Usage 事实源：新用量只由 `model.call.settled` 推导，旧 usage patch 仅作为 legacy prefix，补齐 Desktop compact 与 Hook 的 RuntimeRun 边界。✔️
- [x] 执行风险匹配验证：受影响 lint、核心/Desktop typecheck、build、storage check 及临时 SQLite/行为 smoke。✔️
- [x] 聚焦复审最终差异，确认未恢复 fallback、未新增第二事实源，且未触碰用户已有未跟踪文件。✔️

## 完成标记

- 完成项改为 `- [x] ... ✔️`。
- 只有实现、相关验证和差异检查全部完成后才打勾。

## 开放问题

- 无；已按当前架构主线和用户的收敛原则确定实施边界。

## 验证记录

- 通过：`npm run lint`、`npm run typecheck`、`npm run desktop:typecheck`、`npm run build`、`npm run check:storage`、受影响文件 Prettier 校验和 `git diff --check`。
- 临时 smoke 通过：路由 fail-closed/legacy 唯一迁移、Guardrail 失败计数重置、Desktop 关闭竞态、Run 幂等及 execution 冲突、中断 Run 原子恢复与跨重启补通知、legacy Usage 前缀投影、durable CostTracker/RuntimeRun 事实写入、Hook model runtime 边界。
- `npm audit --audit-level=high` 报告 22 个既有 high 风险，均来自 Electron Forge 工具链的 `tar/tmp` 传递依赖；自动修复需破坏性版本变更，且本轮未修改依赖，因此未扩大范围处理。

## 完成记录

- 实现提交：`da48d7a`、`c75924b`、`2a1820b`、`c9ba64c`、`ce04bbf`、`5fb00bb`、`885b9ed`。
- 最终独立复审确认：queued Run 准入、事务后通知、两阶段关闭和 rollout-aware Usage 均无新的合并阻断。
- 本轮未恢复已删除的测试代码，未修改明确保留的 GC/retention 模块，也未纳入用户的其他未跟踪文件。
