# 当前计划索引

- [x] **子代理活动可视化与 `/tasks` 退役**：移除面向用户的任务 ID 控制入口，保留内部 Task/worktree 运行时；批量委派会展示每个子代理的角色、目标、当前动作、状态和结果。

- [x] **Claude Code 风格 Skill 与 Workspace**：设计见 `docs/superpowers/specs/2026-07-10-claude-skill-workspace-design.md`，执行计划见 `docs/superpowers/plans/2026-07-10-claude-skill-workspace.md`。三条并行支线分别负责 Skill 激活、Workspace Roots、`/add-dir`，主协调者已完成共享接线和真实模型 E2E。
- [x] **Pico Claude Code 高拟真交互后续阶段总任务单**：详见 `docs/plans/2026-07-09-pico-claude-code-full-parity-roadmap.md`。在第一轮基础集成之上，按阶段 2-7 继续拆分为视觉交互、命令体系、权限工具、回滚会话、子代理体验、真实项目验收；每阶段使用独立 worktree 和子代理推进。
- [x] **Pico Claude Code 风格启动与交互复刻**：详见 `docs/plans/2026-07-09-pico-claude-code-parity.md`。按极简边界拆为 6 个并行 worktree 子任务：session 启动、TUI 外壳、输入编辑、命令状态、Claude 资源兼容、回滚/权限 UI。
- [x] **Pico TUI Slash Command 与 @ Mention 改造**：详见 `docs/plans/2026-07-08-pico-tui-slash-mention.md`。已拆分为 5 个可并行 worktree 子任务：命令核心、mention 附件、skills/markdown commands、TUI 候选面板、TUI/CLI 集成。

---

# 子代理活动可视化与 `/tasks` 退役

通过 Reporter 事件把子代理执行过程投影到现有 TUI transcript，每个子代理使用独立活动卡片；Task ID 只作为内部关联键。保留 TaskRegistry、worktree supervisor 和合并底座，不再向用户暴露 `/tasks` 操作协议。

## 范围

- In：移除 `/tasks`；子代理活动生命周期事件；多卡片并行渲染；相关集成测试与文档同步。
- Out：新增用户手工 merge/stop/retry UI；重写 TaskRegistry/worktree 底层；新增跨会话 Agent View。

## 验收标准

- `/tasks` 不再注册，帮助和 slash suggestions 不再出现该命令。
- 批量 `delegate_task` 为每个子代理生成独立卡片，并能同时显示 queued/running/completed/failed。
- 运行中卡片显示最近工具与目标，不向用户暴露 task ID。
- 子代理完成后保留结果摘要，不影响主 Agent 获取原有 tool result。
- 相关集成测试、lint、typecheck 和 build 通过。

## 执行结果

- 三条独立 worktree 支线已完成命令退役、活动事件链和 TUI 卡片，并合入集成分支。
- 新增跨 `DelegateTaskTool → Reporter → EventStore → Ink` 的确定性集成主链，覆盖两个并行子代理的运行与完成。
- 目标测试、lint、typecheck、build 和 high audit 通过；全量测试 1897 通过、53 个既有失败，主要来自当前 Node ABI 与 `better-sqlite3` 不兼容及旧断言。

---

# 阶段 1.5 收尾 + 阶段 2 Background Tasks 任务拆分

> 目标：先完成文件历史系统的 CLI 收尾，再完成阶段 2 的一个大功能：Background Tasks。
> 原则：TDD，小步提交，每个任务完成后同步 `ROADMAP.md`。

## 范围

- In：阶段 1.5.8 CLI 集成、Roadmap 状态修正、阶段 2.5 Background Tasks。
- Out：阶段 1.1/1.2/1.3 的旧遗留项、阶段 3.4 deferredMessages、WebSearch、Hooks、TodoList。
- 假设：阶段 2 的“大功能”指 `2.5 Background Tasks（bash 后台化）`。

## 执行结果

- [x] 阶段 1.5.8 CLI 快照列表与三轴 rewind 已完成并合并到 `main`。
- [x] 阶段 2.5 Background Tasks 已完成并合并到 `main`。
- [x] Roadmap 状态、统计表和变更记录已同步。
- [x] 验证完成：目标测试 97 个通过，全量 `npm test` 835 个通过，真实模型 CLI / 流式 / 子代理集成通过。
- [x] `npm run typecheck` 已运行，失败项为既有 tests 类型错误基线，本轮未扩大范围修复。

## 阶段 A：整理阶段 1.5 的真实剩余项

- [x] 确认 `ROADMAP.md` 中 1.5.2、1.5.3 的集成项已由 1.5.5 覆盖，改成 `[x]` 或移动说明，避免标题 `✅` 与子项冲突。
- [x] 删除或改写 `BashTool：检测 > 重定向时备份目标文件（后续补）` 的过期文案。
- [x] 保留 `清空 deferredMessages / pendingToolResultIds（字段预留到 3.4）` 为阶段 3.4 范围，不在本轮冒进实现。
- [x] 运行 `npm test -- tests/e2e/file-history-e2e.test.ts tests/engine/session-undo.test.ts` 验证整理不改变行为。
- [x] 提交：`docs(roadmap): 同步文件历史阶段状态`。

## 阶段 B：实现 1.5.8 CLI 快照列表

- [x] 编写 CLI 测试：`--list-snapshots` 能读取指定 `--session` 的快照并输出 messageId、时间、文件数量、变更统计。
- [x] 给 `Session` 或新 helper 增加快照摘要函数，返回纯数据结构，避免 CLI 直接窥探内部 Map。
- [x] 在 `src/cli/main.ts` / `src/cli/run-agent.ts` 接入 `--list-snapshots` 分支，不触发 LLM 调用。
- [x] 覆盖空快照场景：无 session / 无 snapshot 时返回清晰提示且退出成功。
- [x] 运行相关 CLI 测试与 `npm test` 子集。
- [x] 更新 `ROADMAP.md` 勾选 `--list-snapshots`。
- [x] 提交：`feat(cli): 支持列出文件历史快照`。

## 阶段 C：实现 1.5.8 CLI 三轴 rewind

- [x] 编写 CLI 测试：`--rewind` 无参数时列出可选快照点。
- [x] 编写 CLI 测试：`--rewind <message-id> --rewind-mode code` 只恢复文件，不截断对话。
- [x] 编写 CLI 测试：`--rewind <message-id> --rewind-mode conversation` 只截断对话，不恢复文件。
- [x] 编写 CLI 测试：`--rewind <message-id> --rewind-mode both` 同时恢复文件和截断对话。
- [x] 增加 messageId 到 messageIndex 的解析 helper；找不到时返回明确错误。
- [x] 在 CLI 接入 `--rewind` 和 `--rewind-mode`，默认无参数列点，有参数执行三轴选择。
- [x] 保留 `safety/checkpoint-manager.ts` 不删除，并在文档中说明它是 fallback。
- [x] 跑 `npm test -- tests/engine/session-undo.test.ts tests/e2e/file-history-e2e.test.ts`。
- [x] 更新 `ROADMAP.md` 勾选 1.5.8 中 CLI rewind、fallback、文档、测试、提交项。
- [x] 提交：`feat(cli): 支持文件历史回滚`。

## 阶段 D：设计 Background Tasks 的最小边界

- [x] 写测试草案：后台命令启动后立即返回 taskId，不阻塞 30s BashTool 超时。
- [x] 写测试草案：task 输出进入 stdout/stderr 环形缓冲，可按 taskId 读取。
- [x] 写测试草案：停止 task 会终止子进程并更新状态。
- [x] 定义 `BackgroundTaskStatus`、`BackgroundTaskRecord`、`BackgroundManager` 的最小 API。
- [x] 决定任务生命周期：内存态即可，先不持久化到磁盘。

## 阶段 E：实现 BackgroundManager

- [x] 创建 `src/tools/background-manager.ts`，用 `child_process.spawn` 启动进程。
- [x] 实现 taskId 生成、状态流转：running / exited / failed / stopped。
- [x] 实现 stdout/stderr 环形缓冲，限制总字符数，避免长日志撑爆内存。
- [x] 实现 `list()`、`output(taskId, tail?)`、`stop(taskId)`。
- [x] 补齐单元测试：启动、输出、退出码、停止、未知 taskId。
- [x] 提交：`feat(tools): 添加后台任务管理器`。

## 阶段 F：让 BashTool 支持 background

- [x] 扩展 BashTool schema：增加 `background?: boolean`。
- [x] 调整 BashTool 构造函数，注入共享 `BackgroundManager`。
- [x] 当 `background: true` 时调用 manager 启动命令并返回 taskId、pid、状态。
- [x] 保持普通 bash 行为不变：同步执行、超时、输出截断。
- [x] 保持文件历史 preWriteHook 对 bash 重定向的兼容。
- [x] 补齐 registry / e2e 测试。
- [x] 提交：`feat(tools): bash 支持后台执行`。

## 阶段 G：新增 TaskList / TaskOutput / TaskStop 工具

- [x] 在 `registry-impl.ts` 增加 `TaskListTool`，列出后台任务。
- [x] 增加 `TaskOutputTool`，按 taskId 读取 stdout/stderr tail。
- [x] 增加 `TaskStopTool`，按 taskId 停止后台任务。
- [x] 在 CLI、HTTP、飞书入口的 registry 构建处注册同一个 manager 和三个工具。
- [x] 给工具声明 readOnly / accesses：list/output 只读，stop 写或 all。
- [x] 覆盖工具级测试和入口注册测试。
- [x] 更新 `ROADMAP.md` 勾选 2.5。
- [x] 跑 `npm test` 和 `npm run typecheck`。
- [x] 提交：`feat(tools): 新增后台任务控制工具`。

## 执行顺序

1. 阶段 A-C 完成 1.5.8，并确保阶段 1.5 收口。
2. 阶段 D-G 完成 2.5 Background Tasks。
3. 每个提交后同步 `ROADMAP.md`，避免再次出现“实现已完成但 Roadmap 没跟上”的状态。
