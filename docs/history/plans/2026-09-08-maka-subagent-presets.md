# Maka 子 Agent 配置完整接入

## 范围与基线

- Pico 基线：60570aca50b9c6e31d0dbe0e97e57fff62a4ce3a，main 与 origin/main 一致且干净。
- Maka 核验：本地 /Users/anxuan/workspace/研究/maka-agent，HEAD 584652137；存在用户未提交修改，不改动上游。引用以本次读取内容为准。
- 对齐设置页面、Preset 配置、能力边界、发现/前台启动、Graph 选择及历史快照行为，复用 Pico 引擎与 Provider。
- 三类能力：local_read（文件检索/summary/shared）、web_research（web_search/summary/shared）、implementation（读写执行/patch/isolated-worktree）。
- Preset ID 与显示名称分离。未指定 thinkingLevel 表示模型默认，不能继承主 Agent 的思考级别。

## 任务及文件所有权

- [x] T0：共享 Preset/Connection/Snapshot 类型；主代理统一契约与集成。
- [x] T1：后端子代理负责 user-config-store 的 subagents 字段、归一化、配置目录、独立 daemon handler，以及 protocol 方法/校验。不能修改 desktop-runtime-service/production-host。
- [x] T2：UI 子代理负责独立 SubagentSettingsPage、表单 helper、独立样式与相关测试。主代理负责导航与 runtime 接线。
- [x] T3/T4：执行子代理负责 src/tools、src/runtime、src/agent-graph 相关实现及 src/agents/subagent-profiles.ts，前台与 Graph 均使用同一配置目录。不能修改 src/agents/configured-subagent-catalog.ts、protocol 或 daemon 文件。
- [x] T5：主代理负责 daemon 生产装配、Desktop 导航/runtime、兼容与刷新。
- [x] T6：最终集成、真实模型与 UI 验收、类型和构建检查、Git 集成推送与清理。

## 冻结接口

- 公共类型：packages/protocol/src/runtime/subagents.ts，经 @pico/protocol 导出。
- subagents.get({}) -> RuntimeSubagentSettingsSnapshot。
- subagents.update({ presets: RuntimeSubagentPreset[], expectedRevision: string }) -> RuntimeSubagentSettingsSnapshot；全数组设置与 Maka 一致，使用既有配置写锁/版本冲突保护。
- src/agents/configured-subagent-catalog.ts 导出 ConfiguredSubagentCatalog，list(): Promise<RuntimeConfiguredSubagent[]>，resolve(id): Promise<RuntimeSubagentPreset & {modelRouteId:string}>。
- createConfiguredSubagentCatalog({getPresets,getConnections}) 构建上述目录，getConnections 返回 RuntimeSubagentConnection[]，不携带密钥。
- UI 组件 props：snapshot: RuntimeSubagentSettingsSnapshot；onUpdate(presets: readonly RuntimeSubagentPreset[], expectedRevision: string): Promise<RuntimeSubagentSettingsSnapshot>。
- 新配置持久化于既有用户 config.json 的 subagents.presets；旧 agents.yaml 不迁移、不伪装成 Preset，保持兼容调用。
- 公共字段如必须变更，由主代理确认后单一所有者修改；生成物和锁文件不并行改动。

## 验收清单

- [x] 64 条上限、名称 128/描述 1000/ID 128、精确 ID 去重和 Maka 归一化规则。
- [x] 列表/空态/二级编辑、ID 自动生成和手动编辑后停止联动、已有 ID 只读。
- [x] 连接/模型变化清空思考、无效旧值保留占位、默认思考不继承父级。
- [x] 保存失败留表单，成功后核实 ID 存在，启停/删除持久化，配置版本冲突保护。
- [x] agent_list 每页 8 条、selection/catalog 两视图、不可用原因与旧选择兼容。
- [x] agent_spawn 使用固定 subagent_id，优先于旧 profile，运行前重查可用性和能力。
- [x] 三类真实权限、implementation 独立 worktree、结果/进度引用可追踪。
- [x] Graph 与前台解析同一 Preset；已创建快照不随编辑/删除变化；恢复与旧历史兼容。
- [x] 保存后的 UI 和运行目录刷新，配置与 Provider 变更不丢失彼此字段。
- [x] 定向集成、真实模型、Desktop 交互、类型与构建检查在最终集成状态完成。

## 验证记录

2026-09-08，在独立集成分支完成以下验证：

- 定向集成 38/38 通过、无跳过：覆盖配置归一化/可用性/CAS、真实 Chrome 设置页交互、Desktop 生产协议、Provider 字段保留、队列 SQLite 重开、三类执行能力、worktree 补丁新增文件、父子授权历史读取、Graph 快照及旧 Profile 兼容。相关文件为 `tests/integration/{agents,desktop,runtime,graph,storage}` 下本任务新增与直接相关回归。
- 真实模型：`deepseek/deepseek-v4-flash`。前台发现 → 固定 Preset 启动 → 读取随机文件 → `agent_output` 回读；Graph 选择 `new_preset` → 独立 Operator → 持久结果 → 唤醒原 Root 结束。命令：`RUN_LLM_E2E=1 PICO_PRESET_GRAPH_E2E=1 node --import tsx --import ./src/tui/preload-env.ts --test --test-concurrency=1 tests/e2e/configured-subagent-presets.real-llm.test.ts tests/e2e/agent-graph-v2.real-llm.test.ts`。
- 最终联合真实模型复验中，前台通过；Graph 的运行、持久化、唤醒均成功，但模型随机标记长度不符既有 32 位断言，单次测试失败。保持断言和代码不变进行一次单独复验，3/3 通过（含 1 条真实模型 Graph 场景与 2 条诊断契约测试）；前台真实场景 1/1 通过。此波动来自模型输出格式，不隐藏首次失败。
- `npm run build`、根 `npx tsc --noEmit`、Desktop main/preload/renderer 三个 tsconfig 类型检查、全部变更 TS/TSX 定向 ESLint、`git diff --check` 通过。
- 聚焦独立审查未发现阻塞：固定工具边界、默认模型思考、implementation 隔离、历史父子授权、显式 Preset 不回退及快照重放。

## 交付说明

- 入口：桌面设置 → 能力 → 子 Agent。保存后立即更新设置与当前工作区目录；旧 `agents.yaml` 保持原入口。
- 前台与 Graph 共用用户级配置目录；删除 Preset 不删除已有子会话、运行输出或 Graph 快照。
- Pico 当前 Provider 配置没有独立 enabled/retired 控件；目录协议支持这些可用性原因，宿主按实际已配置连接和模型投影，不新增虚假的开关。
- 本次对齐范围是 Maka 的子 Agent 配置与执行闭环，沿用 Pico 的 UI 组件、Provider 和存储/执行引擎。真实模型验收覆盖 local_read 前台与 Graph；implementation 的 worktree/补丁由确定性集成验证，未声称三类能力均跑过真实模型。
- 来源与 Apache 许可归属保留于 `resources/licenses/THIRD_PARTY_NOTICES.md`。
