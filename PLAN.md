# 阶段 1.5 收尾 + 阶段 2 Background Tasks 任务拆分

> 目标：先完成文件历史系统的 CLI 收尾，再完成阶段 2 的一个大功能：Background Tasks。
> 原则：TDD，小步提交，每个任务完成后同步 `ROADMAP.md`。

## 范围

- In：阶段 1.5.8 CLI 集成、Roadmap 状态修正、阶段 2.5 Background Tasks。
- Out：阶段 1.1/1.2/1.3 的旧遗留项、阶段 3.4 deferredMessages、WebSearch、Hooks、TodoList。
- 假设：阶段 2 的“大功能”指 `2.5 Background Tasks（bash 后台化）`。

## 阶段 A：整理阶段 1.5 的真实剩余项

- [ ] 确认 `ROADMAP.md` 中 1.5.2、1.5.3 的集成项已由 1.5.5 覆盖，改成 `[x]` 或移动说明，避免标题 `✅` 与子项冲突。
- [ ] 删除或改写 `BashTool：检测 > 重定向时备份目标文件（后续补）` 的过期文案。
- [ ] 保留 `清空 deferredMessages / pendingToolResultIds（字段预留到 3.4）` 为阶段 3.4 范围，不在本轮冒进实现。
- [ ] 运行 `npm test -- tests/e2e/file-history-e2e.test.ts tests/engine/session-undo.test.ts` 验证整理不改变行为。
- [ ] 提交：`docs(roadmap): 同步文件历史阶段状态`。

## 阶段 B：实现 1.5.8 CLI 快照列表

- [ ] 编写 CLI 测试：`--list-snapshots` 能读取指定 `--session` 的快照并输出 messageId、时间、文件数量、变更统计。
- [ ] 给 `Session` 或新 helper 增加快照摘要函数，返回纯数据结构，避免 CLI 直接窥探内部 Map。
- [ ] 在 `src/cli/main.ts` / `src/cli/run-agent.ts` 接入 `--list-snapshots` 分支，不触发 LLM 调用。
- [ ] 覆盖空快照场景：无 session / 无 snapshot 时返回清晰提示且退出成功。
- [ ] 运行相关 CLI 测试与 `npm test` 子集。
- [ ] 更新 `ROADMAP.md` 勾选 `--list-snapshots`。
- [ ] 提交：`feat(cli): 支持列出文件历史快照`。

## 阶段 C：实现 1.5.8 CLI 三轴 rewind

- [ ] 编写 CLI 测试：`--rewind` 无参数时列出可选快照点。
- [ ] 编写 CLI 测试：`--rewind <message-id> --rewind-mode code` 只恢复文件，不截断对话。
- [ ] 编写 CLI 测试：`--rewind <message-id> --rewind-mode conversation` 只截断对话，不恢复文件。
- [ ] 编写 CLI 测试：`--rewind <message-id> --rewind-mode both` 同时恢复文件和截断对话。
- [ ] 增加 messageId 到 messageIndex 的解析 helper；找不到时返回明确错误。
- [ ] 在 CLI 接入 `--rewind` 和 `--rewind-mode`，默认无参数列点，有参数执行三轴选择。
- [ ] 保留 `safety/checkpoint-manager.ts` 不删除，并在文档中说明它是 fallback。
- [ ] 跑 `npm test -- tests/engine/session-undo.test.ts tests/e2e/file-history-e2e.test.ts`。
- [ ] 更新 `ROADMAP.md` 勾选 1.5.8 中 CLI rewind、fallback、文档、测试、提交项。
- [ ] 提交：`feat(cli): 支持文件历史回滚`。

## 阶段 D：设计 Background Tasks 的最小边界

- [ ] 写测试草案：后台命令启动后立即返回 taskId，不阻塞 30s BashTool 超时。
- [ ] 写测试草案：task 输出进入 stdout/stderr 环形缓冲，可按 taskId 读取。
- [ ] 写测试草案：停止 task 会终止子进程并更新状态。
- [ ] 定义 `BackgroundTaskStatus`、`BackgroundTaskRecord`、`BackgroundManager` 的最小 API。
- [ ] 决定任务生命周期：内存态即可，先不持久化到磁盘。

## 阶段 E：实现 BackgroundManager

- [ ] 创建 `src/tools/background-manager.ts`，用 `child_process.spawn` 启动进程。
- [ ] 实现 taskId 生成、状态流转：running / exited / failed / stopped。
- [ ] 实现 stdout/stderr 环形缓冲，限制总字符数，避免长日志撑爆内存。
- [ ] 实现 `list()`、`output(taskId, tail?)`、`stop(taskId)`。
- [ ] 补齐单元测试：启动、输出、退出码、停止、未知 taskId。
- [ ] 提交：`feat(tools): 添加后台任务管理器`。

## 阶段 F：让 BashTool 支持 background

- [ ] 扩展 BashTool schema：增加 `background?: boolean`。
- [ ] 调整 BashTool 构造函数，注入共享 `BackgroundManager`。
- [ ] 当 `background: true` 时调用 manager 启动命令并返回 taskId、pid、状态。
- [ ] 保持普通 bash 行为不变：同步执行、超时、输出截断。
- [ ] 保持文件历史 preWriteHook 对 bash 重定向的兼容。
- [ ] 补齐 registry / e2e 测试。
- [ ] 提交：`feat(tools): bash 支持后台执行`。

## 阶段 G：新增 TaskList / TaskOutput / TaskStop 工具

- [ ] 在 `registry-impl.ts` 增加 `TaskListTool`，列出后台任务。
- [ ] 增加 `TaskOutputTool`，按 taskId 读取 stdout/stderr tail。
- [ ] 增加 `TaskStopTool`，按 taskId 停止后台任务。
- [ ] 在 CLI、HTTP、飞书入口的 registry 构建处注册同一个 manager 和三个工具。
- [ ] 给工具声明 readOnly / accesses：list/output 只读，stop 写或 all。
- [ ] 覆盖工具级测试和入口注册测试。
- [ ] 更新 `ROADMAP.md` 勾选 2.5。
- [ ] 跑 `npm test` 和 `npm run typecheck`。
- [ ] 提交：`feat(tools): 新增后台任务控制工具`。

## 执行顺序

1. 阶段 A-C 完成 1.5.8，并确保阶段 1.5 收口。
2. 阶段 D-G 完成 2.5 Background Tasks。
3. 每个提交后同步 `ROADMAP.md`，避免再次出现“实现已完成但 Roadmap 没跟上”的状态。

