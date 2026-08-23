# EventLog Maka 语义对齐交付计划

状态：Session Continuity 数据闭环已合并；Workbar v2 以 `d3e3b178` 为基线实施。EventLog 改造基线：`4b0813c3`；Session/Memory 语义修正基线：`fa362543`。授权终点：实现、验证并准备交付，不执行用户真实 workspace 迁移或发布。

## Workbar v2 收敛基线（`d3e3b178`）

Session Continuity 已成为 Desktop 会话转录的唯一通用事件流：固定水位分页、超大条目分片、host epoch 变更、断线重连、缺口补拉与迟到响应隔离都已落地。Workbar 不再使用或建设 `run.live` 类第二套通用事件通道；Tasks、Artifacts、Trace 和 Context 只通过轻量 `resource_changed` 获知变化，再按各自 revision/watermark 查询 authority。Terminal 高频输出和 Browser 页面状态保持专用通道，不写入 Session Continuity。

右侧/底部 Workbar 的产品边界固定为七类工具：侧边对话、变更、终端、浏览器、生成文件、待办和追踪。原“概览/上下文”合并为静态 Inspector，单次工具详情使用可替换 Preview。主会话的推理、工具执行、审批、Plan 和输入框不迁入 Workbar。

| 工具      | authority 与生命周期要求                                       | `d3e3b178` 后差距                                           |
| --------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Inspector | `session.trace.query` 水位 + 版本化 `session.context.get`      | 需增加独立查询、静态/动态 Preview 和隐藏停查                |
| Review    | 实时 `git.review.snapshot/diff`，直读 branch/staged/unstaged   | 需脱离已完成 Run 的 `changes.*` 投影                        |
| Tasks     | Session 任务账本、revision CAS、toolCallId 幂等                | 需持久化 authority、模型工具和有界摘要注入                  |
| Files     | 仅当前 Session 生成产物、CAS Blob、分块读取                    | 需产物索引、ingest/commit 与统一 retention GC               |
| Terminal  | Runtime Host 持有 PTY，独立序列流和有界缓冲                    | 需 create/list/attach/input/resize/stop/detach 及进程组清理 |
| Browser   | Electron Main 持有 WebContentsView，全局持久登录分区，可见租约 | 需共享页面、危险协议/设备权限阻断与 Agent 操作边界          |
| Side Chat | 仅从最近成功 Turn 分叉，隐藏于普通 Session，可恢复清理         | 需 Saga、权限继承、不回写父会话与禁止子代理                 |

开放闸门是真实 authority、明确错误态和删除/归档/断线生命周期同时通过；在此之前 Registry 可声明工具，但 Launcher 必须禁用并说明原因，不展示空面板。Session 删除会清理任务、产物引用、Trace 投影、终端、Browser 页面和侧聊；长期 Memory 只失效来源，已提交 Fact 保留。

## 已决策边界

- 保留 RuntimeEvent v2 与当前 `runtime_events` canonical fact 表，不复制 Maka 的事件信封或 AgentRun 多账本。
- 单版本硬切：在原 `pico.sqlite` 中清空旧 Session/eventLog，不保留备份；其他 scope 的弱引用清理或 park。长期 Memory Fact 不属于 EventLog，不随硬切删除。
- Desktop 与 TUI 同版本切换；不保留 legacy reader。
- workspace EventLog 逻辑配额 2 GiB，触发后只删除 archived 且 unpinned Session，回收到 1.5 GiB；Memory 与独立控制账本只单独观测，不参与 EventLog admission 或候选回收量，因为 Session retention 不能可靠回收这些独立 authority。
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
          -> Session/EventLog 删除 + Memory Source unavailable + Proposal 无正文墓碑
          -> committed Fact 保留
          -> GC outbox -> secure_delete + WAL truncate + 门槛 vacuum
```

事实不变性边界：当前 epoch 内的 `runtime_events` 只追加且不可改写；同一 eventId 仅允许 canonical payload 完全相同的精确重放。projection、partial 和 transcript materialization 是可重建的派生状态。硬切与 retention 是显式、受约束的 EventLog 生命周期删除例外。Memory Source 是 provenance 而不是 Fact ownership；普通 Session 删除、自动 retention 和 EventLog hard cut 均不得删除或改写 committed Fact，只将 Source 标记为 `unavailable`、停止相关提取并把 Source-bound Proposal 转为无正文墓碑。真正忘记长期记忆必须走独立的 Memory forget 语义。

## 验收不变量

- eventId/operationId 重放只有 canonical payload 全等才能幂等成功。
- owner takeover 后旧 fence epoch 的事务不能提交。
- Tool T1 提交前绝不执行；每个 T1 至多一个 T2；不确定副作用永不自动重试。
- partial 不进入 canonical sequence/provider/checkpoint/continuation digest，final 后无残留。
- terminal 唯一且为 run tail；封口后只允许精确幂等重放。
- transcript 固定水位下可遍历全历史，Desktop/TUI 无缺页、无重复、大记录可分片重组。
- 无可清理 Session 且超配额时，阻止新工作但允许 T2/recovery/terminal/delete 安全闭环。
- Memory 与独立控制账本字节不进入 EventLog 配额；即使它们单独超过 2 GiB，也不得触发 Session 回收或阻止 EventLog 新工作。
- 普通 Session 删除、自动 retention 和 EventLog hard cut 后，committed Fact 内容、状态、置顶及版本保持不变；Source `unavailable`，关联 Proposal 不保留正文。
- prepared lifecycle job 只有在 Session 删除事实已提交后才能失效 Source；仍存在的 Session 必须取消该 intent。

## 证据口径

每个切片记录实际执行的定向集成测试、typecheck/lint/format 和最终全量验证；未执行的检查不标记为通过。发布和真实数据迁移需另行人工批准。

## 实施结果与验收证据

- 原 EventLog 改造 HEAD 的 EventLog/continuation/transcript/fence/retention/memory/Plan/Desktop/TUI 定向组合测试：91/91 通过。Session/Memory 语义修正后的 retention、hard cut、Desktop lifecycle 与 Memory service 定向组合测试：28/28 通过，包含 1105 Sources 的 set-based invalidation、Memory 超配额不回收 Session，以及 hard-cut failpoint 全事务回滚。
- Session/Memory 语义修正最终状态的全量集成测试：1039 通过、10 跳过、1 项既有基线失败；本次新增和受影响的 retention、hard cut、Desktop lifecycle、Memory repository 测试均通过。
- 一项与本改造无差异的基线失败仍存在：`terminal-bench-bundle-lock.test.ts` 要求根依赖声明 `@pico/runtime-host: "*"`；基线到本分支的三个 package manifest/lockfile 均无改动。
- `npm run build`、根 typecheck、Desktop typecheck、lint、format 与 `git diff --check` 均通过。
- 后续对抗审查发现并修复一个 P0 语义问题：retention 与 hard cut 原先把 Source-linked Fact 当作 Session-owned 派生行删除。现在三条生命周期路径统一保留 committed Fact；Source 与 Proposal 使用 set-based lifecycle 更新，Memory 计费仍由 SQLite 按 owner 聚合并仅用于观测。最终独立审查又修正了两个 P1：不可回收控制账本导致的候选回收量高估，以及多实例恢复误取消仍被其他实例持有的 lifecycle prepare。
- 已知后续优化：daemon 为复用跨事实 projector，会在单次固定水位读取中累计分页结果；协议正确性和单帧预算已闭环，但极长 Session 的峰值内存可进一步改造成 checkpointed reducer。
- 独立 Memory quota 尚未实现；当前先保证 Memory 不影响 EventLog quota。Memory 统计查询仍在读取存储状态时执行，后续可按独立 Memory 状态协议拆出。
- `runtime_events` 的 append-only 由 typed store API 和事务边界保证，暂未增加阻止同库代码直接执行 `UPDATE` 的 SQLite trigger；新增直接 SQL 写路径仍需架构审查。
- 未执行真实用户数据库硬切、发布或真实模型验收；这些动作仍需单独批准。
