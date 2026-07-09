# Claude Code TUI Parity 并行开发计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 或等价的隔离子代理流程。每个任务必须先写/补测试，再实现，再运行目标测试。不要回退他人改动。

**目标：** 将 Pico TUI 与项目启动/交互方式向 Claude Code 靠齐，优先解决重复输入框、命令体系、`@` 附件、`/rewind`、session 绑定和工具状态展示。

**架构：** 第一批只做彼此写入范围独立的基础切片，合并后再进入第二批集成型任务。TUI 采用 scrollable transcript + fixed prompt + modal/overlay 的结构；命令采用统一 command registry；session 采用显式 project/session identity。

**技术栈：** TypeScript, React, Ink, Vitest, existing Pico engine/session/file-history/input modules.

---

## 执行原则

- 当前 `main` 工作区已有未提交改动，子代理必须在 fork/worktree 中开发。
- 每个子代理只修改自己声明的文件范围；需要跨范围时停止并汇报。
- 每个任务返回：修改文件、测试命令、测试结果、未完成风险。
- 第一批完成后由主协调者统一集成；第二批依赖第一批接口稳定后再派发。

---

## 第一批：可并行开发任务

### 任务 A：TUI 布局与焦点弹窗仲裁

**负责子代理：** tui-layout-agent

**目标：** 建立 Claude Code 式 TUI 骨架：历史消息、当前输入和 overlay/modal 分层；一次只允许一个焦点弹窗。

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/message-list.tsx`
- 修改：`src/tui/input-box.tsx`
- 创建：`src/tui/dialog-arbiter.ts`
- 创建：`src/tui/layout-shell.tsx`
- 测试：`tests/tui/app.test.tsx`
- 测试：`tests/tui/input-box.test.tsx`
- 测试：`tests/tui/dialog-arbiter.test.ts`

**步骤：**
- [ ] 写 `dialog-arbiter` 单元测试：多个 dialog request 时按 priority 只返回一个 focused dialog。
- [ ] 实现 `DialogRequest`、`FocusedDialog`、`pickFocusedDialog()`。
- [ ] 写 app 布局测试：消息列表和输入框分别渲染，running 或 modal active 时输入禁用。
- [ ] 创建 `LayoutShell`，提供 `header/status/transcript/bottom/overlay/modal` 槽位。
- [ ] 接入 `App`，保持现有视觉文本尽量不变。
- [ ] 运行：`npm test -- tests/tui/dialog-arbiter.test.ts tests/tui/app.test.tsx tests/tui/input-box.test.tsx`

**不做：** 不实现虚拟滚动，不改 slash command 逻辑。

### 任务 B：统一 Command Kernel 与 `/help` 元数据

**负责子代理：** command-kernel-agent

**目标：** 将现有 slash command 扩展成 Claude Code 类 `prompt/local/local-jsx` 的轻量命令内核，为 skills/plugin/MCP 后续接入留接口。

**文件：**
- 修改：`src/input/types.ts`
- 修改：`src/input/command-registry.ts`
- 修改：`src/input/pico-command-registry.ts`
- 修改：`src/input/slash-parser.ts`
- 测试：`tests/input/command-registry.test.ts`
- 测试：`tests/input/pico-command-registry.test.ts`
- 测试：`tests/input/slash-parser.test.ts`

**步骤：**
- [ ] 写测试：command 支持 `kind/source/aliases/argumentHint/isHidden/isEnabled`。
- [ ] 扩展 `SlashCommand` 类型，保持旧命令兼容。
- [ ] 写测试：registry list 可按 source 分组，suggestion 返回描述和参数提示。
- [ ] 实现分组和过滤逻辑。
- [ ] 写测试：`/help` 数据不依赖硬编码字符串。
- [ ] 更新 `pico-command-registry`，只改元数据和 help 输出，不碰执行侧 engine。
- [ ] 运行：`npm test -- tests/input/command-registry.test.ts tests/input/pico-command-registry.test.ts tests/input/slash-parser.test.ts`

**不做：** 不接 skill loader，不改 TUI typeahead UI。

### 任务 C：`@file` 附件解析与路径候选

**负责子代理：** attachment-agent

**目标：** 复刻 Claude Code 的核心 `@file#Lx-y` 能力：解析文件引用、行号范围、目录摘要候选，并在 prompt 准备阶段生成附件上下文。

**文件：**
- 修改：`src/input/context-attachments.ts`
- 修改：`src/input/file-suggestions.ts`
- 修改：`src/input/mentions.ts`
- 修改：`src/input/prepare-prompt.ts`
- 测试：`tests/input/context-attachments.test.ts`
- 测试：`tests/input/file-suggestions.test.ts`
- 测试：`tests/input/mentions.test.ts`

**步骤：**
- [ ] 写测试：解析 `@src/foo.ts`、`@src/foo.ts#L10`、`@src/foo.ts#L10-L20`。
- [ ] 实现 mention range parser，保留原普通文本。
- [ ] 写测试：不存在文件返回可读错误上下文，不抛出未捕获异常。
- [ ] 实现文件读取、行范围裁剪和最大长度截断。
- [ ] 写测试：目录 mention 生成目录文件摘要。
- [ ] 更新 `file-suggestions` 支持 `@` 后的相对路径候选。
- [ ] 运行：`npm test -- tests/input/context-attachments.test.ts tests/input/file-suggestions.test.ts tests/input/mentions.test.ts`

**不做：** 不处理 MCP resource、`@agent`，不改 command kernel。

### 任务 D：`/rewind` 消息选择器与二次确认

**负责子代理：** rewind-agent

**目标：** 将 Pico 现有三轴 rewind 包装成 Claude Code 风格：先选消息，再显示 changed files/diff stat，再选择 code/conversation/both。

**文件：**
- 修改：`src/tui/rewind-selector.tsx`
- 修改：`src/safety/file-history.ts`
- 修改：`src/engine/session.ts`
- 测试：`tests/tui/rewind-selector.test.tsx`
- 测试：`tests/safety/file-history.test.ts`
- 测试：`tests/engine/session-undo.test.ts`

**步骤：**
- [ ] 写测试：selector 初始状态只列消息，不立即执行回滚。
- [ ] 写测试：选择消息后进入 confirm state，展示 changed files 和 `+/-` 统计。
- [ ] 在 file history 中增加只读 diff stat helper。
- [ ] 在 selector 中增加 `code/conversation/both/cancel` 确认状态。
- [ ] 写测试：cancel 不调用 rewind；confirm 才调用对应 callback。
- [ ] 运行：`npm test -- tests/tui/rewind-selector.test.tsx tests/safety/file-history.test.ts tests/engine/session-undo.test.ts`

**不做：** 不做完整 diff preview，不改 CLI `--rewind` 行为。

### 任务 E：Session Identity 与项目内 Resume 基础

**负责子代理：** session-identity-agent

**目标：** 显式保存 `originalCwd/projectRoot/cwd/sessionId/sessionProjectDir`，让后续 TUI `/resume` 能按项目/worktree 过滤。

**文件：**
- 修改：`src/engine/session-store.ts`
- 修改：`src/engine/session.ts`
- 修改：`src/cli/main.ts`
- 创建：`src/engine/session-identity.ts`
- 测试：`tests/engine/session-persistence.test.ts`
- 测试：`tests/engine/session-store-version.test.ts`
- 测试：`tests/cli-session-resolver.test.ts`

**步骤：**
- [ ] 写测试：新 session metadata 包含 cwd、projectRoot、sessionProjectDir。
- [ ] 创建 `SessionIdentity` 类型和 `createSessionIdentity()` helper。
- [ ] 写测试：旧 JSONL/session metadata 缺字段时可兼容加载。
- [ ] 更新 session-store 写入和读取 metadata。
- [ ] 写测试：同一 repo worktree 可被识别为同组候选。
- [ ] 只做 CLI 层 metadata 传递，不做 TUI picker。
- [ ] 运行：`npm test -- tests/engine/session-persistence.test.ts tests/engine/session-store-version.test.ts tests/cli-session-resolver.test.ts`

**不做：** 不实现 `/resume` picker UI，不创建 worktree。

---

## 第二批：第一批合并后再并行

### 任务 F：Skills 即 Prompt Command

**依赖：** 任务 B。

**写入范围：** `src/input/skill-commands.ts`, `src/input/markdown-command-loader.ts`, `src/input/pico-command-registry.ts`, `tests/input/skill-commands.test.ts`, `tests/input/markdown-command-loader.test.ts`

**目标：** 支持 `.claude/skills/<name>/SKILL.md` frontmatter，映射成 command registry 中的 prompt command。

### 任务 G：Slash/Path Typeahead UI

**依赖：** 任务 A、B、C。

**写入范围：** `src/tui/suggestions.tsx`, `src/tui/input-controller.ts`, `src/tui/input-box.tsx`, `tests/tui/suggestions.test.tsx`, `tests/tui/input-box.test.tsx`

**目标：** Tab 只补全，Enter 在候选打开时先接受候选；支持 slash 和 `@file` 候选。

### 任务 H：工具 UI 状态协议

**依赖：** 任务 A。

**写入范围：** `src/tui/tool-card.tsx`, `src/tui/tui-reporter.ts`, `src/tools/result-summarizer.ts`, `tests/tui/tool-card.test.ts`, `tests/tui/tui-reporter.test.ts`

**目标：** 区分 tool use/progress/queued/result/reject/error；长输出折叠。

### 任务 I：`/permissions` 可视化入口

**依赖：** 任务 B、H。

**写入范围：** `src/tui/approval-panel.tsx`, `src/approval/*`, `src/input/pico-command-registry.ts`, `tests/approval/*.test.ts`, `tests/tui/approval-panel.test.tsx`

**目标：** 在 TUI 内管理 allow/ask/deny 规则，并支持 retry recent denials。

### 任务 J：后台 Agent Task Registry 与 SendMessage

**依赖：** 任务 E。

**写入范围：** `src/tools/delegation-manager.ts`, `src/tools/subagent.ts`, `src/tools/background-manager.ts`, `src/tools/delegation-registry.ts`, `tests/subagent.test.ts`, `tests/tools/background-manager.test.ts`

**目标：** 子代理任务有 taskId、状态、output file、stop、continue；已停止 agent 可从 meta 恢复。

### 任务 K：TUI Resume Picker

**依赖：** 任务 A、E。

**写入范围：** `src/tui/session-selector.tsx`, `src/tui/repl.tsx`, `src/input/pico-command-registry.ts`, `tests/tui/session-selector.test.tsx`, `tests/tui/repl-input-routing.test.tsx`

**目标：** `/resume` 在 TUI 内按当前项目/worktree 展示可恢复会话，跨项目给启动命令提示。

---

## 集成验收

- [x] 第一批所有子代理返回后，逐个审查 diff，确认没有跨范围改动。
- [x] 合并第一批目标测试，运行：`npm test -- tests/tui/dialog-arbiter.test.ts tests/tui/app.test.tsx tests/tui/input-box.test.tsx tests/input/command-registry.test.ts tests/input/pico-command-registry.test.ts tests/input/slash-parser.test.ts tests/input/context-attachments.test.ts tests/input/file-suggestions.test.ts tests/input/mentions.test.ts tests/tui/rewind-selector.test.tsx tests/safety/file-history.test.ts tests/engine/session-undo.test.ts tests/engine/session-persistence.test.ts tests/engine/session-store-version.test.ts tests/cli-session-resolver.test.ts`
- [x] 第一批宽集成测试，运行：`npm test -- tests/tui tests/input tests/engine/session-persistence.test.ts tests/safety/file-history.test.ts`
- [x] 自动 TUI 烟测，运行：`npm run smoke:tui`
- [ ] 启动真实 TUI：`npm run dev`，手动验证 `你好` 不重复输入框。
- [ ] 验证 `/help`、`@src/tui/app.tsx`、`/rewind` selector 基础路径。
- [ ] 第二批合并后运行：`npm test` 和至少一个真实模型 e2e。
