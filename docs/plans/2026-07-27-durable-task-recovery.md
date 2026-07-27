# Durable Task 与 Workspace 存储边界改造

## 原始请求

- 拆分并落地从 Maka 最新设计中可借鉴的四点：
  1. 独立 `TaskRun / Attempt` 事实账本；
  2. 从安全边界启动新 Attempt，而不是复活旧调用栈；
  3. 为 Storage Root 建立稳定身份和所有权校验；
  4. 明确 Portable 数据与 Host-bound 状态的边界。

## 实施前事实

- Session 的 canonical RuntimeEvent 已持久化到 `sessions/<sha256>/session.jsonl`。
- Job、Attempt、Lease、Daemon/Cron 和 Outbox 由 `control/state.json` 及控制面 JSONL 保存。
- `RuntimeTaskMirror` 当前无条件将生产 TaskRegistry executor 标记为 `host_bound`。
- 进程重启会把失去 Lease 的运行中 Job 收敛为 `interrupted`，不会自动创建新 Attempt。
- `.storage/layout.json` 标识布局，但没有独立、稳定的 Storage Root identity。
- `tasks/` 是旧任务文件目录，当前版本只诊断、不读取。

## 决策

- 工作流：standard；风险：high；授权终点：implement-and-verify。
- 新增 `task-runs/`，不复用 legacy `tasks/`。
- 新能力采用显式 opt-in。只有同时提供 adapter ID、adapter version、不可变输入快照和恢复实现的任务才能标记为 `recoverable`；既有闭包型 executor 保持 `host_bound`。
- 恢复总是创建新的 `attemptId`、owner Lease epoch 和 Runtime Run；不复活 Promise、provider stream、PTY、子进程或内存闭包。
- Session RuntimeEvent 继续是 Agent 执行事实源。TaskRun 日志只引用 `sessionId/runId/eventHighWater`，不得复制 canonical RuntimeEvent。
- `control/state.json` 继续承载调度、Lease、Outbox 等控制状态；TaskRun 日志承载跨 Attempt 的任务事实。
- 完整但非法的 JSONL 中间记录 fail closed；只允许修复未换行的最后一条不完整记录。
- 不迁移、不删除 `runtime.sqlite`、`memory.sqlite` 或 legacy `tasks/`。

## 范围

### 包含

- 版本化 TaskRun header、事件批次、投影和跨进程安全追加。
- 显式 RecoverableTask adapter/registry/coordinator 与 safe-boundary planner。
- Workspace Storage Root ID、物理目录身份校验和显式 adopt 边界。
- Portable allowlist、Host-bound/protected denylist、可审计导出计划。
- StorageDoctor、路径、架构/部署文档和集成测试更新。

### 不包含

- 恢复断开的网络流、工具进程或任意 JavaScript 调用栈。
- 把所有现有 TaskRegistry producer 自动升级为 recoverable。
- 对副作用结果不确定的工具调用进行盲目重试。
- 自动导入或删除旧 SQLite/legacy task 数据。
- 物理磁盘擦除、生产部署或自动数据清理。

## 共享契约

```text
TaskRun
  taskRunId
  adapter { id, version, input, inputHash }
  workDir
  createdAt

Attempt
  attemptId
  attemptNumber
  ownerId
  leaseEpoch
  sourceAttemptId?

ExecutionLease
  ownerId
  leaseEpoch
  expiresAt

SafeBoundary
  sessionId?
  runId?
  runtimeEventHighWater?
  storageRootId
  workspacePath
  toolCatalogHash?
  backgroundOperationsSettled
  checkpointRef?

LaunchReceipt
  launchId
  sessionId
  runId
  runStartedEventId
  runStartedSequence
```

恢复计划只有两种结果：

- `continue`：全部身份、高水位、工具副作用和 owner 条件可证明；
- `park`：任何关键条件缺失、冲突或不确定，保留稳定 reason code。

adapter 必须在任何 provider、工具或外部副作用之前，以来源 RuntimeEvent 高水位 CAS 将
确定性的 `run.started` 发布到 `H+1`。TaskRun 结算前崩溃时，恢复器只根据该 canonical
`H+1` 事实重建启动凭据；`H+2` 之后同一 Session 的其他 Run 不影响已经成立的凭据。

## 验收标准

- [ ] TaskRun 多事件写入原子提交，重开后能从日志重建投影。
- [ ] TaskRun ID 使用完整 SHA-256 locator，原始 ID 只保存在内容中。
- [ ] partial tail 可幂等修复；完整非法中间行拒绝读取和追加。
- [ ] 两个进程并发追加时 sequence 连续且不丢事件。
- [ ] 进程崩溃后的 recoverable task 先收敛旧 Attempt，再以新 Attempt 接管。
- [ ] adapter 缺失、版本变化、workspace identity 变化、Runtime high-water 不一致、未配对工具副作用或后台操作未收敛时必须 park。
- [ ] 重复恢复不会创建多个 successor Attempt；旧 Lease epoch 的迟到写入被拒绝。
- [ ] 新建和既有 workspace 都获得稳定 Storage Root ID；目录被替换时活跃 Store fail closed。
- [ ] Portable 计划只包含白名单路径，明确排除凭据、锁、commit、Host 配置、临时文件和 legacy SQLite。
- [ ] 现有 Session、RuntimeStore、Memory 和 legacy 文件行为保持兼容。

## 失败与回退

- 布局升级必须先写入新版本 marker；旧版本遇到新 marker fail closed，防止新旧版本并行双写。
- TaskRun 是新增目录，回退时可停止新版本并保留文件；旧版本不会读取它。
- 不删除旧文件；回退不依赖数据逆向迁移。
- Safe-boundary planner 默认 park，adapter 未注册时不得启动 provider 或工具。

## 并行所有权

- TaskRun ledger：`src/tasks/task-run-*` 与对应测试。
- Safe resume：`src/tasks/recoverable-*`、`src/runtime/safe-boundary-*` 与对应测试。
- Portable policy：`src/storage/workspace-portability.ts` 与对应测试。
- 集成线单一所有者：路径、layout/root identity、StorageDoctor、公共 Schema、文档和最终接线。

## 验证证据

- 基线：28 条 RuntimeStore、RuntimeRun recovery、workspace layout、StorageDoctor 测试通过。
- 最终要求：四组针对性集成测试、相关跨进程/故障测试、lint、typecheck、build、Desktop typecheck、`check:storage`、架构检查和最终独立审查。
