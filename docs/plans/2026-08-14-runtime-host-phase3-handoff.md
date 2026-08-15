# 北极星·阶段 3 runtime-host：交接记录

> 日期：2026-08-14
> 用途：跨 session 衔接。本 session 完成阶段 3-A runtime-host 骨架移植 + 四轮对抗审查 + 3-B 前置项。
> 关联：`docs/plans/2026-08-13-north-star-gateway-and-claim.md`（北极星方案）、`docs/architecture/20-architecture-audit-and-governance.md`（D9/D12 债务）

## 一句话现状

**阶段 3 全部完成（2026-08-16）：3-A 骨架 + 3-B 全部 + 3-C Desktop + 3-D Phase 1-4 + Phase 5 退役进程内交互路径（删 repl.tsx 3,592 行 + 7 孤儿模块 + --local；D14 扩展到整个 src/tui）→ 北极星阶段 3 收口。遗留高优先"daemon 间歇死锁"已闭环（2026-08-16）：根因= e2e 打真 home 累积 118 条工作区注册（54 个 %TEMP% 目录存活）→ cron 忙循环 + workspace.list 超 deadline，叠加 registration 发布 rename EPERM 崩候选与选举名额烧光；修复= e2e 隔离 daemon root + renameWithRetry + 选举名额折扣 + launcher stderr 落盘（candidate-logs 常驻取证）；真 home 已清理并验证健康；全矩阵 e2e 隔离版 4/4（127s）。**

## 本 session 完成的事（2026-08-16：死锁闭环 + Phase 5 退役）

| 交付 | 内容 |
|---|---|
| **stderr 落盘基础设施** | `packages/runtime-host` launcher：候选 spawn 的 stdout/stderr 重定向到 `<control>/candidate-logs/candidate-*.log`（唯一文件名 + 头部元数据 + 保留最新 20 份 + 失败降级 ignore 不破坏选举）；connectOrSpawn 默认派生目录（`candidateLogDirectory` 可覆盖）。机制测试 3/3（含双流取证断言）。 |
| **死锁根因三连修复** | ① e2e（full-matrix + tracer）改每场景独立 pico-home + 专属 daemon + 结束 `shutdownDaemon` 优雅关停（不再打真 home，不泄漏进程）；② `renameWithRetry`（packages/runtime-host control 层，registration + marker-file 共用，EPERM/EACCES/EBUSY/ENOTEMPTY 有界重试，node:timers/promises 不触手写原语门禁）；③ connectOrSpawn 选举名额折扣（活满 5s 后死亡的候选一次性不占 `maxCandidateLaunches`，秒退守卫拒绝仍全额计数——A6 风暴防护不变）。daemon 侧：listWorkspaces 对缺失目录降级为全能力关闭条目（协议闭合形状）、reconcile 跳过缺失目录不物化 cron runtime（竞态护栏；根治在 e2e 隔离）。 |
| **环境清理** | 优雅关停 26h 龄劣化 daemon（runtime.shutdown 实测可用）+ 清真 home 注册表 118 条/信任库 99 条垃圾（真工作区保留）+ 删 %TEMP% 424 个 pico-* 目录 + 上午清 9 个孤儿 daemon 进程。新 daemon 验证：ping 26ms、workspace.list 即回、无客户端 75s+ 常驻、CPU 空闲。 |
| **Phase 5 退役** | 详见 `docs/plans/2026-08-15-tui-daemon-client-migration.md` Phase 5 实施记录。 |

**死锁取证方法论（stderr 基础设施的直接回报）**：真 home 的 candidate-logs 在 e2e 失败窗口抓到 4 个候选全被"旧版本 daemon 在运行"拒绝（实为劣化 daemon 持锁 + 重生被阻断）；测试 root 的 candidate-logs 抓到 `EPERM rename registration.json` 崩溃栈——两处都是零改动收益（候选输出自动落盘）。诊断脚本保留 `scripts/stress-daemon-diag.ts`（死端点高频压测 + pid 时间线 + 证据倒出）与 `scripts/probe-daemon.ts`（kernel/业务双层探针）。

## 本 session 完成的事（6 commit，均在 main）

| commit | 内容 |
|---|---|
| `a6617200` | **阶段 3-A 骨架移植**：从 maka runtime-host 模式移植机制骨架到 `packages/runtime-host/`（transport NDJSON / control endpoint+registration+flock 选主 / protocol 核心帧 / server RuntimeHostKernel / client RuntimeHostConnection+connectOrSpawn）。零业务消费，compositionFactory 注入点。 |
| `a3255e79` | 首轮对抗审查修复：endpoint 前缀 m-→pico-、artifact-writer-bootstrap-lock 重写（waitForLock+TOCTOU）、握手帧 requireShapedRecord 严格化、删死代码 |
| `8b78cae1` | 二轮修复（3-B 阻塞项）：launcher spawn entrypoint tsx 支持、retired 槽位 TTL、recover 启动 deadline、idleGraceMs 透传 |
| `253f36bd` | 三轮修复：recover timer 成功后 clearTimeout（防 60s 自我 drain）、idle 认握手、retired 条目 TTL、launcher fileURL |
| `c926f57c` | 四轮修复：僵尸 host 回归（idle 定时器重装）、#removeRetiredEntry 防御性释放槽位、host.status 公共 request scope、dist rebuild |
| `76dd4cac` | **3-B 前置项**：host 侧 operation deadline（挂死 handler 防泄漏）+ test-only composition 补 request 生命周期实盘测试 |

## 当前状态

- **runtime-host 骨架**（`packages/runtime-host/`）：机制层完整稳健——握手/帧编解码/背压/flock 选主/计数对账/deadline 体系/operation deadline。经四轮对抗审查 + 16 个 runtime-host 测试 + e2e 验证。
- **零业务消费**：`src/`（pico 业务）尚未 import runtime-host。骨架是独立基座，等 3-B 接入。
- **验证基线**：typecheck 0（包+根）、runtime-host 16/16、invariants+dedup 回归、门禁 0、e2e graph-mode-multiround 6/6。

## 接下来要做：3-B（daemon 接入 runtime-host）

**目标**：`LocalDaemonHost` → `RuntimeHostKernel`，compositionFactory 接 pico 业务 handler，最终 Desktop/TUI 经统一 `RuntimeHostConnection` 接入。

### 渐进路线（来自北极星方案 + daemon 探索）

1. **3-B-1 桥接 composition**（第一步）：写 `RuntimeHostCompositionFactory`，内部实例化现有 production-host 装配（`createProductionLocalDaemonHost` 的 DesktopRuntimeService + WorkspaceRuntimeService），handler 层做 `operation ↔ RuntimeRequest` 适配。先挑少数 query 方法（workspace.status / usage.get）走 runtime-host，验证 dispatch/decode 链路。不动事件、不动客户端。
2. **3-B-2 事件协议**：补 subscription/event 帧（kernel 3-A 无 Host→Client 帧，**最大难点**）+ 出站推送通道；把 events.subscribe/replay 语义（cursor/high-watermark/fence-on-error）移植；解决 96KB 帧限制下的 replay 分页。
3. **3-B-3 选主迁移**：daemon main.ts 改 candidate 模式（flock 选主 + 注册发现），保留 instance-lock 作升级期兼容探测；cron-daemon-bridge/Desktop 控制器改 connectOrSpawn。
4. **3-B-4 客户端迁移**：Desktop → TUI（TUI 最后，部署模型变化最大，建议单独立项；移动端已移除，不再是迁移项）。

### 关键难点 / 注意

- **91 个 RUNTIME_METHODS 的 OperationSpec 化**：每方法写 `{mode, availability, errors, decodeInput, decodeOutput}`；output 也要严格解码（daemon 现在是 JsonValue 透传）。错误码映射 RUNTIME_ERROR_CODES → HostOperationErrorCode。
- **帧大小 96KB vs daemon 1MiB**：transcript/replay 大 payload 需重设计分页粒度。
- **Windows 安全模型**：daemon 现在用 IPC token（named pipe 无 DACL），换 kernel 后靠 OS 用户文件权限，需评审。
- **事件推送是 3-B 技术核心**：daemon 的 durable ledger（RuntimeStore）+ high-watermark 分页回放 + 客户端 RuntimeNotificationBuffer 去重，语义要保留，承载帧从长度前缀换 NDJSON。
- **daemon 探索参考**：本 session 的子代理探索结论在记忆 `pico-gateway-layer-north-star.md` 的"3-B 现状与路线"段（LocalDaemonHost=生命周期内核/service 注入同构 compositionFactory、双层 handle、三个拉起入口、instance-lock 机制）。

### 起步建议（3-B-1）

1. 读 `src/daemon/production-host.ts`（createProductionLocalDaemonHost 装配链）+ `src/daemon/desktop-runtime-service.ts` / `workspace-runtime-service.ts`（handle 分发）。
2. 写 `RuntimeHostCompositionFactory`：复用 production-host 装配，handlers 做 operation ↔ RuntimeRequest 适配。
3. 先接少数 query 方法验证 dispatch/decode 链路，再逐步扩到 91 个。
4. 每步对抗审查 + 集成测试 + e2e。

## 3-B-1 已完成（本 session 追加）

**交付**：`src/daemon/runtime-host-operations.ts`（spec 定义 + 注册）+ `src/daemon/runtime-host-composition.ts`（桥接 composition 工厂）+ `tests/integration/runtime-host-composition-bridge.test.ts`（5/5 通过）。根 package.json 增加 `@pico/runtime-host` 依赖。

**验证**：`workspace.status` / `usage.get` 已走完整链路（帧解码 → decodeInput → handler → service.handle → decodeOutput → 应答）；错误映射（daemon INVALID_PARAMS → invalid_request）与 malformed input 拒绝均有实盘断言；host.status 无 activeOperations 泄漏。全部 21 个 runtime-host 测试 + 3 个 desktop-runtime-close 回归 + typecheck 0 + 架构门禁 0。

**关键决策（对齐 maka 后反转）**：领域 operation spec **不进 runtime-host 静态面**，改由 pico 侧经 `registerHostOperationSpecs`（由 3-A 的 test-only 注册函数泛化而来，保留 ForTesting 别名）在进程启动时动态注册。原因：
- maka 的 spec 静态注册成立，是因为 maka 的 runtime-host 就是产品宿主层（composition 全量覆盖 91+ 操作）；pico 的 3-A 明确把 runtime-host 做成零业务机制层，静态并入会迫使 3 个机制层测试（skeleton/composition-lifecycle/operation-deadline）为 pico 业务操作补 handler，机制测试与业务耦合。
- 动态注册后静态 `OperationKey` 仍只有 bootstrap，composition 的 handlers 需 `as unknown as` 转型（与既有测试同款）；client 侧用 `requestRegistered` 调动态操作。
- 测试必须与 composition 走**同一模块实例**：runtime-host 符号从构建产物 `@pico/runtime-host`（dist）导入而非 `packages/runtime-host/src`，否则 src/dist 两份动态注册表互不可见（模块身份问题，测试文件头部注释已记录）。

**3-B-1 未做**：事件/订阅帧（3-B-2）、选主迁移（3-B-3）、客户端迁移（3-B-4）、其余 89 个 RUNTIME_METHODS 的 spec 化、daemon main.ts 改动。

## 3-B-1 问题整改（第一批 + 第二批，本 session 追加）

对 3-B-1 交付做了两轮整改，动机见 `docs/plans/2026-08-14-runtime-host-phase3-handoff.md` 上文梳理（dist 滞后、双套校验、类型面弱化、production 装配未暴露）。

**第一批（已完成，小改）**：
- `pretest:integration` 增加 `build:runtime-host`（新脚本 `build:runtime-host`），dist 不再可能静默滞后。
- composition 依赖最小接口 `RuntimeHostBridgeService`（`{handle, close?}`），不再绑定 `DesktopRuntimeService` 具体类——测试可注入 fake，3-B-3 可注入 production service。
- 补 decodeOutput 拒绝路径测试（坏 service → internal_failure，连接不断）。

**第二批（已完成）**：
- **production-host 重构**：抽出 `createProductionRuntimeServices()`（返回 service/desktopService/registrationStore/validateAutomation 等 + `attachHost()` late-binding——automations 的 host 引用改为 `requireHost()`，接口 `ProductionHostControl`）。`createProductionLocalDaemonHost` 变薄装配（解构 + cronRuntimeFactory + LocalDaemonHost）。3-B-3 直接复用 `createProductionRuntimeServices` 喂给 composition。
- **spec 委托 @pico/protocol 校验**：`runtime-host-operations.ts` 的 decodeInput/decodeOutput 改委托 `parseStrictRuntimeParams` / `parseDesktopRuntimeResult`（单源校验，删掉手写第二套字段校验）；usage.get 无 result 规则，保留结构检查 + 64KB 字节上限。行为与手写版等价（bridge 测试 6/6 验证）。
- **编译期 handler 契约**：新增 `PicoBridgeHandlerMap`（从 spec map 推导 input/output/错误码），composition handlers `satisfies` 它——handler 与 spec 不一致编译期报错（替代 `as unknown as` 裸转）。

**验证**：22/22 runtime-host 测试 + bridge 6/6 + 根 typecheck 0 + 架构门禁 0。`desktop-plugin-parity` 测试 3 在 Windows 上预存失败（断言硬编码 `/workspace/...` Unix 路径，registry 内部 resolve 成 `D:\workspace\...`），与本次改动无关。

**剩余（3-B-3 前置项）**：错误码映射语义（FORBIDDEN→capability_unavailable 失真，3-B-2 统一）、客户端注册调用点（3-B-4）、其余 89 个方法 spec 化（现在每个方法样板已缩到 ~10 行）。

## 3-B-2 已完成（事件协议，后续 session 追加）

**交付**：
- **kernel 机制层**（`packages/runtime-host/src/`）：`HostFrame` union 新增 `HostEventFrame {kind:"event", event: <不透明 JSON 对象>}` + `decodeHostFrame` 分支；`RuntimeHostConnectionSession.pushEvent`——串行推送链（promise 链同一时刻至多一个 enqueue+flush，与 response 经同一 writer 有序交错），任何失败 fence teardown 连接；`ConnectionContext` 新增可选 `pushEvent`（session 注入，handler 捕获闭包可在请求结束后继续推送）；client `#readResponses` 路由 event 帧到 `setEventListener(listener)`，未知 kind 仍 fail（严格）。
- **桥接层**（`src/daemon/`）：`runtime-host-events.ts`（事件桥接协调器——一连接一订阅、subscribe-then-replay 顺序、live 裁剪、replay 重打包、releaseConnection/beginDrain 清理）+ operations.ts 增 events.subscribe/replay spec（独立 map `PICO_RUNTIME_HOST_EVENT_OPERATION_SPECS` + `ensurePicoRuntimeHostEventOperationsRegistered` 两步注册）+ composition 接 `eventSource?` 可选注入；`workspace-runtime-service.ts` 导出 `transportSafeRuntimeNotificationWithin`（通用字节预算裁剪）。
- **测试**：`runtime-host-event-push.test.ts`（机制层 3 条：wire 顺序 / 捕获 sink 请求后推送 / 超限 fence）+ `runtime-host-events-bridge.test.ts`（桥接 4 条：首页+live 推送 / high-watermark 固定分页 / cursor 失效 invalid_request / 断连退订无泄漏）。

**保留的 daemon 语义**（见 runtime-host-events.ts 头注释）：排他 eventId cursor；首页捕获固定 high-watermark（hasMore=cursor 未达上界，重打包后重算）；INVALID_PARAMS→invalid_request 兼作客户端"cursor 失效重置"信号；ephemeral（run.live）只走 live 不入 ledger 不推 cursor；fence-on-error（推送不可投递即 teardown，客户端重连 replay）；commit-before-notify。

**关键决策**：
1. **只加一种帧**（`{kind:"event", event}`，形状对齐 daemon 现有 event 帧）：订阅确认走 events.subscribe 普通 response；无订阅管理帧。不采用 maka 的 activate-after-enqueue（daemon 客户端容忍 event-before-response，靠 eventId 去重）与 sequence/gap 检测（eventId cursor 更强，支持续传）。
2. **帧载荷不透明**（kernel 只校验 plain object）：延续"机制层业务零感知"决策，RuntimeNotification 形状由桥接层 @pico/protocol 校验。
3. **96KB vs 1MiB 偏差处理**（maka 对齐）：live 推送按 92KB 预算分级裁剪（`transportSafeRuntimeNotificationWithin` 复用 daemon 同款 tiers，只裁 payload 不动 eventId/topic/scope）；replay 页贪心装箱重打包（hasMore 重算，截断页下次 replay 续传）。**已知限制**：单 durable 事件序列化超 ~92KB 无法承载，replay 显式报错（绝不静默跳过——那会让 cursor 越过丢失事实）；将来有真实消费方再立 maka 式分页 query。
4. **events spec 独立 map + 两步注册**：`composeOperationHandlers` 要求注册表内每个 key 有 handler，故 events.* 注册必须与 composition 提供 eventSource 成对（无 eventSource 的 composition 不注册 events spec）。
5. **`mapRuntimeErrorCode` 上移 operations.ts**：query 桥与事件桥共用错误映射（避免 composition↔events 循环依赖）；composition.ts 保留 re-export。

**验证**：runtime-host 全套 29/29（22 旧 + 3 机制 + 4 桥接）、composition-bridge 6/6、desktop-runtime-close 3/3、根 typecheck 0、架构门禁 0。注意机制测试从 src 导入、桥接测试从 dist 导入（模块身份规则不变）。

**3-B-2 未做**：客户端完整订阅抽象（RuntimeSubscription 断线重连/去重环——3-B-4 客户端迁移时移植 `src/daemon/client.ts` 逻辑）、daemon main.ts 改动（3-B-3）、FORBIDDEN→capability_unavailable 失真仍维持（评估结论：kernel 错误码集是机制层公开面，无消费方需要区分前不扩，Desktop 迁移时按需重评）。

## 3-B-3 已完成（选主迁移·硬切，2026-08-15 追加）

**用户拍板硬切**（不留旧传输并存）。**移动端（mobile-gateway/apps/mobile/protocol mobile 定义）已于 2026-08-15 移除**，3-B-4 不再有 mobile 迁移项。3 个 commit：

| commit | 内容 |
|---|---|
| `f7c7e52b` | 前半：daemon main → candidate 模式（`runtime-host-candidate.ts`：升级守卫旧 instance-lock+ping → flock 选主 → kernel + production composition）；`runtime.request` 通用桥接（91 方法经单帧 `{method, params}` 透传 service.handle，spec 化留 3-B-4+ 渐进退役）；帧上限 96KB→1MiB + 队列 8MB；launcher .ts entrypoint（tsx loader 绝对路径）+ file:// href；connectOrSpawn env 透传；LocalDaemonHost services-only 模式；whoami/icacls 绝对路径修复 |
| `9b764d5e` | 后半：`client.ts` kernel 承载（`KernelRuntimeConnection`——connectOrSpawn 拉起 + runtime.request/events.* 桥接 + host 错误码反查 daemon 码保订阅环 INVALID_PARAMS cursor 重置语义；**双模式**=显式 endpoint/authTokenStore 走旧 socket 保注入测试）；传输级失败（terminalError）丢弃死连接重生重试一次；events.subscribe 桥接改**覆盖语义**（重订阅 dispose 旧的，原拒绝式会卡死 cursor 重置重订）；workspace-registry git 环境降级；kernel 客户端实盘测试 3 条 |
| `eff5ea11` | 收尾：cron-bridge 默认 client kernel 化（删旧 socket endpoint + spawn/install 兜底）；Desktop 删 in-process daemon host（旧传输 host 与 kernel client 脱节）瘦客户端化；mobile-gateway 状态标注（其后被整体移除） |
| `d1e3eaa4` | 审查闭环：重生重试固定次数改 **30s 时间预算**（`KERNEL_RETRY_WINDOW_MS`，慢环境每次 connectOrSpawn 选举 10-24s，固定 3 次不够）；candidate 测试 status 断言改轮询等 ready（15s）；Desktop 首次 ping 30s/500ms 退避重试（P1-1）；workspace-registry 降级注释修正 |
| `02d4e058` | **daemon stop**：`runtime.shutdown` kernel 操作（独立 spec + candidate composition handler 触发 requestDrain，与 SIGTERM 同路径）+ `LocalRuntimeClient.shutdownDaemon()` + `pico --daemon-stop`（先 registration 探测，无 daemon 不拉起） |

**关键决策**：
1. **常驻用可释放 residency 而非 retainUntilProcessExit**：后者是不可逆闩，会让 kernel `#waitForResidencies` 永等、优雅关停退化为 deadline 强杀。candidate 持一个长驻 residency 阻止 idle 自退（cron 调度依赖 daemon 常驻），close() 尾部释放——"常驻 + SIGTERM 可优雅关停"兼得。TUI/Desktop 退出后 daemon 继续常驻，cron 持续调度。
2. **client 双模式**：默认构造走 kernel（connectOrSpawn 自动拉起/连上常驻 daemon）；显式注入 endpoint 时走旧 socket（存量注入测试兼容）。旧 socket 传输的生产调用点已清零，只剩测试注入面。
3. **events 订阅覆盖语义**：daemon server 的 setSubscription 本就是覆盖式；桥接层原拒绝式 operation_conflict 会卡死客户端 cursor 失效后的重订流程。
4. **git 环境降级**（workspace-registry.ts）：本机安全 agent（PATH 见 `%AccessAgentLibs%`）可间歇挂起 git.exe 启动数秒（实测 ~50% 概率，裸 shell 正常、daemon 进程内挂起，`git --version` 同样挂——execFile 5s 超时强杀，空 stderr + "Command failed" 形态）。killed/ETIMEDOUT/EACCES/EPERM 按 folder mode 降级（物理路径 canonical），快速非零退出仍 fail-loud。**根因在环境层不可代码根治**，此为可用性优先取舍。
5. **Desktop 瘦客户端化**：in-process host（createProductionLocalDaemonHost servicesOnly:false = 旧传输）与 kernel client 脱节且输掉 flock 会连累宿主进程；删除后 Electron 首次 ping 经 connectOrSpawn 拉起常驻 daemon，quit 不等 daemon 关停。shutdown fence 纯函数保留（lifecycle-races 覆盖）。

**验证**：四文件（kernel/replay/candidate/close）两轮 11/11；lifecycle-races 31/32（1 个 hook reloader watcher 既有失败，stash 验证与本次无关）；根 typecheck 0 + desktop main tsconfig 0；对抗审查（P0 无）。

**对抗审查遗留（3-B-4 处理；P1-2/P1-3 已收尾，见下方 3-B-4 章节）**：
- ~~P1-2 terminalError 重试可双执行~~（已修：`KERNEL_RETRY_SAFE_METHODS` 幂等白名单，非幂等写不自动重发）。原文：连接 terminal 后单次重试不区分"daemon 死"与"daemon 活着但连接被杀"——后者重发写方法（session.send 等）可能双执行（双 LLM turn/双提交）。窗口窄（deadline 失败响应未达客户端时）。
- ~~P1-3 960KB–1MiB 结果硬失败~~（已修：transcript 预算改从 `RUNTIME_REQUEST_RESULT_MAX_BYTES` 派生）。原文：runtime.request 帧预算 1MiB-64KB，超限结果客户端 decode 失败且杀连接；旧 socket 合法的大 transcript 页成死区。
- P1-1（冷启动 recover 窗口首个 ping 失败致 Desktop 误报启动失败）已修：首次 ping 带 30s/500ms 退避重试（RUNTIME_UNAVAILABLE retryable）。
- P2 已评估：**daemon stop 已落地**（`02d4e058`：`pico --daemon-stop` + runtime.shutdown kernel 操作，常驻 daemon 现在有优雅退出路径）；cron-bridge 冷启动 45s 选举等待 UX、SIGTERM 关停 10s shutdownGrace 硬上限、覆盖订阅旧 dispose 的 pushEvent 失败回调误杀新订阅（自愈）、FRAME_TOO_LARGE→internal_failure 映射失真（无消费方）仍接受。

**3-B-3 未做**：91 方法 spec 化渐进退役、旧 socket server 代码清理（LocalRuntimeDaemon 仍服务注入测试面）——两项均为渐进路径，见下方 3-B-4 章节。

## 3-B-4 已完成（遗留项收尾，2026-08-15 追加）

3-B-3 对抗审查遗留 + 后续发现的 6 项，4 项落地、2 项评估后维持渐进：

| 项 | 处置 |
|---|---|
| **P1-2 重试双执行** | ✅ `src/daemon/client.ts`：`KERNEL_RETRY_SAFE_METHODS` 幂等白名单（41 个读方法 + events.*，覆盖语义重订等价）。传输级失败（连接 terminal）后仅白名单方法走"丢弃死连接 → 重生 → 重发"循环；非幂等写方法立即上抛 `RUNTIME_DISCONNECTED`（retryable=true，调用方决策）。有意排除 `diagnostics.run`（doctor 副作用未证伪）。 |
| **P1-3 960KB–1MiB 死区** | ✅ 根因：transcript 分页预算从 `MAX_RUNTIME_FRAME_BYTES`（旧 socket 1MiB）派生，超出 kernel 桥闸门（`RUNTIME_REQUEST_RESULT_MAX_BYTES` = 帧上限 - 64KB 信封预留）。修复：`runtime-host-operations.ts` 导出该常量，`desktop-runtime-service.ts` transcript 预算与终检改用它——daemon 侧结果永远装得进 kernel 帧，死区消失。events.replay 预留本就是 64KB，无需改。 |
| **A6 候选池 spawn 风暴** | ✅ `connect-or-spawn.ts`：单次选举窗口候选 launch 总数封顶（`DEFAULT_MAX_CANDIDATE_LAUNCHES=3`，输入可覆盖 1-16）。封顶不牺牲活性——选举循环仍轮询到 deadline，无论哪个候选先就绪都能连上；真正的候选失败由下一次调用的全新窗口兜底。慢环境（候选 19-31s）不再每 250ms 堆一个在途候选，关停后锁被晚到候选接走的不确定性大幅收窄。 |
| **host.diagnostics.query.logs 恒空**（M4） | ✅ kernel 最小环形日志（256 条 × 10KB/条，进程内）：`state=ready`、drain requested、`state=draining`、recover 超时、shutdown deadline 超时、owner 丢失、idle 退出。只记 kernel 自身生命周期事实，不含领域事件（那是桥接层的事）。 |
| 91 方法 spec 化 | ⏸ 维持渐进退役：每个方法 ~10 行样板，无阻塞消费方；随 3-C Desktop 接入按需补。 |
| 旧 socket server 清理 | ⏸ 维持：LocalRuntimeDaemon 仅剩注入测试面（client 双模式的显式 endpoint 注入路径），等测试面迁移后一并删。 |

**测试**：`runtime-client-kernel.test.ts` +1（P1-2：杀 daemon 后非幂等写立即上抛且不重生，registration pid 不变 + 死亡探针）；`runtime-host-composition-bridge.test.ts` +1（P1-3：950KB 结果完整过 kernel 线）；`runtime-host-spawn.test.ts` +1（A6：假 launcher 断言 launch 数封顶在 3）；`runtime-host-skeleton.test.ts` 扩展（logs 含 state=ready）。`connectOrSpawnRuntimeHostWithDependencies` 补导出（测试 DI 面）。

**验证**：runtime-host 全套 10 文件 38/38（--test-concurrency=1）+ 包/根 typecheck 0 + 架构门禁 0；dist 已重建。

**注**：`FRAME_TOO_LARGE→internal_failure` 映射失真维持接受（无消费方）；P1-2 的白名单语义边界=传输层不静默重发，上层（订阅环/Desktop）的重试决策不受影响。

## 3-C Desktop 已完成（fail-stuck 自动恢复 + D9/D12 反转，2026-08-15 追加）

北极星方案 3-C 步骤 4+6 落地（方案写于 mobile 移除前，实际范围经重评收窄：mobile-gateway 网关层已被 runtime-host kernel + 共享 client 取代，Desktop 在 3-B-3 已瘦客户端化）。两个用户决策：断连 UI=**全屏恢复屏**；D12=**重评后反转**。

**交付**：
1. **runtime supervisor**（`apps/desktop/src/main/runtime-supervisor.ts`）：从 index.ts 探活提取的纯 DI 双相位监督器（healthy⇄degraded）——连续 3 次探活失败（5s 假死超时随迁）广播 `unavailable`（保留不去重策略），降级后探活成功广播 `recovered`；不自动重启 daemon（幂等 ping 的重试窗口本身会尝试重生）。新 IPC 通道 `pico:runtime:recovered`（contract+bridge）。
2. **渲染层自动恢复**：`onUnavailable`/`onRecovered` 效应常驻 armed；recovered → `bootstrap()` → `loadWorkspace(当前)`，会话 transcript 由路由树重挂载（error 相位整体卸载 Routes，回 ready 重挂 → ConversationPage 的 loadSession 效应）自然重取；订阅环经 connection.kind 重订 + high-watermark 重取，dedup 无重复。fail-stuck 消除：ConnectionScreen 从终态错误页改为"正在自动恢复"恢复屏（保留"立即重试"）。
3. **AppRuntimePhase 重构（D9 实质）**：renderer `ConnectionState` 四态自维护状态机删除（"unavailable" 并入 error.detail），改为事件驱动展示相位 `AppRuntimePhase`（loading/ready/error）——连接决策全部在 main supervisor + 共享 client（RuntimeSubscription 重连环 + KERNEL_RETRY_SAFE_METHODS），渲染层只消费推送事件。
4. **ConversationLoadTracker（D12 重评收编）**：`conversationLoadGenerationsRef` 裸 ref 收编为单一职责类（`apps/desktop/src/renderer/conversation-load-tracker.ts`，begin/isCurrent 代数判定）。重评结论：D12"双实现"实质=Desktop/移动端各持同步状态机，移动端移除后消解；剩余护栏是视图竞态职责（与 workspaceLoadGenerationRef 同类），不下沉传输层；分页/游标算法保持只在 `src/daemon/desktop-transcript.ts`（selectPage）一处。
5. **追踪器反转**（architecture-invariants.test.ts）：D9 → 负向 model.ts 无 ConnectionState + 正向 supervisor 双相位广播 + daemon client 是唯一重连状态机；D12 → 负向 runtime.ts 无裸 ref + 正向 tracker 存在 + daemon 层 selectPage 唯一。均为正向不变量（对齐 D7 反转模式）。

**验证**：desktop-runtime-supervisor 4/4（降级/恢复广播、健康静默、stop 停播、假死超时）+ invariants 8/8（D9/D12 反转后）+ desktop-runtime-close 3/3 + preload-bridge 2/2 + runtime-client-kernel 4/4 + lifecycle-races 22/22 + 三 desktop tsconfig + 根 typecheck 0 + 门禁 0。

**边界**：recovered 后 bootstrap 又失败 → 留在恢复屏等下一轮（收敛）；在途写失败不自动重发（P1-2 语义，toast）；preview 模式桥接补齐 onRecovered no-op。

**3-C 未做**：D10（DelegationManager 职责错位等，阶段 2/3 交叉）、91 spec 化渐进、旧 socket 清理渐进。**下一步：3-D TUI 单独立项**（部署模型变更，北极星方案 3.4 已评估）。

## 3-D TUI 已完成 Phase 1-3（daemon 客户端迁移，2026-08-15 追加）

**详细立项与逐阶段记录见 `docs/plans/2026-08-15-tui-daemon-client-migration.md`（单一来源）**。终态：交互 TUI = daemon 瘦客户端（`pico --client`）；交互进程内路径**最终退役**（用户拍板）；headless 永久直连。

### Phase 进度总览（截至今）

| Phase | 内容 | 状态 |
|---|---|---|
| 1 | run.live 扩展 tool/subagent 实时事件（协议 union + ToolLiveCoalescer 50ms + 前向兼容契约） | ✅ 08833ce0 + 2eadb002（补 args） |
| 2 | TUI 客户端 tracer：`pico --client` 四件套（transcript-item-hydration / daemon-event-reporter / client-session-runtime / client-repl Ink 壳，TuiReporter 零改动复用）+ 真机冒烟 | ✅ 8b01dd81 + aeda783a（冒烟逮到 daemon 双规范化 bug → b875b390 修） |
| 3 首批 | plan 审批字段映射（plan.respond 闭环）/ BYOK 合并（--model/--thinking 生效）/ wake 回归 | ✅ 95b479d2 + 0f10f65f + a20bd320 |
| 3 主体 | **slash tier1 29 命令**：前置跨会话泄漏修复 + client-commands 注册表（四类，复用 in-process 解析/建议管线）+ 可测宿主 + 建议源 + 真机 slash 链 + e2e 真实模型 | ✅ eb0f2eb5 + e79db76a + d7b019ec + 68623ff2 |
| 对抗评审两轮 | 一轮 P0×5/P1×6/P2×8 + 二轮 P0×1/P1×6/P2 若干，全分级修复 | ✅ d6c15c4c + ea13ec10 |
| 3 剩余收口 | wire 归一化共享模块（终态/审批/activeRun 三处收敛）/ rewind·changes 客户端镜像（协议 mode 参数）/ 自由文本 prompt 全链路（options 可选+freeText+prompt.cancel+客户端接入）/ driver 提取按证据收口为 D14 断言 | ✅ bd308097 + 5424d72e + d8c708d1 |
| 4 | 默认切换（`pico` 默认客户端路径；--local 逃生门；--continue/--fork/--graph 补齐；冷启动连接提示） | ✅ 4ffc3cbb |
| 4 实测 | 全矩阵真机 e2e（4 场景真实模型）+ 3 真 bug 修复（fork 重入/覆盖竞态/冷启动白名单） | ✅ aa617504 |
| 5 | 退役交互进程内路径（删 repl.tsx 装配链 + --local 旗标；D14 断言扩展到整个 src/tui） | ⏳ 下一步 |

### Phase 3 剩余收口（2026-08-15 追加，bd308097 + 5424d72e + d8c708d1）

**详细记录单一来源：`docs/plans/2026-08-15-tui-daemon-client-migration.md` 的"Phase 3 剩余收口实施记录"段。** 要点：

- **现状纠偏（侦察）**：driver 叶子纯函数早已提取（items.ts/timeline.ts + 专测），立项描述过期——按证据关闭，交付物改为 D14 架构断言；discovery 豁免注释过期已修正（协议已下线）。
- **wire 归一化**（bd308097）：`packages/protocol/src/runtime-normalize.ts`——终态四套实现收敛一处（修 Desktop 非法值 "completed"）、审批 payload 结构化读取（TUI 的 planId 兜底语义回流 Desktop）、两口径谓词分离沉淀（isActiveRunStatus 水化对账 vs isStreamingRunStatus 相位灯）。
- **rewind/changes**（5424d72e）：协议 mode 参数（daemon 透传，此前硬编码 both）+ 客户端 31 命令 + RewindCommandDialog 交互三相复用 + preview 指纹缓存 + fork 后 prompt 回填/会话切换。/changes 查看型（单文件恢复协议缺口，/rewind 引导）。
- **自由文本 prompt**（d8c708d1，统一方案）：options 可选 0-6 + freeText 声明（纯开放问题免编凑选项）；submitText/broker 放行/payload 声明；**新增 prompt.cancel 协议方法**（Esc 链路此前无 RPC 对应）；客户端四件套 prompt 事件从零接入（scope 过滤同 approval + resolved 前置收口）；AskUserDialog 加文本输入态（in-process 同组件零改动受益）。
- **D14 断言**（收口 commit）：客户端四件套零引擎装配 + 连接唯一经 LocalRuntimeClient——北极星"连接状态机数=1"固化；Phase 5 扩展到整个 src/tui。
- **明确不做**（Phase 4 不依赖）：provider/cron/mcp/model-usage/agents-usage 镜像（tier2）、memory（协议缺 memory.create，BLOCKED）、/changes 单文件恢复（协议缺口）。

**验证**：typecheck 0 + invariants 9/9（D14 后）+ 客户端层 33/33 + 门禁 0 + e2e 真实模型 1/1。

### Phase 4 全矩阵真机实测闭环（2026-08-15 追加，aa617504）

**详细记录单一来源：`docs/plans/2026-08-15-tui-daemon-client-migration.md` 的"Phase 4 全矩阵真机实测闭环"段。** 要点：

- 新增 `tests/e2e/tui-client-full-matrix.real-llm.test.ts` 四场景（BYOK/--graph 落地、--continue/--fork 水化、/rewind 全链路 conversation fork、ask_user 自由文本模型真实调用+cancel），每场景独立临时工作区 + 完整清理链（session.delete + trust(false) + unregister）。**单轮 4/4**。
- **3 个真 bug 修复**：①P0 fork ALS 重入——SessionForkService.fork 直调 serialize，daemon rewind.apply 在 withSession task 内必抛（in-process 不暴露；改 withSerializedExecution）；②P1 启动覆盖 CONFLICT 竞态——sendText 返回后 run 注册窗口内 settings.update 间歇失败且单 send 场景永久丢覆盖（修：onRunStateChanged(false) 终态重试）；③P1 冷启动窗口——轮次间 daemon idle 自退拉起慢（修：register/trust 入幂等重试白名单 + harness ping 排水）。
- **方法论（已入记忆）**：常驻 daemon 是旧代码——改引擎侧后必须 --daemon-stop 重启再测（模型亲口答旧 schema 才暴露）；断言别锁模型字面输出（"请只回复 ok"会回"好的。"），确定性锚点=user 发送文本/RPC 字段/事件到达；runtime.ping 是 EmptyParams；排水要 assistant+idle 双信号。

### 对抗评审要点（两轮沉淀，方法论入记忆）

- **一轮 P0×2 同根**：`config.effective.get` wire 是嵌套 `{config:{...}}`——客户端 flat 读取致 /model 与 BYOK 在真 daemon 恒空，而 fake 双编码同错形状使矩阵全绿（**fake 是镜子不是证据**，wire 形状必须读协议源）；root typecheck 实际 30 错——`| head && echo OK` 管道吞退出码（**与 8876dd2c dist 钩子叠加成完整教训链：typecheck 退出码必须独立判定**）。
- **二轮 P0**：一轮的"选择器 onConfirm"修复是死代码——纯渲染组件收到 callbacks 即丢弃，键盘交互层只在 repl.tsx 的 Interactive* 包装里（**接线修复必须追到事件源，prop 传到位 ≠ 可达**）。真修复：InteractiveModelSelector/InteractiveSessionBrowser 提取到组件模块 + host 交互版渲染 + closeDialog 闭合链。
- **parity 漂移门**（e79db76a 起，两轮扩展）：双注册表断言 name/aliases/usage/argumentHint/category/availability 相等 + builtin 覆盖清单（BLOCKED=协议缺口/DEFERRED=tier2 两类，单一来源在测试）；元数据漂移在落地日已实际发生（6 别名 + /mode 语义分叉），此门将其永久转红。
- **枚举校真**：三套终态判定各自臆造非枚举值（interrupted/completed）——读 protocol 类型定义是唯一真相源。
- **App contract**：client 传 props 缺失会静默劣化（permissionMode 默认 "yolo" 误显）——已建 settings 快照桥（settings.get + settingsUpdated → App props）。

### 当前客户端架构（Phase 3 后）

```
pico --client → client-repl.tsx（Ink 壳：App props 桥/对话框桥/建议源）
  ├─ client-session-runtime.ts（无 Ink 核心：sendInput/request 透传/switchSession
  │   + hydrateSerial 串行对账 + scope 过滤 + BYOK + settings 快照）
  ├─ daemon-event-reporter.ts（通知→TuiReporter：run.live append-only/工具卡/
  │   子代理/双向 activeRun 对账/重叠 run 跟踪最新）
  ├─ client-commands.ts（31 命令注册表，processClientInput 分派 + availability 门）
  └─ client-command-host.ts（无 Ink 宿主：对话框数据/闭合链/切换/退出信号）
```

### 测试资产（3-D 累计）

- `tui-client-tracer.test.ts`（fake 全链路：适配器/转换器/客户端环/scope 隔离/BYOK）
- `tui-client-commands.test.ts`（全命令矩阵 + **parity 漂移门**）
- `tui-client-command-host.test.ts`（宿主分支 + 建议源 + rewind 对话框分支）
- `tui-client-tracer-real-daemon.test.ts`（真 daemon 冒烟 + slash 全链路，死端点模型）
- `cli-entry-dispatch.test.ts`（Phase 4 入口分派：默认客户端/--local/会话三式/缺口提示）
- `protocol-runtime-normalize.test.ts`（wire 归一化枚举校真 + payload 解析）
- `ask-user-free-text.test.ts`（自由文本引擎/broker/客户端链路）
- `tests/e2e/tui-client-tracer.real-llm.test.ts`（真实模型完整回合 + 清理，RUN_LLM_E2E 门）
- `tests/e2e/tui-client-full-matrix.real-llm.test.ts`（**全矩阵真机 4 场景**，RUN_LLM_E2E 门）

**注意**：e2e 不在任何 CI 门内（RUN_LLM_E2E 手动）——评审建议加定时 workflow，待用户拍板。

## 后续发现（2026-08-15 会话补充）

- ~~**connectOrSpawn 候选池**（A6）~~（已修：单次选举窗口候选 launch 封顶 3，见 3-B-4 章节）。原文：候选启动慢的环境下选举循环每 250ms spawn 一个候选（`MIN_CANDIDATE_INTERVAL_MS`），shutdown 期间池中在途候选可能接手注册写锁/守卫锁，把"优雅关停后锁应释放"变成不确定。慢环境实测：候选启动 19-31s、connectOrSpawn 首次连接可达 24s。
- **daemon stop 测试注意**：shutdown 用例用手动 spawn + connectResolvedRuntimeHost 直连（避开候选池干扰）；shutdown 机制本身经手动 spawn 验证正确（exit 0 + 锁释放 + registration 移除）。
- **本机环境**：PATH 首项 `%AccessAgentLibs%` 未展开字面量（安全 agent 注入）——hook 静态信任 fail-closed 拒绝绑定 + git 启动间歇挂起；已代码降级，根治需清理系统 PATH。


## 验证命令（基线）

```bash
npx tsc -p packages/runtime-host/tsconfig.json --noEmit   # 包 typecheck（直读 src，快）
npm run typecheck > tc.log 2>&1                            # 根 typecheck——必须走 npm 脚本（钩子重建
                                                             # 两包 dist）且**退出码独立判定**：
                                                             # `| head && echo OK` 会绑 head 的退出码
                                                             # 恒 0（对抗评审教训：30 错漏检）
node --import tsx --import ./src/tui/preload-env.ts --test --test-concurrency=1 tests/integration/runtime-host-*.test.ts
node --import tsx --import ./src/tui/preload-env.ts --test --test-concurrency=1 tests/integration/tui-client-*.test.ts   # 3-D 客户端层
node scripts/check-architecture-boundaries.mjs              # 架构门禁
RUN_LLM_E2E=1 node --env-file-if-exists=.env --import tsx --import ./src/tui/preload-env.ts --test tests/e2e/tui-client-tracer.real-llm.test.ts   # 3-D e2e（真实模型）
```

**dist 陷阱（两份真相）**：`@pico/protocol` / `@pico/runtime-host` 的 types/exports 指向 dist——root 的 tsc 与运行时都经 node_modules 解析到 dist 而非 src。改包 src 后：`npm run typecheck`（钩子自动重建）或手动 `npm run build --workspace=<pkg>`；直连 `npx tsc --noEmit` 会用旧类型报假错，直连测试会静默跑旧代码（3-B-1 教训）。运行时走 dist 是有意的模块身份设计（动态 spec 注册表进程级单例），勿用 paths 映射回 src（会把包源码内化进 root 程序，build 产物被污染）。

**测试注意（3-D 沉淀）**：spawn 型测试必须 `--test-concurrency=1`；waitForCondition 的布尔不许丢（`assert.ok` 包住）；断言要枚举全部结局（`kind==="local"` 三种结局都满足即 can't-fail）；e2e 重定向往日志会把日志文件卷进 node --test 发现；CMD 的 `set VAR=1 &&` 带尾空格（用 `set "VAR=1" &&`）。

## 遗留 / 已知限制

- ~~**daemon 间歇死锁（高优先）**~~（已闭环 2026-08-16，见上方"本 session 完成的事"。注：注册表对**缺失目录**本就过滤（list() dropMissing），事故主体是**存活的 %TEMP% 残留工作区**堆积——existsSync 分支与 reconcile 跳过是竞态护栏，根治在 e2e 隔离。`activeResidencies` 显示口径与常驻 residency 的对应关系未深究（实测 daemon 无客户端 75s+ 常驻正常））。
- 冷启动形态（stderr 取证确认）：首候选持 legacy 锁慢装配（13-16s）期间，兄弟候选被升级守卫按"旧版本 daemon 在运行"拒绝——消息有误导性但无害（winner 最终就绪；真旧 daemon 场景该守卫是正确的 fail-closed）。候选首连就绪慢（19-31s）维持既有预算评估。
- ~~`host.diagnostics.query.logs` 恒空~~（已落地：kernel 生命周期环形日志，见 3-B-4 章节）。
- Windows named pipe + 控制文件无显式 DACL 加固（依赖目录 ACL，四轮审查 L1）。
- T5 e2e 偶发 `EBUSY rmdir session-owners`（pico 现有 Windows flock 清理竞态，与 runtime-host 无关，重跑通过）。
- `packages/runtime-host/dist/` 是 gitignore 本地构建产物；改 src 后记得 `npm run build --workspace=@pico/runtime-host`（四轮审查教训：dist 滞后会静默失效）。
- **3-D 客户端已知边界（Phase 3 收口后仍接受项）**：~~/Desktop 归一化层三处重复~~（已收敛：@pico/protocol runtime-normalize 共享模块，bd308097）；keybindings 与 @文件补全未接（tier2）；argumentCompleter 的异步补全（session-id/skill 候选）客户端未接（tier2）；/changes 单文件恢复无协议对应（查看型 + /rewind 引导，tier2）；provider/cron/mcp/model-usage/agents-usage 镜像与 memory remember（tier2/BLOCKED，Phase 4 不依赖）；e2e 无 CI 定时门（RUN_LLM_E2E 手动，待用户拍板）；client-session-runtime 位置在 src/tui 接受（TuiReporter 端口耦合，Phase 5 退役时一并迁）。
