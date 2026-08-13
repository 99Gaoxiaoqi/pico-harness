## 改动摘要

（一段话：改了什么、为什么）

## ADR 声明（必填 · 见 docs/architecture/20-architecture-audit-and-governance.md §3.3）

- [ ] 本改动 [遵守 / 影响 / 违反] 原则 **P_（账本权威 / 投影 / CAS / 三态）**，理由：____
- [ ] 若新增进程内状态：崩溃后从 `<durable源>` 重建 / 已标 `@process-local-cache` 非权威缓存
- [ ] 未新增横切原语 / 超时 / 重连 / 同步实现（应复用既有抽象：`raceWithDeadline`、网关契约等）

## 账本与验证

- [ ] 未触碰账本写入，或已走 `appendBatch` / 两层 CAS
- [ ] 不变量测试通过（`npm run test:integration`，含架构不变量与债务活体追踪）
- [ ] 门禁通过（`npm run lint` / `npm run check:architecture`）
