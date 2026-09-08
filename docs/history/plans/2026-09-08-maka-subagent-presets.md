# Maka 子 Agent 配置完整接入

## 范围与基线

- Pico 基线：60570aca50b9c6e31d0dbe0e97e57fff62a4ce3a，main 与 origin/main 一致且干净。
- Maka 核验：本地 /Users/anxuan/workspace/研究/maka-agent，HEAD 584652137；存在用户未提交修改，不改动上游。引用以本次读取内容为准。
- 对齐设置页面、Preset 配置、能力边界、发现/前台启动、Graph 选择及历史快照行为，复用 Pico 引擎与 Provider。
- 三类能力：local_read（文件检索/summary/shared）、web_research（web_search/summary/shared）、implementation（读写执行/patch/isolated-worktree）。
- Preset ID 与显示名称分离。未指定 thinkingLevel 表示模型默认，不能继承主 Agent 的思考级别。

## 任务及文件所有权

- [x] T0：共享 Preset/Connection/Snapshot 类型；主代理统一契约与集成。
- [ ] T1：后端子代理负责 user-config-store 的 subagents 字段、归一化、配置目录、独立 daemon handler，以及 protocol 方法/校验。不能修改 desktop-runtime-service/production-host。
- [ ] T2：UI 子代理负责独立 SubagentSettingsPage、表单 helper、独立样式与相关测试。主代理负责导航与 runtime 接线。
- [ ] T3/T4：执行子代理负责 src/tools、src/runtime、src/agent-graph 相关实现及 src/agents/subagent-profiles.ts，前台与 Graph 均使用同一配置目录。不能修改 src/agents/configured-subagent-catalog.ts、protocol 或 daemon 文件。
- [ ] T5：主代理负责 daemon 生产装配、Desktop 导航/runtime、兼容与刷新。
- [ ] T6：最终集成、真实模型与 UI 验收、类型和构建检查、Git 集成推送与清理。

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

- [ ] 64 条上限、名称 128/描述 1000/ID 128、精确 ID 去重和 Maka 归一化规则。
- [ ] 列表/空态/二级编辑、ID 自动生成和手动编辑后停止联动、已有 ID 只读。
- [ ] 连接/模型变化清空思考、无效旧值保留占位、默认思考不继承父级。
- [ ] 保存失败留表单，成功后核实 ID 存在，启停/删除持久化，配置版本冲突保护。
- [ ] agent_list 每页 8 条、selection/catalog 两视图、不可用原因与旧选择兼容。
- [ ] agent_spawn 使用固定 subagent_id，优先于旧 profile，运行前重查可用性和能力。
- [ ] 三类真实权限、implementation 独立 worktree、结果/进度引用可追踪。
- [ ] Graph 与前台解析同一 Preset；已创建快照不随编辑/删除变化；恢复与旧历史兼容。
- [ ] 保存后的 UI 和运行目录刷新，配置与 Provider 变更不丢失彼此字段。
- [ ] 定向集成、真实模型、Desktop 交互、类型与构建检查在最终集成状态完成。

## 验证记录

开发中；尚无测试通过记录。
