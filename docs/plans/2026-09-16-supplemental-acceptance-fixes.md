# 补充验收问题修复与复测

基线：4282fe63。范围仅包含上一轮补充 Computer Use 发现的两处问题。

## 实施清单

- [x] 暂停界面：分别呈现 pause_requested 与 paused，前者等待安全边界、后者才允许继续；保留停止和消息队列功能。
- [x] Plan 修订：最新反馈在旧提案之后进入模型上下文，明确覆盖冲突要求，保留持久事件恢复与幂等语义。
- [x] 集成验证：相关 Desktop/Plan/恢复集成测试，类型检查、修改文件静态检查、打包。
- [x] 真实模型验证：DeepSeek 合成冲突修订 E2E，不重复追问、不提前写入。
- [x] 全新 Computer Use：暂停请求→已暂停→继续、队列、Plan 修订→重启恢复→批准→文件验证，以及拒绝不写入。

## 协作边界

暂停代理仅修改 Desktop renderer 和对应集成测试；Plan 代理仅修改 Runtime/Host 和对应集成及 E2E 测试。主代理维护本记录、在独立集成 worktree 合并并验收。隔离依赖与生成物，不共享写入。

## 风险和回退

Plan 修订涉及恢复与模型上下文，重点检查重复恢复、工具消息配对、历史不被重排、反馈不重复和审批边界。保持既有存储结构，避免不必要迁移。集成验证失败不更新 main；如最终需要撤回，可回退各独立修复提交，无需改写历史。

真实模型与 GUI 使用全新隔离目录和合成数据，不上传源码；只复制已经授权的 DeepSeek 配置，完成后删除复制凭证并扫描残留。

## 结果

最终代码基线：b2cc48b6；本记录更新仅涉及文档。

### 修复结果

- Desktop 不再将 pause_requested 折叠成 paused：等待安全边界时不显示继续按钮，真正暂停后才提供继续；队列提示仍保留。
- Plan 在 run admission 后从持久事件恢复反馈，用 operationId 派生稳定消息 ID，幂等追加在旧提案工具结果之后。不新增存储 Schema，不重排原历史，不改变执行授权。
- 复测发现模型会把控制事件/旧工具结果里的 operationId 复用到新工具调用，出现冲突后自愈。已隐藏修订上下文中的内部 ID，并在修订、批准执行、恢复执行提示中明确由 Runtime 为每次调用分配 ID。
- 真实执行 E2E 去掉用户 prompt 中人为要求省略 operationId 的提示，新增 Plan 工具零失败断言，防止测试提示掩盖产品问题。

### 最终状态自动化验证

```sh
node scripts/run-integration-tests.mjs desktop-conversation-surface desktop-plan-agent-graph-controls plan-mode recoverable-task-resume interrupted-history-resume
RUN_LLM_E2E=1 node --import tsx --import @pico/cli/tui/preload-env --test --test-concurrency=1 tests/e2e/plan-mode.real-llm.test.ts
```

- 相关集成：50 通过，0 失败、0 跳过。
- DeepSeek 真实模型：4 通过，0 失败、0 跳过。覆盖只读规划、批准执行、选择后修订、相互冲突要求修订；最终执行测试要求 Plan 工具零失败。
- packages 构建、根 TypeScript、Desktop main/preload/renderer TypeScript、修改文件 ESLint/Prettier、diff 检查均通过。架构边界和 storage 检查通过。
- macOS arm64 打包成功；独立聚焦审查未发现恢复、幂等、工具配对或审批边界阻塞。

### Computer Use 实测

- 与旧轮相同的冲突反馈不再重复 ask_user；批准前未写目标文件。
- 退出 GUI 并停止本轮隔离 daemon 后重启，待批修订正确恢复；批准后写入新内容。
- 最终包全新会话 `cli-mu3laywf-288286ed`：初版→修订→批准→write_file→read_file→两个步骤完成，全程无 ask_user、无工具失败；实际 `accepted-result.txt` 为 `EXTRA-PLAN-REVISED`。
- 暂停截图确认工具仍在运行时显示“等待暂停，将在安全边界暂停”，无继续按钮、保留停止；达到边界后显示已暂停与继续。
- 恢复后原轮次完成再消费下一轮队列，无重复消息；拒绝修订不写文件。

复测经历了构建迭代；暂停 UI 在最后仅涉及 Plan 提示的追加补丁前已通过 CU，其后未修改 Desktop，并在最终状态重跑相关集成和类型检查。最终包重新实测了受追加补丁影响的 Plan 完整链路。没有将一次模型样本推广为所有模型均可靠。

未扩展到其他 Provider、跨平台 GUI、Graph/Swarm 多分支写入合并、音视频附件或真实定时任务触发。本轮临时凭证移除后对隔离验收目录扫描残留为 0；仅停止本轮隔离进程，未修改原用户配置。
