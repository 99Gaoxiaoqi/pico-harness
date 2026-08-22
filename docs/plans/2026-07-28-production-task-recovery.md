# 生产 Agent 任务崩溃接管

## 原始请求

- 参考 Maka 的安全边界 continuation，把 Pico 已有的 TaskRun / Attempt 恢复协议接入生产 Agent 执行链。
- 旧 Attempt 中断后创建新 Attempt 和新 Runtime Run，不复活旧 JavaScript 调用栈。
- 从 canonical RuntimeEvent 高水位重建上下文，不伪造“继续”用户消息。
- 启动扫描与手动恢复先通过功能开关上线。
- 工具副作用使用可判定的 prepare / outcome 边界；结果不确定时 park 或 reconcile，不盲目重试。
- 先在独立集成 workspace 验证，随后合并 `main` 并在 `main` 最终状态复测。

## 交付合同

- 工作流：standard。
- 风险：high（崩溃恢复、跨进程接管和外部副作用重复风险）。
- 授权终点：实现、验证、提交并更新 `main`；不包含生产部署或旧数据迁移。
- 领域责任人：用户。
- 发布控制：默认关闭自动恢复，通过显式配置开启；无法证明安全时必须 park。

## 当前事实

- Session RuntimeEvent JSONL 是 Agent 执行的 canonical ledger。
- TaskRun / Attempt 文件账本、revision CAS、lease/fencing、恢复 claim、launch receipt 和
  `RecoverableTaskAdapter` 已存在并通过文件/多进程测试。
- 生产 `RuntimeTaskMirror` 仍把所有 executor 标记为 `host_bound`。
- 生产代码尚未初始化 TaskRun、写入首个 Attempt/checkpoint、注册 adapter、扫描恢复候选，
  也没有把 successor Attempt 的结果收口回 Job/outbox。
- 当前 Runtime 能补齐 interrupted run 和悬空工具结果，但缺少 dispatch/outcome 事实来判定
  工具副作用是否发生。

## 目标行为

```text
生产 Agent Job / TaskRun
  -> Attempt #1 + execution lease
  -> Runtime Run + canonical RuntimeEvent
  -> durable safe boundary
  -> 进程退出 / lease 过期
  -> Attempt #1 interrupted
  -> 唯一 claim + Attempt #2
  -> 新 Runtime Run（source boundary lineage）
  -> 从 RuntimeEvent 重建 provider context
  -> 完成原 Job；或证据不足时 park
```

## 范围

### 包含

- 一个版本化、生产可注册的核心 Agent recoverable adapter。
- Job、TaskRun、Attempt、Runtime Run 和 completion/outbox 的身份桥接。
- 正常首个 Attempt 的创建、lease heartbeat、safe-boundary checkpoint 和终态收口。
- 启动时枚举恢复候选、手动恢复入口、显式功能开关和稳定诊断。
- continuation 使用新 Attempt/Run 身份和 source RuntimeEvent 高水位，不追加 synthetic user prompt。
- 工具 prepare/dispatch/outcome 的 durable RuntimeEvent 语义；未知结果默认 park。
- 真实子进程 SIGKILL 恢复测试、集成测试、静态检查、构建和一条真实模型 smoke。

### 不包含

- 恢复旧 Promise、provider stream、PTY、子进程或任意内存闭包。
- 自动重试结果未知的网络、文件、消息或其他外部副作用。
- 一次性把 Bash、monitor、Cron 等所有 task type 升级为 recoverable。
- SQLite、旧数据迁移、legacy 文件删除或存储布局替换。
- 默认开启自动恢复。

## 共享不变量

1. 一个 source Attempt / Runtime high-water 只能有一个 successor claim。
2. 新 Attempt、launch 和 Runtime Run 身份由 durable source identity 确定性派生。
3. adapter 在发布唯一 `run.started` admission 与 durable worker intent 前不得产生 provider、
   工具或外部副作用。
4. continuation 只消费 canonical immutable RuntimeEvent prefix；partial/UI projection 不授权恢复。
5. workspace/storage root、tool catalog、checkpoint、后台任务、审批和工具副作用任一无法证明时 park。
6. 工具 dispatch 已提交但 outcome 缺失时为 `indeterminate`；不得合成成功或直接重试。
7. Job、TaskRun 和 Runtime terminal 必须最终一致；重复恢复和迟到 owner 写入不得改变结果。

## 失败分析与回退

- adapter 缺失或版本不匹配：park，不调用模型。
- lease 仍有效：不接管。
- claim/launch 竞争：revision CAS + lease epoch/fencing，失败方只重读。
- `run.started` 已写而 host 崩溃：同一 launchId 重进 adapter，先 reconcile canonical receipt。
- 工具 outcome 未知：park，并提供稳定 reason code；首版不自动 redo。
- workspace/tool catalog/high-water 变化：park。
- 自动恢复异常：保持默认关闭；可关闭功能开关回退到现有 `host_bound/interrupted` 行为。
- 新文件均为追加能力，不删除或迁移既有 JSON/JSONL，可保留诊断后回退旧二进制。

## 并行任务与文件所有权

1. **工具副作用协议**
   - RuntimeEvent 工具 prepare/dispatch/outcome schema、持久写入顺序、恢复投影和集成测试。
   - 单一所有者负责相关 Runtime/Engine 文件。
2. **生产 TaskRun 生命周期**
   - 初始 TaskRun/Attempt、checkpoint、lease heartbeat、Job/TaskRun/terminal 桥接和集成测试。
   - 单一所有者负责 TaskRuntime/RuntimeTaskMirror 周边文件。
3. **Agent continuation adapter**
   - cold-start Session 重建、新 Runtime Run、source lineage、幂等 launch worker 和定向测试。
   - 单一所有者负责新 adapter/worker 文件；公共 composition 由集成线完成。
4. **集成线**
   - 功能开关、启动扫描、手动入口、公共 Schema 冲突、文档、最终审查与两阶段验证。

## 验收证据

- [ ] 默认关闭时保持现有行为，`host_bound` 任务不自动接管。
- [ ] 开启后，生产 Agent TaskRun 首个 Attempt、checkpoint 和终态均真实落盘。
- [ ] SIGKILL 后新进程唯一创建 Attempt #2，并完成原 Job。
- [ ] continuation 没有 synthetic user message，模型上下文来自 source RuntimeEvent prefix。
- [ ] adapter/版本/workspace/high-water/tool catalog/审批/后台任务不一致时零 provider/tool 副作用并 park。
- [ ] T1 前崩溃可安全重启；T1 后 T2 前崩溃判为 indeterminate；T2 后恢复不重复工具副作用。
- [ ] 多进程竞争只产生一个 successor Attempt 和一个 durable launch。
- [ ] 独立集成 workspace 通过聚焦测试、全量集成、lint、typecheck、build、Desktop typecheck、
      `check:storage`、架构检查和真实模型 smoke。
- [ ] 非作者独立审查无未解决高风险发现。
- [ ] 更新 `main` 后在最终 commit 再次通过同等级验证。
