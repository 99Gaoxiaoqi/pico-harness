# Pico 统计取数与展示修复方案

状态：已完成实现与验证。基线：36ef70fb。以下原因记录来自修复前实机与源码排查。

## 已确认事实

Computer Use 观察的新会话共 5 次原生物理请求：4 次主请求、1 次压缩请求，均成功。输入 28,100、输出 939、缓存读取 18,489、推理 418；推理包含在输出中。累计 Token 应为 29,039。压缩前后模型历史为 6→3，重启后标记与三个约束均能回忆，说明压缩执行及持久化正常。

### 1. 顶部累计 Token 漏掉缓存输入

`apps/desktop/src/renderer/pages/ConversationPage.tsx:937` 仅相加 `usage.inputTokens + outputTokens`。前者为未缓存输入 9,611，所以显示约 1.1 万（10,550）。后端 `packages/pico-host/src/desktop-runtime-service.ts:4057` 已提供包含缓存的 `totalTokens=29,039`，前端解析后没有使用。

修复：顶部使用 `usage.totalTokens`，标签明确为“会话累计 Token”，缺失显示未知；与历史用量同口径，不把它作为上下文占用。

### 2. 当前上下文绕过真实模型历史投影

`desktop-runtime-service.ts:1536` 使用 `session.getHistory()` 原始历史。实际模型读取 `packages/runtime/src/runtime-run.ts:1210` 的投影，会消费 checkpoint 并处理归档和裁剪。当前上下文的 649 因而不是实际请求上下文。

系统提示在 `packages/runtime/src/agent-engine.ts:717` 运行时注入，工具在 `:1169` 按 step 披露与权限过滤。Inspector 未拿到它们，却把原始历史中没有 system 消息显示成系统 0，并以不完整消息量计算完整窗口占用。`desktop-runtime-service.ts:1550` 返回体未填 `compactedCount`，所以成功压缩仍显示未知。

修复：提取无副作用的共享模型历史 reader，固定事件水位，供模型执行与 Inspector 使用；不得为观察数据创建 RuntimeRun。保留 transcript 的原始历史。从真实压缩 checkpoint 返回次数、最新 checkpoint ID 和覆盖边界，排除 fork seed、hard reset 等非压缩记录。

本轮显示“当前模型历史（估算）”及消息小计；系统、工具或协议开销无法完整构造时显示未知，不展示由部分数据推导的完整占用率、剩余量。最近成功主请求仍独立展示上报 Token 与 UTF-8 语义字节。完整的下一请求预估需要共享无副作用的 prompt/tool 装配，不使用最近请求冒充当前请求，也不新建第二套估算逻辑。

### 3. 全部项目查询与项目下拉框不一致

`apps/desktop/src/renderer/usage/UsagePage.tsx:31` 首次执行 `query({})`，实际查全部项目；`UsageSettingsPage.tsx:155` 的本地选择初始来自旧的 workspace 用量，之后不随结果更新。只有一个有数据的项目时总数碰巧一致，错误提示仍来自全局。

修复：查询条件由页面单一状态管理，初始明确“全部项目”；项目、时间条件、请求响应与展示范围一致。切换中标识加载，旧响应不得覆盖新条件。诊断按实际查询范围展示，不靠前端隐藏错误。

### 4. 两个不可读项目是注册残留，不是旧会话复活

`packages/pico-host/src/desktop-runtime-service.ts:2897` 全局用量扫描注册表。两个已清空历史工作区仍注册，数据库记录 device=16777231，实际为16777234；`packages/storage/src/sqlite/sqlite-workspace-storage.ts:462` 正确拒绝身份不匹配。清空会话没有删除项目注册。

修复：本机维护时停用相关运行，核验这两个特定旧临时工作区没有会话、活动 Run、启用的定时任务或待处理任务后，精确移除注册引用，保留目录与配置。正常注销入口的活动检查也依赖能打开数据库（`desktop-runtime-service.ts:2777`），不能假设对身份失配库调用注销即可成功。若被拒绝，应在已停机、已核验的维护范围内更新注册索引，不能跳过运行时存储身份校验或自动 adopt。普通项目删除最后一个会话不得自动注销。

### 5. 生产费用未知合理，真实模型测试装配不一致

生产 host CostTracker 默认使用 `catalogPricing`（`packages/pico-host/src/cost-tracker.ts:9`），按完整 endpoint+model 查价。目录包含 `/zen/v1`，没有当前 `/zen/go/v1`，5 条事实冻结的定价为空，故 unknown。

`tests/e2e/physical-accounting.real-llm.test.ts:11` 直接使用 runtime CostTracker，未注入生产定价器；`packages/runtime/src/pricing.ts:88` 回退到仅按模型名的价格，得到不适用于当前路由的 estimated。原测试仅验证 usage 上报，未断言路由计价一致。

修复：真实模型测试复用生产装配和 billing route；有明确 endpoint 但没有定价器/匹配价格时不得使用仅模型名的兜底。费用展示区分已知估价、套餐内、未知及原因。Go 是否套餐内及覆盖范围需核实有效套餐/官方规则后，以显式计费策略传入；不得借用 Zen 单价或由 URL 名称推断免费。未核实保持 unknown。历史未知记录不按今日价格静默回填。

### 6. 缓存未上报不能显示成确定的零

5 次请求均上报缓存读取，读取量18,489 / 输入28,100 = 65.8%，这是 Token 复用率；请求命中率为100%。5 次均未上报缓存写入，界面显示写入0及覆盖0/5，容易被理解为实际零。

修复：沿用 reported coverage，写入未上报显示“未知/未上报”；部分覆盖显示“已知量 + 覆盖次数”。将65.8%明确标注“输入 Token 缓存复用率”。推理418不可再加到输出939上。

## 实施划分与顺序

1. 主代理先确定 context 报告的覆盖状态及压缩字段语义，公共协议单一所有者。
2. 子任务 A：共享历史投影、checkpoint 统计、Inspector 展示；统一所有 context 文件修改。
3. 子任务 B：顶部累计、用量筛选状态、缓存覆盖显示；不改 A 的 Inspector。
4. 子任务 C：生产计费装配和测试一致性、显式未知原因；套餐策略仅在依据明确后实现。
5. 主代理执行本机注册清理，集成各分支并完成最终验收。计划本身不执行这一步。

并行实现使用独立 worktree；公共协议和生成物由主代理串行处理。不新增逻辑计量账本、旧数据回填或双读兼容层。

## 验收标准

| 链路           | 可验证标准                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 累计用量       | 同一缓存 fixture：顶部、用量页、追踪均为29,039；输入28,100、输出939，推理不重复计数。                                                                |
| 压缩与重启     | 有效 checkpoint 后模型历史6→3，原始 transcript仍6；RPC 消息估算与共享模型历史 reader 一致，压缩次数1；重启结果不变。                                 |
| 只读观察       | 连续刷新上下文不增加 run、checkpoint、物理请求，不调用模型或工具；缺失部分不冒充0或完整窗口占用。                                                    |
| 查询范围       | 两个不同用量工作区：初始全部、切换单项目、快速往返和刷新，标签、总数、诊断始终对应最新查询。                                                         |
| 项目清理       | 两个已核验空历史项目不再被扫描；新会话及项目配置保留；另造一个真实不可读项目时，错误仍可见，不能吞掉。                                               |
| 计费与覆盖     | 同一 usage 经生产装配→SQLite→dashboard；明确价格路由 estimated、显式套餐策略 included、未知 endpoint unknown；缺失缓存写入仍未知，部分上报显示覆盖。 |
| 真实模型与桌面 | 生产装配一轮真实模型、一次压缩和重启；Computer Use 核对顶部、上下文、请求快照、用量筛选与费用原因。短历史压缩拒绝不能计为模型失败。                  |

优先扩展现有 context composition、desktop usage dashboard、catalog usage billing 集成测试，增加一条 checkpoint→RPC→Inspector 的跨重启链路；边界修改后执行相关类型检查、构建及 Electron 验证。当前排查不宣称这些修复测试已通过。

## 风险与回退

模型历史共享 reader 必须保留原有工具配对、归档和字节预算行为，避免为 UI 改变实际模型输入。费用未知不通过伪造价格消除。注册清理只影响已核验的两个空旧项目，不删除目录，必要时可显式重新注册；不修改数据库绑定。代码可独立回退；本轮不需要数据 schema 迁移。

## 实施补充

官方 [OpenCode Go 文档](https://opencode.ai/docs/go/#usage-beyond-limits) 说明启用 Use balance 后可在超额时转用 Zen 余额，不能仅凭 Go endpoint 将每次请求归类为套餐内零增量费用。本轮保持未确认请求费用为 unknown，修复生产装配一致性与具体原因展示，不修改账户计费配置或回填历史。

本机维护已完成：停掉应用和 Runtime，逐库确认两个身份失配的旧临时工作区 sessions、daemon_runs、jobs、cron_jobs、cron_runs、agent_graphs 均为空后，使用 WorkspaceRegistrationStore 精确移除两个注册项（7→5）。保留原目录、文件、数据库和绑定身份。新会话仍为1个，原有5条物理请求及1条压缩 checkpoint 留作修复后对照。

## 最终验收记录

三组实现已集成，未新增计量表或 schema 迁移。顶部改用完整累计值；上下文 RPC 与 RuntimeRun 共享模型历史 reader，并移除观察时保存 settings 的副作用；用量条件统一由页面管理；费用未知原因与缓存上报覆盖从请求事实传递到 UI。

最终 49 项相关集成全部通过（包含 2 项真实 Electron，0 跳过），另 1 项 TUI /context、2 项计量一致性/万次请求性能通过。首次查询295ms，page p95 339ms，summary p95 338ms（1万请求、30样本）。整合过程中有一条 UI 断言仍使用旧上下文文案，按新口径更新 fixture 后完整重跑49项通过。packages构建、根及桌面三套TypeScript、变更文件ESLint、架构检查和macOS arm64打包通过。

最终真实模型使用生产host CostTracker及billing route：glm-5.2、HTTP200、1条物理请求、输入29、输出745；成本unknown且保存路由定价未匹配原因，执行轨迹与原生账本一致。测试在隔离home中运行并清理。

Computer Use：既有会话顶部显示“会话累计 Token 2.9万”，精确值29,039；模型历史5条、估算717 Token、压缩1次（覆盖4条），系统/工具未知且不再显示伪完整剩余/占用率。最近成功主请求仍为输入7695、缓存6060、组成31627B。全局用量初始选中“全部项目”，无不可读项目；切换空项目为0，切回新项目为29,039。缓存读取18489，写入“未知（未上报）”，输入复用65.8%、请求命中100%。

真实本机会话连续3次context RPC前后全事件数/水位/运行数/物理请求数不变；重启后再重复3次亦不变。前后模型历史、压缩统计、12个run、5条physical请求、完整累计与最近主请求一致。进入会话页面另有既有设置装载写入session.state事件，不属于context RPC；不宣称整个App所有读取均无状态写入。

两项扩大检查的已知基线失败：desktop-workbar-tool-panels中artifact断言期待原始“# Report”而实际HTML渲染；tui-client-commands的完整命令元数据golden与既有中文描述不一致。已在未修改基线36ef70fb分别复现同样失败，本轮未修改无关断言；本轮TUI /context针对项和受影响集成均通过。
