# 北极星·阶段 3 runtime-host：交接记录

> 日期：2026-08-14
> 用途：跨 session 衔接。本 session 完成阶段 3-A runtime-host 骨架移植 + 四轮对抗审查 + 3-B 前置项。
> 关联：`docs/plans/2026-08-13-north-star-gateway-and-claim.md`（北极星方案）、`docs/architecture/20-architecture-audit-and-governance.md`（D9/D12 债务）

## 一句话现状

**阶段 3-A（runtime-host 骨架）已完整交付并经四轮对抗审查 + 集成 + e2e 全绿验证；3-B-1（桥接 composition）已完成——workspace.status / usage.get 已走 runtime-host 全链路（dispatch/decode 实盘验证 5/5）。下一步是 3-B-2（事件协议）。**

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

## 3-B-2 起步建议（事件协议，下一个 session 从这里开始）

**目标**：kernel 补 Host→Client 帧与出站推送通道，把 daemon 的 events.subscribe / events.replay 语义（cursor / high-watermark / fence-on-error）移植到 runtime-host 承载。

1. **读 kernel 现状**：`packages/runtime-host/src/protocol/index.ts` 的 `HostFrame`（目前只有 handshake | response，无推送帧）、`server/connection-session.ts`（串行出站写入 `serial-outbound-writer.ts` 是推送的落点）、`server/host-kernel.ts` 的连接生命周期。
2. **读 daemon 事件语义（要移植的东西）**：`src/daemon/service.ts` 的 `replayEvents`/`subscribe` 接口、`src/daemon/workspace-runtime-service.ts` 的 durable ledger 回放（cursor、high-watermark、`MAX_REPLAY_*` 分页常量、96KB 帧预算）、客户端侧去重参考 `packages/protocol/src/runtime-buffer.ts`（RuntimeNotificationBuffer）。
3. **参考 maka-agent 对应实现**（参考架构，D:\work\maka-agent）：`packages/runtime-host/src/protocol/` 的订阅/事件帧设计 + `server/execution-composition.ts` 的 `SessionContinuityService`（subscription.open/close 操作与推送通道的装配方式）。pico 裁剪版 operation-dispatcher.ts 已保留 `SessionContinuityOperationKey`（subscription.open/subscription.close/session.transcript.query）类型面作占位。
4. **设计要点**：Host→Client 帧（event/订阅确认/背压）加进 HostFrame union；composition 需要新增事件源注入点（当前 RuntimeHostComposition 只有 handlers，可能要加 `subscribePush`/`replay` 能力面）；96KB 帧限制下 replay 分页粒度重设计（daemon 现按字节预算打包，见 workspace-runtime-service.ts 的 MAX_REPLAY_EVENTS_BYTES）。
5. **每步对抗审查 + 集成测试 + e2e**；改 runtime-host src 后必须 `npm run build:runtime-host`（pretest 已自动带）。
6. 顺手项：错误码映射语义在此统一（见上"剩余"）。

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
