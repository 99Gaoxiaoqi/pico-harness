# Maka 原子记忆核验与 Pico 任务拆分

状态：核验与任务拆分完成；实现任务均未开始。本文件不授权删除旧数据，也不代表新增能力已经实现。

## 1. 核验基线与结论

- Maka：`/Users/anxuan/workspace/研究/maka-agent`，commit `c4eacc19c6e26bebd270f7a1cd3a81017c0fe5c9`，核验时工作区干净。
- Pico：commit `f7fd6e69ed2bd53228110f59b35331a25cf7f2a6`，并读取当前工作区实现；存在用户正在修改的 Graph、协议、宿主和测试文件。
- 核验方法：追踪生产调用链、全仓符号引用及既有测试断言。没有运行 Maka 测试、构建或真实模型；测试位置是证据索引，不是本轮通过记录。
- 本结论针对上述本地源码快照，不宣称是远端或已安装应用的最新版本。

结论：Maka 已实现原子记忆的提取、直接提交、版本化存储与按覆盖范围恢复；尚未接通新 SQLite 记忆的模型召回和产品管理。上一轮设计混入了 Pico 补齐能力，不能整体称为 Maka 现成实现。

## 2. 逐项核验

以下 Maka 链接均指向上述 commit 的本地文件。

| 编号 | 已核实行为                                                                                                                                                                                                                                                                 | 实现与既有测试证据                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01  | `memory_remember` 严格无参，`exclusive_step`，同步等待 commit 后返回保存内容。exclusive 约束同一 assistant step 的工具准入，不等于 Session 存储锁。                                                                                                                        | [工具](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/memory-extraction.ts:292)；[Host foreground lane](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/server/memory-extraction-coordinator.ts:123)；[工具结果测试](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/__tests__/ai-sdk-backend.test.ts:755)                                                                                                           |
| F02  | `memory_extract` 只置位并返回 accepted；成功 complete 事件被消费、持久化之后派发后台执行。abort/error 不经过该成功分支。                                                                                                                                                   | [派发](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/ai-sdk-turn.ts:2542)；[terminal 边界测试](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/__tests__/ai-sdk-backend.test.ts:929)                                                                                                                                                                                                                                                  |
| F03  | compaction checkpoint 持久化后触发提取，不等待本轮 terminal。冻结 checkpoint/boundary recipe，进入 lane 后重建该范围文本。                                                                                                                                                 | [压缩接线](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/ai-sdk-compaction.ts:1175)；[snapshot](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/ai-sdk-turn.ts:768)；[边界测试](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/__tests__/memory-extraction.test.ts:43)                                                                                                                                                  |
| F04  | 正式证据只取稳定、用户 authored 且 Provider 实际可见的文本；引文需满足长度与 substring 校验。助手文字只可辅助解释，工具、thinking、附件和 quote 等不能直接作为正式证据。                                                                                                   | [证据投影](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/memory-extraction-evidence.ts:101)；[admission](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/memory-extraction-proposal.ts:321)                                                                                                                                                                                                                                           |
| F05  | proposal admission 后，独立模型进行 canonicalization，再次 admission，直接 commit。canonicalizer 输入为原引文、时间及可选指代解释，不接收 proposal 的 content/keys/scope 或整个源会话。没有人工审批队列。                                                                  | [规范化与提交](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/memory-extraction.ts:992)；[独立调用](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/server/execution-model-authority.ts:180)                                                                                                                                                                                                                                      |
| F06  | global/workspace 由规范化模型选择，程序验证枚举并将 workspace key 绑定来源工作区。没有“显式记住自动 global”或按 kind 硬编码作用域的规则。                                                                                                                                  | [scope admission](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/memory-extraction-proposal.ts:349)；[模型选择 global 测试](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/__tests__/memory-extraction.test.ts:362)                                                                                                                                                                                                                   |
| F07  | 原子库位于认证的 interactive StorageRoot 下 `memory.sqlite`，与旧 memory bundle 并存。默认 macOS root 可被配置覆盖，不等于 cwd。                                                                                                                                           | [打开库](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/long-term-memory-store.ts:65)；[两个存储并行装配](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/storage-writer-composition.ts:150)                                                                                                                                                                                                                                           |
| F08  | Item/keys/sources、cursor、operation 和 extraction receipt 同事务提交；operation ID + 请求 hash 幂等；cursor 与更新使用 CAS。相同内容可作为独立断言多次创建，contentHash 不是唯一键，也没有自动语义合并。                                                                  | [事务](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/sqlite-long-term-memory-store.ts:341)；[允许重复断言](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/__tests__/sqlite-long-term-memory-store.test.ts:419)；[原子提交/重放/回滚测试](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/__tests__/sqlite-long-term-memory-store.test.ts:1137)                                                                          |
| F09  | 后台 lane 和去重 Map 都在进程内，无独立 durable job/启动恢复扫描。foreground 越过排队 background，不能抢占运行中的任务；Session retirement 使用同一个 lane。                                                                                                               | [Host 后台状态](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/server/memory-extraction-coordinator.ts:52)；[lane](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/server/memory-extraction-session-lane.ts:36)；[排队测试](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/__tests__/memory-extraction-session-lane.test.ts:26)                                                                           |
| F10  | 恢复发生在下一次记忆 trigger：先处理 pending failure、未处理 checkpoint，再处理 tail。首次 counted failure 不推进 cursor；下一不同 trigger 对原范围再失败则原子 discard 并推进。相同 operation 重放不耗重试。无 cursor 默认从 0 开始，只有特定旧 checkpoint 可 bootstrap。 | [engine 恢复与 bootstrap](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/memory-extraction.ts:392)；[失败持久化](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/sqlite-long-term-memory-store.ts:688)；[一次后续重试测试](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/__tests__/sqlite-long-term-memory-store.test.ts:1247)                                                                                          |
| F11  | 每个 coverage range 最多 3 次模型调用，proposal/localized/canonicalize 共享；不是整个 trigger 最多 3 次。恢复旧范围、拆分超长范围及新 tail 都可能增加总调用数。还有证据尺寸和每调用超时限制。                                                                              | [range 预算](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/memory-extraction.ts:818)；[证据预算](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/memory-extraction-evidence.ts:43)；[旧范围重试后处理 tail](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/__tests__/memory-extraction-coordinator.test.ts:1482)                                                                                                   |
| F12  | Provider 支持有明确限制：native OpenAI Responses 的触发工具返回 unsupported、自动 compaction 提取禁用；活跃 provider-native tools 在 transport 前被拒。模型调用与 commit 前重查策略。                                                                                      | [工具 unsupported](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/ai-sdk-backend.ts:397)；[compaction gate](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/ai-sdk-turn.ts:775)；[transport gate](/Users/anxuan/workspace/研究/maka-agent/packages/runtime/src/tool-free-model-call.ts:68)；[策略变更测试](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/__tests__/memory-extraction-coordinator.test.ts:244)      |
| F13  | SQLite 已有 exact/prefix keys 查询，生产 runtime 没有消费者。实际 prompt 路径读取独立 `MEMORY.md`；没有发现两者导入/导出桥接。旧读取默认关闭，开启后注入 active entries，最多 12,000 UTF-16 code units。                                                                   | [两路 composition](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/server/execution-composition.ts:693)；[实际 prompt reader](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/server/memory-coordinator.ts:162)；[keys 查询](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/sqlite-long-term-memory-store.ts:1179)；[默认策略](/Users/anxuan/workspace/研究/maka-agent/packages/core/src/runtime-policy.ts:253) |
| F14  | 原子生命周期只有 active/archived，底层支持 update/archive/restore，没有原子记忆永久 forget 产品闭环。Session 删除不级联删除已写入的 Item；这是独立库、外键与删除调用链共同支持的源码结论，未找到专门端到端测试。                                                           | [生命周期契约](/Users/anxuan/workspace/研究/maka-agent/packages/core/src/long-term-memory.ts:47)；[仅指向 Item 的 FK](/Users/anxuan/workspace/研究/maka-agent/packages/storage/src/sqlite-long-term-memory-schema.ts:92)；[Session 清理](/Users/anxuan/workspace/研究/maka-agent/packages/runtime-host/src/server/session-retirement-coordinator.ts:724)                                                                                                          |

### 对上一版设计的修正

1. “持久化后台请求、启动自动恢复”不是 Maka 已有能力；Maka 持久化 cursor/receipt/failure/checkpoint，普通 extract 排队状态不耐久。
2. “偏好 global、仓库知识 workspace”是建议的产品规则，不是 Maka 的确定性规则。
3. “内容去重”不能与幂等混淆。复刻基线必须允许不同 operation 保存相同断言。
4. “新库自动召回、3 条/320 token、永久遗忘、Pico 旧 Fact 迁移”是 Pico 补齐。Maka 已有 extraction 预算和 SQLite schema v1→v5 迁移，不能笼统说它没有预算或迁移。
5. `$PICO_HOME/memory.sqlite` 是 Pico 对 StorageRoot 的适配建议；并非 Maka 原样使用的路径。
6. Item 的 workspace filter 是搜索范围条件，不能替代宿主授权。按 ID 的读取/修改仍须由 Pico Host 校验调用者可见范围。

## 3. 目标边界

### A：复刻 Maka 原子记忆核心

- Item 模型、检索键、来源、时间、作用域、active/archived、mutation/CAS。
- remember/extract/compaction 三入口、精确事件覆盖范围、session lane。
- 用户证据 admission、独立 canonicalization、直接提交与真实回执。
- cursor/receipt/pending failure、下一触发恢复、Provider 能力门控。
- 存储层 exact/prefix 查询；不把“有查询 API”描述成“模型已经召回”。

### B：Pico 产品闭环，明确不是照抄

- 新 SQLite 召回进入本轮 prompt，复用 Pico 的低信任参考与现有召回预算。
- Item 管理界面、宿主作用域授权、永久遗忘及旧证据防复活。
- 旧 Fact/Proposal/settings/forget 抑制信息的保全和一次性切换。
- 将上述能力接入现有 Desktop/CLI，统一正式读写路径。

A 完成可验收“原子提取与写入对齐 Maka”；Pico 正式替换旧记忆体系必须同时完成 B 与切换验收，避免暂时丢失召回、遗忘或用户数据。

### 不默认纳入

- durable 后台任务队列与启动主动恢复（O1，可另立任务）。
- 基于类型的确定性 global 策略（O2，可另立任务）。
- 向量检索、语义合并、自动矛盾裁决、自动 TTL、增加模型可调用的 memory_search/forget 工具。
- 复制 Maka 旧 MEMORY.md/PENDING.md 管理体系。
- 重写 Session、Provider 或 Graph 架构。

## 4. 任务卡

所有任务状态均为“未开始”。文件位置为拟定所有权；新增文件名在 T0 冻结，之后子任务不自行修改公共接口。

### T0 · 冻结契约、状态根与适配规则

- 类型：主代理串行前置。
- 产物：MemoryItem、mutation、coverage、cursor、receipt、failure、gate、recall 与管理端口；Provider 支持矩阵；Pico 事件 sequence 到记忆覆盖序号的映射。
- 所有权：`src/memory/atomic/contracts.ts`（新）、`src/paths/pico-paths.ts`、`packages/protocol/src/runtime.ts` 中新的记忆契约及相关 codec；共享入口由主代理持有。
- 冻结规则：使用宿主 `PICO_HOME` 作为新库隔离根；workspace 标识只由 Host 派生。跨 workspace 的 cursor/source 身份不可假设 sessionId 天然全局唯一。覆盖序号明确对应 canonical events，不使用裁剪后的消息数组下标。
- source snapshot 需区分 remember 的调用前边界、extract 的成功完成边界、compaction 的 checkpoint recipe。Maka 的 source prefix/provider options 复用约束必须纳入接口。
- 新库缺失与旧库存在要进入明确切换状态，不能悄悄开启全历史再提取。该首次启用/迁移门控是 Pico 适配，不冒称 Maka 的默认 cursor 行为。
- 验收：类型/协议检查通过，关键消息 round-trip 集成验证可运行；T1/T2 能各自基于冻结端口开发。
- 依赖：无。

### T1 · 原子 SQLite 存储

- 类型：A；存储子任务，可与 T2 并行。
- 所有权：新增独立 long-term-memory schema、`src/storage/sqlite/sqlite-memory-item-store.ts` 及其专属集成测试。不修改旧 `memory-scope.ts` 或删除旧表。
- 实现：Item/keys/sources、operations、cursor、receipt、pending failure、compaction policy denial；严格 schema、BEGIN IMMEDIATE、请求 hash、版本 CAS、archive/restore、exact/prefix 查询。
- 保证：条目/键/来源/游标/回执原子提交；同操作幂等、异载荷拒绝；不同操作允许相同内容；中途失败不留半批记录。
- 验收：一组存储集成测试覆盖 commit/reopen/replay、写边界失败回滚、两连接 CAS、workspace 查询过滤；验证 pending 重试与 discarded receipt 的原子性。
- 依赖：T0。

### T2 · 证据与提取引擎

- 类型：A；引擎子任务，可与 T1 并行。
- 所有权：`src/memory/atomic/` 下 evidence、proposal、canonicalization、extraction 文件及专属测试；不修改 T0 的 contracts。
- 实现：有界用户证据投影、精确引文校验、一次指代定位搜索、独立 canonicalization、二次 admission、直接 commit。
- 对齐：每 coverage range 最多 3 次模型调用；相同 operation 不重试；下一 trigger 恢复旧失败范围、第二次失败 discard 后处理 tail；保留 bootstrap 的特殊条件。
- source 引用必须来自 canonical events，不能让模型自造来源；敏感 requested batch 的 deterministic no-op 与 blocked/counted failure 分开。
- 验收：通过真实调用链的确定性集成夹具验证有效提取、伪造引文拒绝、规范化调用上下文隔离、range 预算及 pending 恢复；真实模型效果由 T7 验收。
- 依赖：T0。可用冻结的测试端口独立开发，T3 再与真实 T1 集成。

### T3 · 三种触发与宿主生命周期接线

- 类型：A；主代理集成任务，串行修改公共调用链。
- 所有权：`src/memory/memory-trigger-tools.ts`、新的 session memory lane/Host coordinator、`src/runtime/agent-runtime.ts`、`src/runtime/runtime-run-executor.ts`、`src/engine/loop.ts` 的 checkpoint hook、相关 Host composition。
- 实现：remember 真同步提交、同 step exclusive 准入；extract 仅在成功完成持久化后派发；checkpoint 成功后后台提取。foreground 只越过排队 background，不抢占运行者。
- 策略：映射 Pico Provider 实际能力，unsupported 必须无模型/存储副作用；保留 Pico 信任、隔离运行和权限边界，调用前及提交前重查；retirement 与 extraction 串行协调。
- 恢复：照搬下一记忆 trigger 恢复，不引入全 Session 扫描或 durable jobs。停止旧恢复扫描的正式接线在 T6 完成。
- 验收：集成测试证明 remember 返回时 item 已存在；取消/失败轮次不派发 extract；checkpoint 边界不泄漏后续事件；三个入口重叠不重复消费覆盖范围；Provider gate 不发起请求。
- 依赖：T1、T2。

### T4 · SQLite 召回适配

- 类型：B，Pico 增补；可与 T5 并行。
- 所有权：`src/memory/context-builder.ts` 或 T0 冻结的新 recall builder、专属集成测试；不修改 `agent-runtime.ts`，正式注入由 T6 接入。
- 实现：当前问题生成查询词，查询 global + 当前 workspace 的 active Items，排序后按条数/token 裁剪并输出低信任参考；初版保留 Pico 3 条/320 token 上限并明确包装文本计入预算。
- 不做：不把 scope 搜索当授权，不引入向量，不默认开放模型记忆搜索工具。
- 验收：新 Session 可召回已写记忆；另一个 workspace 的局部条目不出现；归档、开关、总预算和 XML escaping 生效。
- 依赖：T0、T1；可在 T3 进行期间独立开发。

### T5 · Item 管理与遗忘

- 类型：B，Pico 增补；可与 T4 并行。T1 完成后由同一存储所有者负责需要的存储扩展，禁止与 T1 同时写 store/schema。
- 所有权：Item 管理/遗忘存储扩展、`src/daemon/desktop-memory-service.ts`、memory request handlers、`apps/desktop/src/renderer/MemoryPage.tsx` 及该功能状态模块；共享 renderer/Host 入口修改交给 T6。
- 实现：列表、详情、编辑、来源、global/workspace 授权、归档/恢复；用已保存 Item 界面替换 pending 审批体验。
- 遗忘：清除正文、keys、包含正文的 receipt/缓存等当前副本；保留无正文抑制记录，旧范围重试/重建不能复活。归档只停止召回，不能宣称等同永久遗忘。
- 明确边界：不删除原始 RuntimeEvent 对话；备份处理范围、旧 receipt 重放后的已遗忘结果需在契约中可解释，不能重新返回被遗忘正文。
- 验收：编辑 CAS/越权按 ID 访问被拒；归档恢复生效；遗忘后 list/search/receipt/retry 都不回流正文，UI 能准确显示保存结果。
- 依赖：T0、T1；与 T3 的公共接线在 T6 汇合。

### T6 · 旧数据保全、切换与退役

- 类型：Pico 专属迁移/集成，主代理串行。
- 所有权：旧 `src/memory/proposal-*`、worker/scheduler/recovery/command 的退役；`src/storage/sqlite/memory-scope.ts` 与 workspace scopes 的兼容处理；Desktop/CLI/shared runtime 接线；迁移工具与架构文档。
- 先生成只读 inventory/dry-run：按 workspace 统计 active/disabled/archived/forgotten Fact、pending Proposal、settings 和来源可用性；备份包含 WAL 一致性，不读取后直接重置生产库。
- 已确认 Fact 迁移并保留原作用域和状态；pending 不能自动升为 active，需单独保全并在报告中展示；forgotten 只迁移无正文抑制信息。manual Fact 缺少原事件时不能伪造 RuntimeEvent，引入明确的迁移来源标识。
- 切换前验证数量、标识/正文摘要、来源与幂等；生产路径改为新库单一读取和写入。旧库不作为隐式 fallback，也不未经授权删除。
- 关闭旧“所有完成轮次恢复扫描”和 Proposal 审核接口，更新 `/memory` 与桌面设置语义；不会把旧库保全副本重新注入模型。
- 回退：切换前可保留旧正式路径；切换后若新库已有写入，必须先保全并处理增量，不能靠直接恢复旧备份丢弃新记忆。真实迁移/清理在执行任务时按实际授权处理。
- 验收：副本迁移演练可重复执行、不重复导入；pending/forgotten 不变 active；最终正式写链路只有一个；现有用户修改不被覆盖。
- 依赖：T3、T4、T5。

### T7 · 最终集成与真实模型验收

- 类型：主代理交付。
- 所有权：最终相关集成/E2E 测试及本任务文档的结果记录，不顺手处理无关问题。
- 确定性验收：事务/并发/精确边界/策略变化/重启回执/迁移/遗忘；使用最终代码状态运行相关测试、root 与 Desktop typecheck、构建及项目要求的架构检查。
- 真实模型验收：在 `tests/e2e/` 验证用户记住后返回真实保存内容；新 Session 召回；后台提取与 compaction 用户证据不丢；含未支持 Provider 时准确 unavailable。
- 最终场景：记住 → durable receipt → 重启/新 Session → 召回 → 遗忘 → 旧证据重试无复活。一次 focused 场景组覆盖关键失败，不以全量测试或反复评审替代明确断言。
- 记录：实际命令、Provider、通过/失败/跳过与限制；未运行不能写为通过。
- 依赖：T6。

## 5. 并行与合并顺序

```text
T0 契约
 ├─ T1 存储 ─┬─ T4 召回 ───────────┐
 │           └─ T5 管理/遗忘 ──────┤
 └─ T2 引擎 ─┐                     │
       T1 ───┴─ T3 Runtime 接线 ───┤
                                  └─ T6 迁移/切换 → T7 最终验收
```

- T1/T2 并行收益明确：实现目录、测试文件、写入所有权分离。
- T4/T5 可并行；T5 扩展存储必须晚于 T1 完成。公共协议在 T0 冻结，后续变更统一由主代理串行调整。
- T3 和 T6 持有 `agent-runtime.ts`、executor、engine checkpoint hook、`production-host.ts`、公共 protocol/renderer 入口的最终修改权；子代理不得各自改这些文件。
- 当前 `packages/protocol/src/runtime.ts`、`src/daemon/production-host.ts`、renderer `App.tsx` 等有用户修改。实施前重新检查状态、确定已包含这些修改的集成基线，不自动 stash/暂存/提交这些修改。
- 本轮仅只读子代理核验，无需 worktree。后续并行代码任务按 AGENTS 使用独立 worktree/唯一任务分支；子代理只提交推送自己的分支，主代理在干净集成分支验证后串行更新目标分支。
- “拆分任务”在此落实为任务卡，不自动创建侧边栏任务、外部 issue 或启动实现。

## 6. 完成标准

- [x] 固定 Maka 核验 commit，逐项给出生产源码与既有测试证据。
- [x] 纠正 durable queue、scope、dedup、budget、migration 等归属说法。
- [x] 拆分契约、存储、提取、接线、召回、管理、迁移、验收，明确依赖与文件所有权。
- [x] T0–T3：Maka 原子核心复刻完成。
- [x] T4–T5：Pico 产品闭环补齐。
- [x] T6–T7：迁移切换与最终验证完成（生产迁移入口已接通，真实用户数据未在开发验收中操作）。

记忆变更已合入 `main` 的 `66c07c13`；本文保留阶段性核验与验收记录。持续维护的生产机制见
[原子长期记忆](../architecture/14-workspace-memory.md)。

### 实现落点与验收记录（2026-09-07）

T0–T7 已在独立分支 `codex/atomic-memory-integration-20260907` 实现；基线为本地 `main` 的 `f7fd6e69`。原工作区已有 Graph 改动，未暂存、提交、覆盖或迁移这些用户改动。生产用户数据未执行迁移；测试全部使用临时数据库，正式迁移在新版本首次访问受信工作区记忆时运行。

| 任务 | 实现落点                                                                                           | 结果                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| T0   | `src/memory/atomic/contracts.ts`、`runtime-contracts.ts`、Protocol 的可选 `fact.atomic` 元数据     | 原子条目、来源、覆盖游标、回执及状态机契约落地；旧 wire envelope 用于客户端过渡                          |
| T1   | `src/storage/sqlite/sqlite-memory-item-store.ts`、`atomic-memory-schema.ts`                        | 独立 `memory.sqlite`；事务、CAS、重放、失败恢复与来源抑制                                                |
| T2   | `src/memory/atomic/extraction-*`                                                                   | 用户事件原文证据；独立 canonicalization；每覆盖段最多 3 次模型调用；下一触发重试 pending，失败后 discard |
| T3   | `src/runtime/atomic-memory-runtime.ts`、`src/memory/atomic/session-lane.ts`、Engine/Executor hooks | 同步 remember 独占工具步骤；extract 成功终态后触发；压缩落盘后触发；前台优先、不抢占已运行后台工作       |
| T4   | `src/memory/atomic/context-builder.ts`                                                             | exact/prefix 关键词与路径召回；当前 workspace + global；最多 3 条/320 token，包含低信任包装              |
| T5   | `src/daemon/desktop-atomic-memory-service.ts`、`MemoryPage.tsx`、`memory-command.ts`               | 已保存/归档、正文编辑、来源与范围展示、恢复、遗忘、开关及本地命令                                        |
| T6   | `src/memory/atomic/migration.ts`、新库迁移 marker/provenance                                       | 只读旧库；长正文按原子上限分块并保留迁移来源；pending 留在旧库；forgotten 仅迁移无正文抑制；双进程幂等   |

生产 AgentRuntime、Desktop 默认管理服务和 `/memory` 已切换为新库。旧 Proposal/Worker/Repository 留作兼容数据及隔离回归，生产不再启动旧 worker、预算扫描或终态恢复扫描；不会自动 fallback 到旧库。旧审批列表为空，审批操作明确拒绝。

范围边界：Responses Provider 不注册提取工具；不提供向量检索、模型记忆搜索/删除工具、跨操作语义去重或持久后台任务队列。归档停止召回；遗忘清除新库当前正文/keys/回执中的正文，并保留来源抑制。原始会话事件和保全的旧数据库仍存在，未宣称执行磁盘介质擦除。

已完成的确定性验证：

- 68 条相关集成测试全部通过、无跳过：`atomic-memory-*`、`desktop-atomic-memory-service`、`desktop-memory-ui`、`memory-runtime`、`compaction-rolling-digest`、`runtime-tool-result-contract`、`desktop-memory-service`。
- `npm run typecheck`、`npm run desktop:typecheck`、`npm run build` 通过。
- 本分支所有变更 TS/TSX 文件 ESLint、`git diff --check`、`node scripts/check-architecture-boundaries.mjs` 通过。
- 额外定位并修复：持久边界 turn ID 与模型内存步骤 ID 不同步；关闭记忆时压缩拒绝记录被 Host 提前返回绕过；后台计费晚于前台终态时继承运行上下文。
- 迁移验证旧库字节不变、双进程只导入一次、事务失败整体回滚；没有操作实际用户记忆库。

真实模型使用 `deepseek/deepseek-v4-flash`（OpenAI 兼容 Provider），实际设置 `RUN_LLM_E2E=1`：

- `tests/e2e/atomic-memory-behavior.real-llm.test.ts`：真实提取、助手虚构信息过滤、secret 前置拒绝通过，34.35 秒。
- `tests/e2e/memory-behavior.real-llm.test.ts` 中 `atomic production runtime remembers...`：最终计费形态下，真实 remember → 新 Session 召回 → 遗忘 → 原 Session 终态重派不复活 → 第三个 Session 无记忆回答 UNKNOWN，通过，13.09 秒。问题明确限定消费已注入记忆，不检查文件、不调用工具。
- 未运行整个真实模型测试套件，也未把旧 Proposal 质量测试的跳过视为通过。

保留失败事实：中间一次完整 Runtime 复跑出现 `remember retry_later`，未复现、根因未确证；另一次主模型在无工具时输出 DSML 伪工具调用（未执行），明确上述测试任务边界后最终场景通过。这不等于通用模型波动已修复；失败仍由 3 次调用上限、pending/discard 和 unavailable 回执控制，不会伪报保存成功。测试已增加仅针对合成 canary 的辅助 stage/响应诊断，不输出配置或凭证。

来源许可证：保留 Maka 源文件 Apache 头部，并在 `resources/licenses/maka/` 附完整 LICENSE/NOTICE，第三方声明记录上游 revision 和 Pico 的适配范围。

## 7. 合入 main 前的全量验证（2026-09-07）

用户要求提交、合并 main 并全面测试后，在独立集成分支完成全量回归。首次执行发现遗漏的旧记忆质量测试和基线已有失败；全部定位后修复，未跳过失败来完成合并：

- 保留记忆质量测试的跨会话/跨工作区隔离、独立开关、后台不阻塞、失败隔离、独立计费场景，迁移到原子记忆生产接口。
- 修复既有 Provider 显式 `false` 被官方默认值覆盖，以及 Claude SDK 在 `toolChoice:none` 时删除工具导致缓存前缀丢失；补齐严格 SDK 所需 fixture。
- 用量接口沿用旧 64KB 返回限制，无法容纳当前价格目录，调整为已有 Runtime 总结果上限，并保留超限拒绝回归。
- 更新桌面重构、Graph fake、TUI 状态栏的过时测试；为基准包补齐已引入的 SDK 依赖锁并重新校验摘要。生成价格文件保持确定性 JSON 格式，生成器同步声明格式保留。

最终生产代码 `99202537` 的验证结果：

| 检查                                       | 结果                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| `npm run test:integration`                 | 1580 项：1568 通过、0 失败、12 项按平台条件跳过；206 秒 |
| 原子记忆真实提取 E2E                       | 1 通过，8.7 秒                                          |
| 生产记住 → 跨会话召回 → 遗忘不复活 E2E     | 1 通过，14.8 秒                                         |
| Runtime 与 Desktop typecheck               | 通过                                                    |
| 全库 ESLint / 架构检查 / Prettier          | 通过                                                    |
| 构建 / `npm pack --dry-run` / 沙箱资源清单 | 通过                                                    |
| `npm audit --audit-level=low`              | 0 个漏洞                                                |
| 更新后基准锁的实际 `npm ci`                | 通过，89 个依赖包                                       |

验证运行于 macOS / Node 26；未在本机执行 Linux、Windows 专属测试，也未运行其他功能的全部真实模型套件。原主工作区的未提交 Graph 修改独立保全，三方预检查无文本冲突，不纳入本次提交。合并采用快进，不重写共享历史。
