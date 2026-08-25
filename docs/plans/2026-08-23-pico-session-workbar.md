# Pico Desktop 右侧 Session Workbar 实施计划

状态：历史实施快照。本文记录的 P0 步骤 1–4 已完成；原步骤 5–10 已在后续 Workbar v2 和 Session Continuity 集成中以调整后的边界交付。下方未勾选项仅保留当时的规划语境，不再代表当前待办；现状、验收证据和真实剩余项以 [EventLog Maka 语义对齐计划](./2026-08-22-eventlog-maka-semantic-convergence.md) 为准。本计划补充 [Pico Desktop UI 重写](./2026-08-23-maka-inspired-desktop-ui.md)。

## Approach

先把当前固定的 `概览 / 变更 / 上下文` 与 Tool Inspector 收编为一个右侧单 Dock、多标签、可缩放的 Session Workbar，并只接入 Pico 已有的真实 authority。这个阶段不做 Schema 迁移，可以独立发布。随后按 Tasks、Interaction、Artifacts、Trace、Terminal 的顺序补齐后端资源 authority；Browser、Side Chat 和 Bottom Dock 延后，避免首版同时引入窗口管理、原生进程和子会话生命周期。

交付分界：完成步骤 1–4 只能称为“Workbar 交互骨架”；完成步骤 5–8 后才具备 Maka 式核心任务工作栏的数据闭环；Terminal 在步骤 9 单独验收。

## Scope

- In:
  - 右侧单 Dock、Launcher、多标签、折叠、拖拽宽度、切换、关闭、排序、焦点恢复和键盘导航。
  - Review、真实 Context、Tool/Subagent Inspector 三类现有数据接入。
  - Session-scoped Tasks/Work Projection、当前 Interaction 状态、Artifact Registry、因果 Trace 和 PTY Terminal。
  - 资源订阅、断线重连、Session 切换、删除、崩溃恢复、分页、安全与长会话性能边界。
- Out:
  - 不把实时 reasoning、工具调用、审批或 Plan 执行区整体搬到右侧；它们继续留在主 transcript/composer。
  - 不把 workspace TodoStore 包装成 Session Tasks，不把 Git Changes、Evidence 或目录扫描冒充 Artifacts。
  - 不实现 Browser、Side Chat、Bottom Dock、跨 Dock 拖拽、多 Terminal、preview/pin；这些另立后续交付。
  - 不修改 EventLog canonical fact、compaction checkpoint、Session/长期 Memory 生命周期或 Memory quota。
  - 不恢复旧版 Session 数据，不执行其他 workspace 迁移或发布。

## Architecture Invariants

- 所有 Session 资源使用 `{workspacePath, sessionId}`；动态资源再增加 `resourceId`，不得退化为仅 `sessionId`。
- Renderer 只消费有版本的 snapshot/projection 和增量通知，不依据时间戳、通知到达顺序或 React 本地状态创造领域事实。
- localStorage 只保存布局、尺寸和静态标签拓扑；Tasks、Interactions、Artifacts、Terminal 等领域状态必须由 Host/Daemon 持有。
- Workbar 宽度、折叠状态和静态标签拓扑是版本化的全局 Desktop 偏好；标签内容始终重新绑定当前 Session，动态资源只属于创建它的 Session。
- 固定流程为“读取 durable watermark/revision → hydrate → subscribe → gap 时 resync”；切换 Session 时取消旧请求并丢弃迟到响应。
- 隐藏面板默认停止查询和重投影；关闭动态标签必须释放订阅与资源句柄。
- Session 删除可以清理 Session-owned Workbar 资源，但只能将 Memory Source 标为 unavailable；committed Memory Fact 保留。

## Action Items

[x] 1. 冻结 Workbar 的 authority 与生命周期矩阵。

- 为 Review、Context、Inspector、Tasks、Interactions、Files 和 Terminal 分别指定唯一 authority、查询接口、通知来源和可操作命令。
- 定义 archive、fork、delete、crash、daemon reconnect 和 workspace 切换时的资源行为。
- 明确“历史事实”和“当前可操作状态”：Transcript 中的 waiting 记录不能直接恢复审批按钮，Context 压缩也不等于删除 Transcript。
- 验收：每个计划展示的字段都能追溯到真实查询或持久投影；无 authority 的标签不进入 Launcher。

[x] 2. 建立统一的 Renderer Workbar 状态与资源访问边界。

- 在 `apps/desktop/src/renderer/workbar/` 定义标签、MRU、折叠、尺寸和版本化布局持久化；该目录不持有任何领域真相。
- Review、Context、Inspector 复用现有 `RuntimeStore`、`ConversationLoadTracker` 和严格 preload bridge，以 `{workspacePath, sessionId}` 绑定当前会话并丢弃迟到响应。
- `WorkbarResourceKey`、revision/cursor 和 active-only subscription 延后到步骤 5 第一个动态资源协议冻结时引入，避免 P0 产生没有调用方的抽象。
- 验收：切换 Session 时动态 Inspector 自动关闭；Review 与 Context 始终从当前会话的 Runtime snapshot 读取，不由 Panel 自行刷新。

[x] 3. 实现右侧单 Dock 的 Workbar Shell。

- 新增 `SessionWorkbar`、tab reducer、Launcher、tab strip、resizer 和版本化布局持久化；将当前 Environment Panel 与 Conversation Inspector 迁入同一容器。
- 首版支持 320–600px 宽度、折叠/恢复、切换、关闭、MRU 回退、拖拽排序，以及 `ArrowLeft/ArrowRight/Home/End` 键盘导航。
- 布局和静态标签拓扑可持久化；动态资源标签不跨重启盲目恢复。窄窗口沿用受控 overlay，不遮挡 composer 的主要操作。
- 验收：Shell 不保存任何领域真相；折叠、切 Session 和关闭标签后焦点与订阅生命周期正确。

[x] 4. 接入现有 Review、Context 和 Inspector 数据。

- Context 调用现有 `session.context.get`，展示模型窗口、已用、剩余、组成和 compaction 边界；Transcript 仍可完整分页读取。
- Review 首版明确采用 completed-run checkpoint 语义；先加载文件摘要，展开单文件时才调用 `changes.diff`，移除当前 N+1 加载。
- Tool/Subagent Inspector 消费 durable transcript 与现有 `run.live` tool/subagent 消息，不再与整个 Workbar 互斥。
- 验收：运行中 Review 不宣称实时 Git 状态；compact 后 Context 改变而历史 Transcript 仍存在；大量变更文件的首屏请求有界。

[ ] 5. 建立 Session Work Projection 与 Task Authority。

- 新增 session-scoped 任务 authority 和稳定任务身份，至少支持 `pending / in_progress / blocked / completed / failed / cancelled`、parent、owner、revision 和完成证据。
- 为 UI 暴露有界、可分页的 `session.work` projection；显式任务、Plan、Graph work 和 subagent 只按已冻结的稳定 ID/优先级合并，不能重复显示或相互覆盖。
- 如开放模型写入，提供专用 task create/update/claim/settle 工具和状态迁移校验；每轮 prompt 只注入 active/recent 的有界投影，不注入全量账本。
- 定义 fork 复制边界、archive 只读行为和 delete 清理行为；不得读取或写入 workspace TodoStore。
- 验收：同 workspace 两个 Session 的任务完全隔离；并发更新使用 revision/CAS fail-closed；重启后可恢复，删除 Session 不影响长期 Memory Fact。

[ ] 6. 补齐 Host-owned Interaction 可操作状态。

- 新增 Interaction list/status 投影，状态至少包含 `pending / resolved / expired / interrupted`，并携带 workspace、session、run、interactionId 和 expectedVersion。
- 只有 Host 确认仍 pending 的审批/提问才能显示操作按钮；Transcript 继续承担审计，不作为 action authority。
- 启动恢复时，将无法重新绑定执行流的 unresolved 请求收敛为 interrupted；重复或过期响应必须幂等或 fail-closed。
- 验收：请求发出后强杀并重启，历史卡片仍在但不会出现可点击的“幽灵审批”；跨 workspace 请求不可互相响应。

[ ] 7. 建立 Artifact Authority 与 Files Panel。

- 定义稳定 artifactId、workspace/session owner、kind、MIME、size、hash、status、createdAt，以及原子 ingest/commit 和 deleted tombstone。
- 提供分页 list、按 ID 查询、chunk/range read、delete、open/save-as 和 change subscription；Renderer 永远不接触绝对路径。
- Main/Daemon 负责 realpath containment、symlink escape、MIME、大小和预览策略；大文件不以完整 base64 放入 React state，HTML 不获得任意脚本/网络能力。
- 在开放 Files 前实现并验收 `event_log_blob_gc_intents` 消费/完成路径，把 Session delete、retention、hard cut 与 Artifact 物理清理接成可恢复闭环。
- 验收：崩溃中的 ingest 不会显示为 live；deleted/missing/corrupt/too-large 有明确状态；Git changed files 和普通项目文件不会混入 Files。

[ ] 8. 建立有界的 Session Trace Projection。

- 新增 `session.trace` 查询，以 canonical RuntimeEvent 的 sequence/causal IDs 为主线，关联现有 `model.call.settled`、usage ledger、Tool T1/T2、permission、compaction 和 terminal facts。
- Trace 与当前 Context 保持两个独立 authority；token、cache、cost、latency 缺失时报告 coverage gap，不能把未知值显示为 0。
- 使用 revision/cursor、按 turn/step 分页或 checkpointed reducer；只在 Inspector 可见时 debounce/coalesce 刷新，不在 Renderer 重放全量 Transcript。
- 验收：Trace 汇总与已有 Usage 的已报告范围一致；超长 Session 请求和内存有界；任一 Trace/Context 查询失败不会清空另一份最后可信结果。

[ ] 9. 增加 Host-owned PTY Terminal 资源。

- 在 Main/Runtime Host 中实现 create、attach、snapshot/replay、sequenced delta、input、resize、stop、detach、exit 和 resync；Terminal 与 transcript 中的 Bash tool result 保持不同语义。
- 终端创建必须经过 workspace trust/permission，cwd 受 workspace 边界约束；定义 owner、孤儿进程、窗口关闭、daemon 崩溃和应用重启后的清理规则。
- 若引入 `node-pty` 等 native dependency，同时更新 Electron Forge 打包/签名配置并做产物启动验证。
- 验收：attach snapshot 与 live delta 无缺失、重复或乱序；关闭标签释放 controller；不可验证的动态资源在重启后不伪装为仍存活。

[ ] 10. 执行分阶段集成验收并设置发布闸门。

- 新增 `desktop-session-workbar.test.ts`、`desktop-workbar-existing-api.test.ts`、`desktop-session-task-trace.test.ts`、`desktop-interaction-status.test.ts`、`desktop-artifact-runtime.test.ts` 和 `desktop-terminal-runtime.test.ts`；扩展 `runtime-live-tool-events.test.ts` 覆盖 tool/subagent 对账。
- 运行受影响的集成测试、Desktop/root typecheck、lint、format、build；PTY 阶段额外运行 Desktop package/make 验证。
- 在真实 Electron 中走查 Launcher、标签、resize、折叠、Session 切换、daemon reconnect、窄窗口、键盘与焦点，并记录截图证据。
- 只有通过相应 authority 和生命周期关卡的标签才能进入默认 Launcher；不得用空壳或示例数据提前占位。

## Collaboration

- P0 首批按文件所有权并行：切片 A 只实现 `renderer/workbar/` 中的类型、reducer 和布局持久化；切片 B 只实现 Workbar Shell 组件与局部样式；切片 C 只新增集成契约测试与可访问性断言。三者不得修改 `App.tsx`、`renderer/runtime.ts` 或共享全局样式。
- 主集成者单独负责 `App.tsx`、`renderer/runtime.ts`、`styles.css`、tab registry 和计划状态，将三个切片串行合并后接入 Review、Context 与 Inspector。
- 步骤 5–9 在协议冻结后可按 Tasks、Interaction、Artifacts、Trace、Terminal 拆到独立 worktree 并行实现；`packages/protocol/src/runtime.ts`、Schema/迁移、锁文件和 tab registry 仍由单一集成所有者串行修改。
- 每个垂直切片必须携带自身的最小集成测试与验证结果，主分支只合并通过对应发布闸门的切片。

### P0 并行开发波次

- Wave 1：A/B/C 从同一 UI 重写基线并行开发，分别提交独立任务分支。
- Wave 2：主集成者先合并 A，再将 B/C 变基或摘取到集成分支，处理仅限公开组件接口的冲突。
- Wave 3：主集成者接入真实数据、移除 Review 的首屏 N+1 diff 请求，并完成真实 Electron 验收。
- Wave 4：通过 P0 闸门后再冻结 Tasks、Interaction、Artifacts、Trace、Terminal 协议；本轮不提前写 Schema 或占位标签。

## Validation

- P0 闸门：步骤 1–4 的定向集成测试、`npm run desktop:typecheck`、`npm run typecheck` 和真实 Electron Workbar 主路径通过；不产生数据库迁移。
- 核心数据闸门：步骤 5–8 覆盖同 sessionId 跨 workspace、并发 revision、强杀恢复、Session 删除、超大任务/Artifact/Trace 分页，并验证 committed Memory Fact 不变。
- Terminal 闸门：步骤 9 覆盖 snapshot/delta 竞态、输入/resize/stop、孤儿清理和打包产物启动。
- 性能闸门：打开 Workbar 不触发全量 Transcript 重放；Review、Tasks、Artifacts、Trace 的首屏请求、单帧大小和 Renderer 常驻数据均有显式上限。

### P0 实施记录

- 已完成右侧单 Dock、多标签、Launcher、320–600px 缩放、折叠、MRU、拖拽排序，以及方向键、Home/End 和键盘排序；折叠后只保留标题栏中的唯一恢复入口。
- Launcher 只展示已有真实 authority 的概览、变更和上下文；Tool/Subagent Inspector 以当前 Session 的动态标签打开，并且不进入持久化布局。
- Context 已接入 `session.context.get`；Review 首屏只读取 `changes.list`，选中单文件后才请求 `changes.diff`，移除了按文件预取 diff 的 N+1 请求。
- 已增加 Workbar 状态、可访问性、真实面板边界、按需 diff 和 Context hydration 的 8 条定向集成测试，并完成 Desktop/root typecheck、lint、format 与真实 Electron 主路径验收。
- 本阶段没有新增数据库 Schema、长期记忆生命周期或任何无 authority 的占位标签；Tasks、Interaction、Artifacts、Trace 与 Terminal 仍按步骤 5–9 推进。

## Open Questions

- Tasks 首个可发布版本是否允许模型直接增删任务？默认：P0 不允许，步骤 5 完成 Task Authority 后再开放。
- Review 是否必须在运行中展示实时工作树？默认：首版坚持 completed-run checkpoint 语义；若需要实时 Git Review，另增独立 workspace Git authority，不改变 `changes.*` 的既有含义。
- Browser 与 Side Chat 是否进入本轮？默认：不进入，等核心 Workbar 数据闭环稳定后分别立项。
