# Claude Code TUI Parity 第二阶段优化计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 或等价的隔离子代理流程。每个任务必须在独立 git worktree 中开发，先补测试，再实现，再运行目标测试。不要回退他人改动。

**目标：** 在第一批 TUI/命令/session 基础上，补齐 Claude Code 风格的 prompt command、候选交互、工具状态、权限入口、后台代理任务和 resume picker 的可用闭环。

**架构：** 第二阶段优先做现有雏形的补齐和接线。各子任务尽量限制写入范围；共享接线文件由主协调者最后合并处理，降低冲突。

**技术栈：** TypeScript, React, Ink, Vitest, existing Pico command/session/tool/TUI modules.

---

## 执行原则

- 每个子代理创建自己的 worktree：`.worktrees/pico-5-1-phase2-<task>`。
- 每个子代理只修改指定写入范围；遇到共享文件冲突时停止并汇报。
- 每个子代理返回：worktree 路径、分支名、修改文件、测试命令、测试结果、风险。
- 主协调者负责合并到 `main`、更新 ROADMAP、跑集成测试、提交和推送。

---

## 第二阶段细分任务

### 任务 F1：Skill Prompt Command 投影补齐

**负责子代理：** phase2-skill-command-agent

**写入范围：**
- `src/input/skill-commands.ts`
- `src/input/markdown-command-loader.ts`
- `tests/input/skill-commands.test.ts`
- `tests/input/markdown-command-loader.test.ts`

**目标：** 让 `.claude/skills/<name>/SKILL.md` 和 `.claw/skills/<name>/SKILL.md` 可以稳定投影为 prompt command，并支持 description / argument hint / allowed tools 元数据。

**验收：**
- [x] skill command 名称非法时被跳过。
- [x] skill body 作为 prompt command prompt。
- [x] `argument-hint` / `allowed-tools` 元数据可被读取。
- [x] project/user markdown command 仍优先级高于 skill projection。
- [x] 运行：`npm test -- tests/input/skill-commands.test.ts tests/input/markdown-command-loader.test.ts`

### 任务 G1：Slash 与 @Path Typeahead 行为完善

**负责子代理：** phase2-typeahead-agent

**写入范围：**
- `src/tui/suggestions.tsx`
- `src/tui/input-controller.ts`
- `src/tui/input-box.tsx`
- `tests/tui/suggestions.test.tsx`
- `tests/tui/input-box.test.tsx`

**目标：** 补齐 Claude Code 风格候选交互：候选打开时 Enter 接受候选，Tab 补全，方向键移动候选；slash 和 `@file` 候选展示参数提示。

**验收：**
- [x] 候选打开时 Enter 接受候选，不提交 prompt。
- [x] Tab 仍接受候选。
- [x] `@` 候选补全后保留前缀和空格。
- [x] slash 候选显示 description + argument hint。
- [x] 运行：`npm test -- tests/tui/suggestions.test.tsx tests/tui/input-box.test.tsx`

### 任务 H1：Tool UI 状态协议硬化

**负责子代理：** phase2-tool-ui-agent

**写入范围：**
- `src/tui/tool-card.tsx`
- `src/tui/tui-reporter.ts`
- `src/tools/result-summarizer.ts`
- `tests/tui/tool-card.test.ts`
- `tests/tui/tui-reporter.test.ts`

**目标：** 工具调用展示统一区分 queued/running/success/error/denied，并让长结果默认折叠、错误摘要可读。

**验收：**
- [x] queued / running / success / error / denied 都有明确渲染。
- [x] tool result 长文本默认折叠为一行摘要。
- [x] error/denied 使用错误色和可读错误摘要。
- [x] subagent/delegate 工具保持树形进度展示。
- [x] 运行：`npm test -- tests/tui/tool-card.test.ts tests/tui/tui-reporter.test.ts`

### 任务 I1：Permissions 可视化模型与面板

**负责子代理：** phase2-permissions-agent

**写入范围：**
- `src/tui/approval-panel.tsx`
- `src/approval/permission-state.ts`
- `tests/tui/approval-panel.test.tsx`
- `tests/approval/permission-state.test.ts`

**目标：** 建立 TUI 内 `/permissions` 可视化入口需要的数据模型和渲染面板，显示 allow/ask/deny 规则与最近拒绝项。

**验收：**
- [x] permission state 可从规则对象生成 allow/ask/deny 分组。
- [x] 面板渲染当前模式、规则列表和最近拒绝项。
- [x] 空状态有简洁提示。
- [x] 不修改底层审批执行语义。
- [x] 运行：`npm test -- tests/tui/approval-panel.test.tsx tests/approval/permission-state.test.ts`

### 任务 J1：后台 Agent Task Registry 状态快照

**负责子代理：** phase2-agent-registry-agent

**写入范围：**
- `src/tools/delegation-manager.ts`
- `src/tools/subagent.ts`
- `src/tools/background-manager.ts`
- `tests/subagent.test.ts`
- `tests/tools/background-manager.test.ts`

**目标：** 为后台代理任务补齐 taskId、状态快照、output 摘要和可恢复元信息，便于后续 TUI 展示和 SendMessage 风格继续任务。

**验收：**
- [x] delegate background 返回稳定 `taskId/delegationId`。
- [x] status snapshot 包含 queued/running/done/error/cancelled。
- [x] 输出摘要可安全截断。
- [x] 现有 background-manager 行为不回退。
- [x] 运行：`npm test -- tests/subagent.test.ts tests/tools/background-manager.test.ts`

### 任务 K1：TUI Resume Picker 接线

**负责子代理：** phase2-resume-picker-agent

**写入范围：**
- `src/tui/session-selector.tsx`
- `tests/tui/session-selector.test.tsx`

**目标：** 完善 `/resume` picker 的纯 UI/格式化能力，按当前项目/worktree 标记可恢复 session，并给跨项目 session 明确启动提示。

**验收：**
- [x] 当前项目 session 排在前面。
- [x] 当前 session 有明显标记。
- [x] 跨项目 session 显示 `cd <project> && pico --resume <id>` 风格提示。
- [x] 长 session id 不破坏布局。
- [x] 运行：`npm test -- tests/tui/session-selector.test.tsx`

---

## 主协调者集成任务

- [x] 合并 F1-K1 的无冲突 diff。
- [x] 在 `src/input/pico-command-registry.ts` 接入需要的命令元数据或本地命令入口。
- [x] 在 `src/tui/repl.tsx` 接入需要的 picker/panel routing。
- [x] 更新 `ROADMAP.md` 第二批任务状态。
- [x] 运行第二阶段目标测试：
  `npm test -- tests/input/skill-commands.test.ts tests/input/markdown-command-loader.test.ts tests/tui/suggestions.test.tsx tests/tui/input-box.test.tsx tests/tui/tool-card.test.ts tests/tui/tui-reporter.test.ts tests/tui/approval-panel.test.tsx tests/approval/permission-state.test.ts tests/subagent.test.ts tests/tools/background-manager.test.ts tests/tui/session-selector.test.tsx`
- [x] 运行宽集成测试：`npm test -- tests/input tests/tui tests/tools/background-manager.test.ts tests/subagent.test.ts tests/approval`
- [x] 运行自动 TUI 烟测：`npm run smoke:tui`
- [x] 提交并推送 `main`。
