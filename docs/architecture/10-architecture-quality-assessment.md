# Pico Harness 架构质量评估与修整路线

> 评估日期：2026-07-19
> 评估范围：`src/`、`packages/protocol/`、`apps/desktop/` 及 `tests/integration/`
> 评分口径：只把已经通过验证的实现计入当前分数；工作区中尚未完成验证的改动不提前加分。

## 结论先行

当前架构已经具备清晰的事实源、Runtime 宿主和产品壳边界；受控跨域依赖已经达到 strict 通过。几个高变更密度控制面仍会继续演进，但它们已经通过窄输入/输出、明确生命周期和集成契约测试隔离，不能再视为未模块化或不可测试。

当前验证状态如下（针对本轮定义的 CLI/TUI、Runtime、Session、Desktop parity 和受限插件范围）：

| 维度                    | 当前状态          | 已有基础                                                                                                                                                                                                                                                                        | 边界与后续说明                                                        |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 分层（Layering）        | strict 门禁通过   | `AgentRuntime` 作为 Composition Root；`packages/protocol` 隔离 Desktop IPC；durable EventStore 位于中立 storage 层；`AgentEngine`、`Session`、`SessionForkService` 均通过 engine-owned port 或 storage contract 访问 Runtime                                                    | strict 架构门禁已通过；后续新增逆依赖由默认门禁阻断                   |
| 模块化（Modularity）    | 核心 owner 已收敛 | 已抽出 `RuntimeRunExecutor`、`RuntimeProviderAssembly`、`RuntimeCleanupScope`、`SessionMessageLedger`、`SessionManager`、`DesktopRequestRouter`、workspace/session/provider handler、`DesktopResourceCatalog` 和 neutral durable storage；Composition Root 仍独占装配与生命周期 | 控制面仍有高变更密度；后续只按窄输入/输出或独立生命周期继续拆分       |
| 可测试性（Testability） | 核心契约有回归    | `LLMProvider`、`Registry`、`SessionRuntime`、`PluginRuntimeSnapshot`、`EngineRuntimePort` 等窄接口；集成回归覆盖 Provider stream/usage、Runtime assembly/run/close、Session 恢复与并发、Desktop protocol/parity、插件 trust/scope/capability/diagnostics 和 strict gate         | 更广泛的跨实现矩阵可继续扩充；最终状态必须以完整门禁结果为准          |
| 插件化（Pluginization） | 受限能力闭环      | `PluginManager → PluginManagementService → PluginRuntimeSnapshot`；资源、Hook、MCP、LSP 与 data-only capability 共用不可变快照，受限 Provider 装饰/Tool 激活、managed scope root、winner、fingerprint、Hook authority、Desktop catalog/execute registry 和稳定诊断均有契约测试  | 公开 marketplace 与任意插件代码执行仍未开放，这是安全边界而非未完成项 |

这不是成熟度百分比，也不要求所有文件变小。它只记录已有证据、已知边界和继续治理条件，避免用主观满分掩盖控制面的维护压力。

## 事实与边界

### 当前的分层骨架

```text
TUI / Desktop Renderer
        │  产品壳与协议投影
        ▼
Desktop daemon / CLI host
        │  Composition Root
        ▼
AgentRuntime
        │
        ├─ AgentEngine / Session / Reporter
        ├─ Provider / Context / Tools / Approval / Hooks / MCP
        └─ storage/RuntimeEventStore（Agent 事实）

RuntimeStore（Jobs、runs、leases、usage）是独立控制面，不替代 RuntimeEventStore。
```

这条主线与 [`00-overview.md`](./00-overview.md) 和 [`desktop-architecture.md`](../desktop-architecture.md) 一致。`Session`、TUI Transcript 和 Desktop ViewModel 都是可重建投影，不应成为第二事实源。

### 已验证的窄边界

- `src/runtime/runtime-contract.ts` 集中 Runtime host 与执行结果的公开类型，减少 `AgentRuntime` 与执行器之间的类型反向依赖；`src/engine/runtime-port.ts` 将 Engine 对 RuntimeRun 的生命周期访问收敛为 engine-owned port，具体实现只在 `src/runtime/engine-runtime-port-adapter.ts`。
- `src/runtime/runtime-run-executor.ts` 只处理已经装配好的 `Session`、`SessionRuntime`、`AgentEngine` 一次运行；不拥有 Provider、MCP、Plugin 或 Session 的清理职责。`src/runtime/runtime-cleanup.ts` 只拥有本轮 disposer 的顺序、幂等和失败隔离，不拥有资源本身。
- `src/runtime/runtime-assembly.ts` 只负责 Provider 注入、CostTracker 包装和凭证轮换；不拥有 Provider 或 Session 的外部生命周期。
- `src/provider/model-runtime-config-contract.ts` 将 effective config/user store/parser 收敛为只读窄契约；Provider 层不再 value-import Input 层实现。
- `src/engine/session-message-ledger.ts` 只维护消息顺序和派生内存状态，不写 durable store。
- `src/engine/session-manager.ts` 只管理进程内 Session 实例、LRU/TTL、pin、单一 manager owner 和 drain；`getOrCreatePinned()` 在 recover 发布前预留 pin，并由 AgentRuntime/TUI/Desktop/SessionRuntime 显式交接 lease。`Session` 仍拥有 RuntimeEventStore、rewind、FileHistory 和 close 生命周期。
- `SessionRuntime.dispose()`、workspace per-key release fence 和可重试 `OwnerLease.release()` 共同保证资源释放失败不会遗留可并发发布的新 owner 或永久不可验证的租约目录；关闭路径均有失败与重入回归。
- `src/daemon/desktop-resource-catalog.ts` 将 Desktop 的 Agent/Skill 查询收敛为资源目录边界。
- `src/daemon/desktop-request-router.ts` 只负责 typed method handler 注册、fallback 和统一未知方法错误；workspace/session handler 已由 `src/daemon/desktop-session-request-handlers.ts` 按领域装配，Desktop service 仍拥有状态和生命周期。
- `scripts/check-architecture-boundaries.mjs` 扫描跨域 import（包括 Engine→Runtime 的 type-only import）；`scripts/architecture-boundaries-baseline.json` 已清空，默认门禁与 `--strict` 均通过。RuntimeEventStore 与 Runtime event codec 已下沉到中立 `src/storage/`，Runtime 目录仅保留兼容导出。
- `src/plugins/plugin-hook-trust.ts` 将 materialized plugin Hook 与插件 ID、资源 digest、host-private root 绑定，dispose 后 fail-closed；`src/plugins/plugin-capability.ts` 只允许 host-owned 的 data-only descriptor 与 Provider 装饰/Tool 激活，未知或未激活 capability fail-closed；`src/plugins/plugin-scope.ts` 固化 managed scope root、global user registry、winner 和 realpath 边界；`docs/architecture/plugin-scope-contract.md` 记录物理根与兼容迁移。
- `src/plugins/plugin-diagnostics.ts` 将 resolver、scope、materialization 和 runtime failure 归一为稳定记录；CLI/TUI `/plugin inspect` 与 Desktop `diagnostics.resources` 均消费同一诊断语义。
- Runtime capability 在签发时使用 Session `#private` brand 拒绝伪 owner，并校验真实 Session 实际拥有的 durable authority；Session 序列化子任务使用独立 active context 和共享 drain set，父任务先 seal 再释放队列。Fork 的已持久化 start/checkpoint/state/terminal 冲突统一进入 `needs_attention`。
- Desktop 的 live buffer 在压力下优先保留 durable 和 terminal 事件，截断状态跨 drain 传播；durable/live thinking 以 Runtime `runId + turnId` 合并，不用内容猜测轮次；tool transcript 按 `providerCallId` 和 sequence 匹配最近前驱调用，ToolResult 与消息轮次对齐；MCP 关闭失败会显式投影 failed/zero-tools，不留下可调用的幽灵桥接。
- `src/provider/interface.ts` 的 `LLMProvider` 和 `src/tools/registry.ts` 的 `Registry` 已经可以作为 Provider/Tool 适配器的测试替身。

### 当前仍然过重的控制面

以下数字是 2026-07-18 的工作区快照，用来定位职责密度，不作为机械拆文件指标：

| 控制面                                  |    规模快照 | 同时承担的职责                                                                    |
| --------------------------------------- | ----------: | --------------------------------------------------------------------------------- |
| `src/runtime/agent-runtime.ts`          | 约 1,824 行 | 配置解析、Provider/Tool/Hook/MCP/Plugin/LSP/子代理装配、Session 选择、执行和清理  |
| `src/engine/loop.ts`                    | 约 3,053 行 | ReAct 循环、重试、上下文压缩、工具批次、子代理、预算和 steer                      |
| `src/daemon/desktop-runtime-service.ts` | 约 3,766 行 | IPC dispatch、workspace/session、资源目录、provider、jobs、rewind、变更审阅和关闭 |
| `src/tui/repl.tsx`                      | 约 3,067 行 | 输入、命令、焦点、Transcript 投影、运行状态和 UI 生命周期                         |
| `packages/protocol/src/runtime.ts`      | 约 2,153 行 | 请求/响应 schema、方法白名单、协议兼容和校验                                      |
| `apps/desktop/src/renderer/runtime.ts`  | 约 2,215 行 | renderer store、IPC 调用、运行状态、消息和资源投影                                |

下一轮应按“独立输入/输出或明确生命周期”拆分这些控制面，而不是按行数切片或引入通用 DI 容器。

## 四个维度的证据与后续治理

### 1. 分层：strict 门禁通过

**已有证据**

- CLI/TUI 与 Desktop 共用 `AgentRuntime`、Provider、Tool Registry、Session 和 durable transcript 语义；Desktop Renderer 只通过 Electron Main/Preload 和本机 daemon 通信。
- `packages/protocol` 是 Desktop 的方法、schema 和白名单边界，不直接依赖 Runtime 实现。
- `RuntimeEventStore` 负责 Agent 事实，`RuntimeStore` 负责 Job/run/lease/usage 控制面；这两个 owner 在 [`00-overview.md`](./00-overview.md) 中有明确声明。
- `src/runtime/runtime-contract.ts` 让 Runtime host 依赖契约，而不是把运行结果类型散落在 Composition Root 中。

**剩余债务**

- Provider 配置解析和操作日志已改为窄 contract/parser 注入；Session 的 RuntimeRun 生命周期、外部提交和 durable facts 已经通过 engine-owned port/storage contract 收敛。
- `src/input/cron-daemon-bridge.ts`、`src/provider/effective-model-runtime.ts`、`src/context/compactor.ts`、`src/engine/loop.ts` 等路径仍有进一步收敛空间，但不构成当前受控逆依赖。
- strict 门禁已清空 baseline；后续任何跨域实现依赖必须先增加窄 contract 并由默认门禁拦截回归。

### 2. 模块化：核心 owner 已收敛

**已有证据**

- Runtime 执行、Session 消息账本、Session 实例治理、Desktop 资源目录已经有窄边界，且没有复制 durable writer。
- `Session` 保留聚合根是有意设计：owner lease、rewind、FileHistory、写队列和 close 必须在同一一致性边界内，不应为了缩短文件制造第二个 Session owner。

**后续治理（不扣分）**

- `AgentRuntime` 仍是高变更密度的 Composition Root；后续应把“纯配置解析”“能力装配生命周期”“一次运行执行”继续保持为三个可测试边界，而不是把参数原样转发到另一个大对象。
- `AgentEngine` 的循环代码同时知道 Context、Provider、工具调度、子代理和预算。可按 `ContextPipeline`、`ToolCallExecutor`、`SubagentRunner` 等窄输入输出协作者拆分，前提是 Engine 仍保留循环时序 owner。
- `DesktopRuntimeService` 仍在一个控制面内装配 workspace、session、provider、job、rewind 和 change review；请求 method→handler 路由已抽到 `DesktopRequestRouter`，workspace/session/provider handler 已按领域拆出，其余领域可继续沿用同一模式，每个 handler 只能持有自己的资源 owner。
- Desktop renderer 和 `packages/protocol/src/runtime.ts` 也需要以协议/状态投影为边界，而不是把 daemon 的内部服务搬进 renderer。

### 3. 可测试性：核心契约有回归

**已有证据**

- `tests/integration/` 已覆盖 durable transcript、Markdown 行模型、Session ledger/manager、RuntimeRun、Desktop transcript/plugin parity、Hook trust、安全和生命周期竞态。
- Runtime 恢复测试明确覆盖 active projection 内的 tool call/result 匹配，以及已完成 run 通过独立 recovery run 修复的终态顺序；Markdown 测试除 render/clip 一致性外，也断言列表和引用在常规及极窄宽度下不丢正文字符。
- `LLMProvider`、`Registry`、`SessionRuntime` 等接口允许 fake provider、fake registry 和确定性 SessionRuntime 注入；Provider 还支持 reasoning delta、abort signal 和 retry 判定等可观察契约。
- `PluginRuntimeSnapshotRegistry` 将同一 canonical workspace 的快照缓存、并发去重和 dispose 集中到一个可测试 owner；全量清理后聚合上报失败。TUI 首个 bundle 失败也进入同一 Plugin/TaskHost/Cron/MCP 释放边界。
- `diagnostics.resources` 现在返回 `pluginDiagnostics`，插件配置失败不会再静默表现为资源不存在。
- `tests/integration/architecture-boundaries.test.ts` 直接执行架构门禁，防止只在文档中宣称边界。

**后续治理（不扣分）**

- `AgentRuntime` 和 `DesktopRuntimeService` 仍有较多隐藏的文件系统、凭证、时间、IPC 和生命周期依赖；测试它们通常需要完整宿主，而不是传入几个小接口。
- 跨实现契约矩阵仍可按新增实现继续扩展；当前已覆盖 Provider（stream/usage/abort 边界）、Runtime/Session（事件顺序、恢复、close/drain）、Plugin Snapshot（trust/fingerprint/dispose）和 Desktop protocol（typed dispatch、unknown method、parity、diagnostics），核心规则不再绑定完整宿主。
- “可测试”不等于“只测 happy path”。取消、工具错误、重复恢复、插件变更和关闭竞态要有明确的失败路径，并且时间与随机 ID 应通过 host seam 控制。

### 4. 插件化：受限能力闭环

**已有证据**

- `src/plugins/plugin-manager.ts` 负责 managed scope 安装与 registry，`src/plugins/plugin-management-service.ts` 负责启用、信任和 materialize，`src/plugins/plugin-runtime-snapshot.ts` 输出 host-private 的不可变快照。
- `src/plugins/plugin-capability.ts` 把 Provider/Tool 扩展限制在显式 manifest declaration 与 host-owned factory；factory 解析结果仍是 data-only descriptor，激活函数只接收窄 Provider/Tool 契约，不接触 Runtime 私有对象，未知、版本不支持、缺少激活边界和非法返回值均 fail-closed。
- 具体 Provider/Tool 激活返回带 `dispose()` 的 lease，并由 per-run/per-session `PluginCapabilityActivationScope` 拥有；scope 在清理前同步封口、反序 all-attempt 释放，Automation/冲突检查可先读取纯 `toolNames()` 而不分配资源。
- `src/plugins/plugin-scope.ts` 统一 user/project/local 物理根、global user registry、优先级 winner、安装复制、fingerprint conflict 和 realpath 越界校验。
- 快照可以贡献 Skill、Command、Agent、Hook、MCP、LSP 和 capability；`PluginRuntimeSnapshotRegistry` 保证 Desktop 资源目录查询和会话激活复用同一个 canonical workspace 快照。
- `src/plugins/plugin-diagnostics.ts` 提供稳定跨壳诊断记录；`tests/integration/plugin-capability.test.ts`、`plugin-scope.test.ts`、`plugin-hook-trust.test.ts` 和 `desktop-plugin-parity.test.ts` 固定 declaration/factory、scope、trust/fingerprint、诊断和 dispose 语义。

**安全边界（不计入扣分）**

- 公开 marketplace、跨设备安装同步和任意 TypeScript/Provider/Tool 代码执行仍未开放；这属于明确的产品/安全边界。若未来开放，必须先扩展 capability factory、权限、沙箱和契约测试，不得让 manifest 直接携带 module path 或 executable。
- `PluginRuntimeSnapshot` 的 Hook/MCP/LSP/resource paths 仍来自 host-private materialized tree；原始 fingerprint、scope、trust 和 dispose 绑定由现有回归覆盖。

## 持续验收标准

### 分层

1. `npm run check:architecture:strict` 通过，`scripts/architecture-boundaries-baseline.json` 为空；新增逆依赖由默认门禁立即失败。
2. 每个跨域运行时依赖都通过 `src/*/contracts`、`src/*/ports` 或 `packages/protocol` 的窄契约表达；禁止为取得一个类型而导入另一域的具体服务实现。
3. Engine、Runtime、Provider、Context、Daemon、Desktop 的依赖方向在架构文档和集成测试中一致；不存在 undocumented barrel import 或循环 owner。

### 模块化

1. 每个 Composition Root 只负责装配和生命周期；执行时序、领域规则、资源查询和 IPC 路由分别由可命名、可独立测试的协作者拥有。
2. 每个拆出的协作者具有窄的输入/输出或独立 `dispose()` 生命周期；不得引入“把 20 个参数塞进 RuntimeContext”的参数转发袋。
3. 每种 durable 状态只有一个 writer/owner：Session 不新增第二个 transcript writer，Plugin snapshot 不复制持久化事实，Desktop 不自行重算 Runtime 事实。
4. `AgentEngine`、`DesktopRuntimeService` 和 `AgentRuntime` 的领域边界都有最小集成测试；文件大小不是门禁，职责和 owner 才是门禁。

### 可测试性

1. Provider、Registry、SessionRuntime、Plugin Snapshot、Desktop protocol 都有可复用 contract test；每个实现只需提供 fake clock、fake filesystem/IPC 或 adapter。
2. 成功、取消、超时、重试、工具错误、恢复重复、插件变更和 close/drain 竞态均有确定性测试；不依赖真实网络或真实模型才能验证核心规则。
3. `npm run test:integration`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run desktop:typecheck`、`npm run format` 和 `git diff --check` 在最终状态通过。
4. 关键生命周期（Session、RuntimeRun、Plugin Snapshot、Desktop service）均可重复 close，且测试能检测资源泄漏、双写和迟到事件。

### 插件化

1. 一个 canonical workspace 在 catalog、resolve、execute、Hook/MCP/LSP 装配中使用同一个不可变 `PluginRuntimeSnapshot`；trust、fingerprint、materialized tree 和 dispose 有端到端回归。
2. 插件 capability 通过显式 manifest 和受限 factory 注册；Provider 作为有序装饰器接入并在凭证轮换后重建，Tool 进入标准 Registry 安全链；两者都不导入 Runtime 私有实现，未知或冲突 capability fail-closed。
3. user/project/local scope 有独立安装根、优先级、覆盖和诊断；安装、启用、禁用、变更后快照刷新语义可测试。
4. 所有 snapshot diagnostics 都能在 CLI/TUI/Desktop 至少一个稳定诊断面展示；无效、未信任、fingerprint 变化和 source 越界不能静默降级成“找不到资源”。
5. 插件只扩展能力，不成为第二事实源；不允许逐 token、任意 UI state 或私自写入 Session/Runtime 数据库。

## 后续顺序

### P1：先把边界变成门禁

1. 保持 `scripts/architecture-boundaries-baseline.json` 为空；新增跨域实现依赖必须先落到窄 port、contract 或中立 storage 层。
2. 每次控制面拆分后运行默认与 strict 架构门禁，防止债务重新登记为永久例外。

### P1：完成 Plugin parity 的信任和诊断闭环（已完成）

1. 已明确 materialized plugin source 与原始 fingerprint 的信任映射，并覆盖 Hook 变更、重启、source escape 和 dispose 后执行测试；受限 capability factory 已接入 snapshot。
2. `PluginRuntimeSnapshot.diagnostics` 已由 Runtime 日志、TUI `/plugin inspect` 和 Desktop `diagnostics.resources` 消费，并保留稳定 code/scope/severity。
3. 已落实 user/project/local 物理根、global user registry、优先级和 managed copy；旧 workspace user 条目保留兼容读取。

### P2：拆控制面，不改变 owner

1. `DesktopRuntimeService`：先抽 request router，再抽 workspace/session、provider、job、change review handler；service 只保留生命周期和 handler 装配。
2. `AgentRuntime`：抽纯配置解析和 capability assembly；保留唯一 Composition Root、资源清理和 `RuntimeRunExecutor` 调用。
3. `AgentEngine`：在保持循环时序的前提下抽 `ContextPipeline`、`ToolCallExecutor`、`SubagentRunner`；不创建第二个预算或 Session owner。
4. 只有在协议边界清晰后，才拆 `packages/protocol/src/runtime.ts` 和 Desktop renderer store；不把 daemon 内部类暴露给 renderer。

### P2：补齐契约测试和收尾

完成四类 adapter contract test、架构文档索引、Desktop/Deployment 的插件能力说明，再执行全量验证并重新评分。任一拆分若产生参数袋、循环依赖、重复 writer 或模糊 dispose owner，应立即回退该拆分并保留现状。

## 明确不做的事

- 不引入通用 DI 容器、Service Locator、Repository 框架或万能 Runtime Context。
- 不为“看起来模块化”而按文件行数机械切分。
- 不把逐 token reasoning、spinner、原始 stdout/stderr 或 UI 状态写入 durable transcript。
- 不把 `ToolScheduler` 扩成跨 Agent 全局文件锁或第二套 OCC 协议。
- 不在没有 capability、trust、lifecycle 和 contract test 定义之前开放任意插件代码执行。

相关的 durable transcript、Markdown、RuntimeRun 和 Session 窄拆记录见 [`09-architecture-debt-remediation.md`](./09-architecture-debt-remediation.md)；当前架构事实源和模块地图见 [`00-overview.md`](./00-overview.md)。
