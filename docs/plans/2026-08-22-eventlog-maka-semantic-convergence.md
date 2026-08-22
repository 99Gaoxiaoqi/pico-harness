# EventLog Maka 语义对齐交付计划

状态：实施中。基线：`4b0813c3`。授权终点：实现、验证并准备交付，不执行用户真实 workspace 迁移或发布。

## 已决策边界

- 保留 RuntimeEvent v2 与当前 `runtime_events` canonical fact 表，不复制 Maka 的事件信封或 AgentRun 多账本。
- 单版本硬切：在原 `pico.sqlite` 中清空旧 Session/eventLog，不保留备份；其他 scope 的弱引用清理或 park。
- Desktop 与 TUI 同版本切换；不保留 legacy reader。
- workspace Session-owned 逻辑配额 2 GiB，触发后只删除 archived 且 unpinned Session，回收到 1.5 GiB。
- 删除使用 SQLite `secure_delete`、WAL truncate 和有门槛的 vacuum，不承诺 SSD/备份层的法证擦除。

## 交付切片

1. 冻结 typed store contract，完成 additive schema、eventlog epoch 硬切和 DB owner fencing。
2. 实现 mutable partial lane、Tool T1/T2/recovery bundle 与 strict terminal seal。
3. 实现 fixed-water transcript records/chunks 与 Desktop/TUI 双向分页。
4. 收紧 checkpoint/continuation，使 claim 与 target start 原子化。
5. 实现 logical-byte accounting、archived-session retention、Evidence/File History GC 与存储状态协议。
6. 运行 failpoint、并发、完整性、性能、Desktop/TUI 与真实模型验收，并完成独立审查。

## 验收不变量

- eventId/operationId 重放只有 canonical payload 全等才能幂等成功。
- owner takeover 后旧 fence epoch 的事务不能提交。
- Tool T1 提交前绝不执行；每个 T1 至多一个 T2；不确定副作用永不自动重试。
- partial 不进入 canonical sequence/provider/checkpoint/continuation digest，final 后无残留。
- terminal 唯一且为 run tail；封口后只允许精确幂等重放。
- transcript 固定水位下可遍历全历史，Desktop/TUI 无缺页、无重复、大记录可分片重组。
- 无可清理 Session 且超配额时，阻止新工作但允许 T2/recovery/terminal/delete 安全闭环。

## 证据口径

每个切片记录实际执行的定向集成测试、typecheck/lint/format 和最终全量验证；未执行的检查不标记为通过。发布和真实数据迁移需另行人工批准。
