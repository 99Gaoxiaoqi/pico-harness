# 北极星·阶段 3 runtime-host：交接记录

> 日期：2026-08-14
> 用途：跨 session 衔接。本 session 完成阶段 3-A runtime-host 骨架移植 + 四轮对抗审查 + 3-B 前置项。
> 关联：`docs/plans/2026-08-13-north-star-gateway-and-claim.md`（北极星方案）、`docs/architecture/20-architecture-audit-and-governance.md`（D9/D12 债务）

## 一句话现状

**阶段 3-A（runtime-host 骨架）已完整交付并经四轮对抗审查 + 集成 + e2e 全绿验证；3-B-1（桥接 composition）已完成——workspace.status / usage.get 已走 runtime-host 全链路（dispatch/decode 实盘验证 5/5）；3-B-2（事件协议）已完成——Host→Client event 推送帧 + events.subscribe/replay 全语义桥接（29/29 实盘）。下一步是 3-B-3（选主迁移）。**

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

**目标**：`LocalDaemonHost` → `RuntimeHostKernel`，compositionFactory 接 pico 业务 handler，最终 Desktop/TUI/Mobile 经统一 `RuntimeHostConnection` 接入。

### 渐进路线（来自北极星方案 + daemon 探索）

1. **3-B-1 桥接 composition**（第一步）：写 `RuntimeHostCompositionFactory`，内部实例化现有 production-host 装配（`createProductionLocalDaemonHost` 的 DesktopRuntimeService + WorkspaceRuntimeService），handler 层做 `operation ↔ RuntimeRequest` 适配。先挑少数 query 方法（workspace.status / usage.get）走 runtime-host，验证 dispatch/decode 链路。不动事件、不动客户端。
2. **3-B-2 事件协议**：补 subscription/event 帧（kernel 3-A 无 Host→Client 帧，**最大难点**）+ 出站推送通道；把 events.subscribe/replay 语义（cursor/high-watermark/fence-on-error）移植；解决 96KB 帧限制下的 replay 分页。
3. **3-B-3 选主迁移**：daemon main.ts 改 candidate 模式（flock 选主 + 注册发现），保留 instance-lock 作升级期兼容探测；cron-daemon-bridge/Desktop 控制器改 connectOrSpawn。
4. **3-B-4 客户端迁移**：Mobile gateway → Desktop → TUI（TUI 最后，部署模型变化最大，建议单独立项）。

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

**3-B-2 未做**：客户端完整订阅抽象（RuntimeSubscription 断线重连/去重环——3-B-4 客户端迁移时移植 `src/daemon/client.ts` 逻辑）、daemon main.ts 改动（3-B-3）、FORBIDDEN→capability_unavailable 失真仍维持（评估结论：kernel 错误码集是机制层公开面，无消费方需要区分前不扩，mobile gateway 3-B-4 迁移时按需重评）。

## 3-B-3 已完成（选主迁移·硬切，2026-08-15 追加）

**用户拍板硬切**（不留旧传输并存；mobile-gateway 在 3-B-3→3-B-4 间未做端到端验证）。3 个 commit：

| commit | 内容 |
|---|---|
| `f7c7e52b` | 前半：daemon main → candidate 模式（`runtime-host-candidate.ts`：升级守卫旧 instance-lock+ping → flock 选主 → kernel + production composition）；`runtime.request` 通用桥接（91 方法经单帧 `{method, params}` 透传 service.handle，spec 化留 3-B-4+ 渐进退役）；帧上限 96KB→1MiB + 队列 8MB；launcher .ts entrypoint（tsx loader 绝对路径）+ file:// href；connectOrSpawn env 透传；LocalDaemonHost services-only 模式；whoami/icacls 绝对路径修复 |
| `9b764d5e` | 后半：`client.ts` kernel 承载（`KernelRuntimeConnection`——connectOrSpawn 拉起 + runtime.request/events.* 桥接 + host 错误码反查 daemon 码保订阅环 INVALID_PARAMS cursor 重置语义；**双模式**=显式 endpoint/authTokenStore 走旧 socket 保注入测试）；传输级失败（terminalError）丢弃死连接重生重试一次；events.subscribe 桥接改**覆盖语义**（重订阅 dispose 旧的，原拒绝式会卡死 cursor 重置重订）；workspace-registry git 环境降级；kernel 客户端实盘测试 3 条 |
| `eff5ea11` | 收尾：cron-bridge 默认 client kernel 化（删旧 socket endpoint + spawn/install 兜底）；Desktop 删 in-process daemon host（旧传输 host 与 kernel client 脱节）瘦客户端化；mobile-gateway 状态标注 |

**关键决策**：
1. **常驻用可释放 residency 而非 retainUntilProcessExit**：后者是不可逆闩，会让 kernel `#waitForResidencies` 永等、优雅关停退化为 deadline 强杀。candidate 持一个长驻 residency 阻止 idle 自退（cron 调度依赖 daemon 常驻），close() 尾部释放——"常驻 + SIGTERM 可优雅关停"兼得。TUI/Desktop 退出后 daemon 继续常驻，cron 持续调度。
2. **client 双模式**：默认构造走 kernel（connectOrSpawn 自动拉起/连上常驻 daemon）；显式注入 endpoint 时走旧 socket（存量注入测试兼容）。旧 socket 传输的生产调用点已清零，只剩测试注入面。
3. **events 订阅覆盖语义**：daemon server 的 setSubscription 本就是覆盖式；桥接层原拒绝式 operation_conflict 会卡死客户端 cursor 失效后的重订流程。
4. **git 环境降级**（workspace-registry.ts）：本机安全 agent（PATH 见 `%AccessAgentLibs%`）可间歇挂起 git.exe 启动数秒（实测 ~50% 概率，裸 shell 正常、daemon 进程内挂起，`git --version` 同样挂——execFile 5s 超时强杀，空 stderr + "Command failed" 形态）。killed/ETIMEDOUT/EACCES/EPERM 按 folder mode 降级（物理路径 canonical），快速非零退出仍 fail-loud。**根因在环境层不可代码根治**，此为可用性优先取舍。
5. **Desktop 瘦客户端化**：in-process host（createProductionLocalDaemonHost servicesOnly:false = 旧传输）与 kernel client 脱节且输掉 flock 会连累宿主进程；删除后 Electron 首次 ping 经 connectOrSpawn 拉起常驻 daemon，quit 不等 daemon 关停。shutdown fence 纯函数保留（lifecycle-races 覆盖）。

**验证**：四文件（kernel/replay/candidate/close）两轮 11/11；lifecycle-races 31/32（1 个 hook reloader watcher 既有失败，stash 验证与本次无关）；根 typecheck 0 + desktop main tsconfig 0；对抗审查（P0 无）。

**对抗审查遗留（3-B-4 处理）**：
- **P1-2 terminalError 重试可双执行**：连�� terminal 后单次重试不区分"daemon 死"与"daemon 活着但连接被杀"——后者重发写方法（session.send 等）可能双执行（双 LLM turn/双提交）。窗口窄（deadline 失败响应未达客户端时）。3-B-4 按方法幂等性白名单或幂等键收敛。
- **P1-3 960KB–1MiB 结果硬失败**：runtime.request 帧预算 1MiB-64KB，超限结果客户端 decode 失败且杀连接；旧 socket 合法的大 transcript 页成死区。3-B-4 分块 query 时一并解决。
- P1-1（冷启动 recover 窗口首个 ping 失败致 Desktop 误报启动失败）已修：首次 ping 带 30s/500ms 退避重试（RUNTIME_UNAVAILABLE retryable）。
- P2 已评估接受：cron-bridge 冷启动 45s 选举等待 UX、SIGTERM 关停 10s shutdownGrace 硬上限、常驻 daemon 无退出路径（升级须手动 kill，3-B-4+ 立 daemon stop 命令）、覆盖订阅旧 dispose 的 pushEvent 失败回调误杀新订阅（自愈）、FRAME_TOO_LARGE→internal_failure 映射失真（无消费方）。

**3-B-3 未做**：mobile-gateway 端到端验证（代码已 kernel 化，apps/mobile↔gateway↔daemon 全链路 3-C 补测）、91 方法 spec 化渐进退役、旧 socket server 代码清理（LocalRuntimeDaemon 仍服务注入测试面）、host.diagnostics.query.logs 仍恒空。


## 验证命令（基线）

```bash
npx tsc -p packages/runtime-host/tsconfig.json --noEmit   # 包 typecheck
npx tsc --noEmit                                            # 根 typecheck
node --import tsx --import ./src/tui/preload-env.ts --test tests/integration/runtime-host-*.test.ts
node scripts/check-architecture-boundaries.mjs              # 架构门禁
RUN_LLM_E2E=1 node --import tsx --import ./src/tui/preload-env.ts --test tests/e2e/graph-mode-multiround.real-llm.test.ts
```

## 遗留 / 已知限制

- `host.diagnostics.query.logs` 恒空（log capture 未移植，四轮审查 M4，3-B 立项）。
- Windows named pipe + 控制文件无显式 DACL 加固（依赖目录 ACL，四轮审查 L1）。
- T5 e2e 偶发 `EBUSY rmdir session-owners`（pico 现有 Windows flock 清理竞态，与 runtime-host 无关，重跑通过）。
- `packages/runtime-host/dist/` 是 gitignore 本地构建产物；改 src 后记得 `npm run build --workspace=@pico/runtime-host`（四轮审查教训：dist 滞后会静默失效）。
