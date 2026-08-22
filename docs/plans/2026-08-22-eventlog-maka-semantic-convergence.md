# EventLog Maka 语义对齐交付计划

状态：实现与代码验收完成，待真实迁移/发布审批。基线：`4b0813c3`。授权终点：实现、验证并准备交付，不执行用户真实 workspace 迁移或发布。

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

## 改造前后的数据流

改造前：

```text
Host 请求
  -> RuntimeRun / Plan / Graph / recovery 各自写事件或投影
  -> runtime_events
  -> 最近尾部按字节预算读取 -> Desktop/TUI transcript

Tool 调用：事件、外部副作用、结果日志分散提交
Continuation：先 claim，再启动目标 Run（两个事务）
存储维护：没有统一 epoch 硬切、准入配额和物理回收闭环
```

主要后果是 owner 被接管后旧写入仍可能竞态提交，Tool 崩溃窗口无法可靠区分“未执行”和“执行但未记账”，长 transcript 的旧记录或超大记录不可达，continuation 可能只留下 claim，事实、投影和资产也没有共同的生命周期边界。

改造后：

```text
Host 请求
  -> Session owner lease + fence epoch
  -> 新工作 retention admission（闭环写入不受阻）
  -> RuntimeRun
       -> BEGIN IMMEDIATE appendBatch
            -> immutable runtime_events facts
            -> projections + transcript records/chunks（同事务）
       -> Tool T1 prepare -> 外部副作用 -> Tool T2 settle
       -> mutable partial lane -> terminal seal 同事务清空 partial
  -> Desktop/TUI 固定水位 H + keyset cursor
       -> UTF-8 fragments 重组 -> itemId 去重 -> 展示

崩溃恢复：prepared operation -> interrupted T2，不自动重放不确定副作用
Continuation：冻结 source prefix digest + claim + target run.started（同事务）
生命周期：eventlog epoch hard cut / archived retention
          -> GC outbox -> secure_delete + WAL truncate + 门槛 vacuum
```

事实不变性边界：当前 epoch 内的 `runtime_events` 只追加且不可改写；同一 eventId 仅允许 canonical payload 完全相同的精确重放。projection、partial 和 transcript materialization 是可重建的派生状态。硬切与 retention 是显式、受约束的生命周期删除例外；Session 删除时，独立终态控制事实继续保留，仅将弱引用置空，手工 overlay 不被级联删除。

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

## 实施结果与验收证据

- 最终 HEAD 的 EventLog/continuation/transcript/fence/retention/memory/Plan/Desktop/TUI 定向组合测试：91/91 通过；包含 1105 Sources + 1105 derived Facts 的超参数上限回收用例。
- 全量集成测试分段覆盖完成：首段 635 通过、10 跳过；剩余段 397 通过、15 跳过。`runtime-host-spawn` 首次出现一次时序抖动，独立复跑 6/6 通过。
- 一项与本改造无差异的基线失败仍存在：`terminal-bench-bundle-lock.test.ts` 要求根依赖声明 `@pico/runtime-host: "*"`；基线到本分支的三个 package manifest/lockfile 均无改动。
- `npm run build`、根 typecheck、Desktop typecheck、lint、format 与 `git diff --check` 均通过。
- 独立对抗审查未发现 P0，发现的 4 个 P1 均已修复并回归：canonical partial 入口、Transcript 整数 ordinal、Session-derived memory 删除/计费及其高容量回收边界；同时补齐了冲突 fragment 的 fail-closed 校验。Memory 计费由 SQLite 按 owner 聚合，仅向 Node 返回 `O(Session 数 + 1)` 行，不再物化正文或展开 source ID 参数。
- 已知后续优化：daemon 为复用跨事实 projector，会在单次固定水位读取中累计分页结果；协议正确性和单帧预算已闭环，但极长 Session 的峰值内存可进一步改造成 checkpointed reducer。
- `runtime_events` 的 append-only 由 typed store API 和事务边界保证，暂未增加阻止同库代码直接执行 `UPDATE` 的 SQLite trigger；新增直接 SQL 写路径仍需架构审查。
- 未执行真实用户数据库硬切、发布或真实模型验收；这些动作仍需单独批准。
