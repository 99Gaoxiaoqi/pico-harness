# Pico Claude Code 高拟真交互后续阶段总任务单

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers-zh:subagent-driven-development` 调度子代理；每个阶段使用独立 worktree；每个子任务完成后先测试、提交，再由主协调者合并回 `main` 并勾选本文件。

**目标：** 在已完成的第一轮 Claude Code 风格启动与 TUI 基础上，逐步补齐更贴近 Claude Code 的命令体系、TUI 细节、权限工具流、回滚会话流、子代理流和真实项目验收。

**架构：** 不重写 engine，不做大框架替换；继续沿用 `src/input` 的命令注册、`src/tui` 的 ink 组件、`src/cli/run-agent.ts` 的装配层，把产品体验分阶段接入。每个阶段拆成不重叠写入范围，先合小 PR，再做阶段级集成测试。

**技术栈：** TypeScript、ink + React、现有 Pico command registry、Session/FileHistory、ToolRegistry、Vitest、ESLint。

---

## 当前状态

- [x] 第一轮基础集成完成：session 启动语义、单一底部输入框、基础 slash/@、`.claude/commands`、`.claude/agents`、`/status`、`/model`、`/thinking`、`/tools`、`/snapshots`、`/rewind`、`/undo`。
- [x] 第二轮开始前先固定任务边界：本文件即为后续阶段总控任务单。
- [ ] 后续每个阶段完成后，更新本文件与 `PLAN.md` 状态。

---

## 执行总规则

- 每个阶段创建独立 worktree，命名：`.worktrees/pico-cc-p<阶段号>-<主题>`。
- 每个 worker 分支命名：`codex/pico-cc-p<阶段号>-<主题>-<worker>`。
- 子代理只改自己写入范围内的文件，不修改本总控任务单。
- 主协调者负责合并、解决冲突、运行阶段级验证、勾选进度、提交计划状态。
- 每个 worker 提交格式：`feat(tui): 中文描述`、`feat(input): 中文描述`、`test(tui): 中文描述`。
- 阶段验收最低门槛：

```bash
npm test -- tests/input tests/tui tests/cli-run-agent.test.ts tests/cli-session-resolver.test.ts
npx eslint src/input src/tui src/cli tests/input tests/tui tests/cli-run-agent.test.ts tests/cli-session-resolver.test.ts
git diff --check
```

---

## 阶段 2：视觉和交互精修

**目标：** 让 TUI 的第一屏、消息流、工具行、状态行更像 Claude Code，重点解决“看起来像终端产品，而不是普通日志输出”。

**集成分支：** `codex/pico-cc-p2-visual`

### Worker 2A：Logo 与首屏布局

**分支/worktree：** `codex/pico-cc-p2-visual-logo` / `.worktrees/pico-cc-p2-visual-logo`

**写入范围：**
- 修改：`src/tui/logo-panel.tsx`
- 修改：`src/tui/status-bar.tsx`
- 修改：`tests/tui/logo-panel.test.tsx`
- 修改：`tests/tui/status-bar.test.tsx`

**任务：**
- [x] 调整 LogoPanel，使 `pico · model · cwd` 成为第一屏强信号。
- [x] 状态区增加 session 模式、权限模式、思考强度的紧凑展示。
- [x] 确保 cwd 过长时中间截断，不撑爆终端宽度。
- [x] 补测试覆盖长路径、缺 provider、不同 sessionMode。

**验收命令：**

```bash
npm test -- tests/tui/logo-panel.test.tsx tests/tui/status-bar.test.tsx
npx eslint src/tui tests/tui/logo-panel.test.tsx tests/tui/status-bar.test.tsx
git diff --check
```

### Worker 2B：消息行与工具行排版

**分支/worktree：** `codex/pico-cc-p2-visual-messages` / `.worktrees/pico-cc-p2-visual-messages`

**写入范围：**
- 修改：`src/tui/message-row.tsx`
- 修改：`src/tui/message-list.tsx`
- 修改：`src/tui/tool-card.tsx`
- 修改：`tests/tui/tool-card.test.ts`
- 修改：`tests/tui/should-render-statically.test.ts`

**任务：**
- [x] 统一 user / assistant / system / error 的行首符号与缩进。
- [x] 工具调用默认显示一行摘要，展开时显示参数和结果摘要。
- [x] 错误行使用醒目但不刺眼的样式，并保留原始错误信息。
- [x] 确保流式 assistant 文本不导致历史行重复渲染。

**验收命令：**

```bash
npm test -- tests/tui/tool-card.test.ts tests/tui/should-render-statically.test.ts tests/tui/app.test.tsx
npx eslint src/tui tests/tui/tool-card.test.ts tests/tui/should-render-statically.test.ts tests/tui/app.test.tsx
git diff --check
```

### Worker 2C：输入区和候选面板细节

**分支/worktree：** `codex/pico-cc-p2-visual-input` / `.worktrees/pico-cc-p2-visual-input`

**写入范围：**
- 修改：`src/tui/input-box.tsx`
- 修改：`src/tui/suggestions.tsx`
- 修改：`src/tui/input-controller.ts`
- 修改：`tests/tui/input-box.test.tsx`
- 修改：`tests/tui/suggestions.test.tsx`

**任务：**
- [x] 输入框提示文案对齐 Claude Code 风格，避免重复底部帮助行。
- [x] 候选面板限制高度，支持当前选中项高亮和描述截断。
- [x] 输入区在 running 状态下只显示禁用态，不吞掉历史内容。
- [x] 覆盖中文、多行、长命令候选的渲染测试。

**验收命令：**

```bash
npm test -- tests/tui/input-box.test.tsx tests/tui/suggestions.test.tsx
npx eslint src/tui tests/tui/input-box.test.tsx tests/tui/suggestions.test.tsx
git diff --check
```

**阶段 2 集成验收：**

- [x] 合并 2A、2B、2C。
- [x] 运行阶段最低门槛命令。
- [x] 真实 TUI 冒烟：`npm run dev -- --prompt /status`。
- [x] 提交：`feat(tui): 精修 Claude 风格视觉交互`。

---

## 阶段 3：命令体系补全

**目标：** 补齐用户从 Claude Code 迁移时最容易输入的命令，尤其是 `/mode`、`/clear`、`/compact`、`/init`、`/permissions`、`/doctor`。

**集成分支：** `codex/pico-cc-p3-commands`

### Worker 3A：模式与模型命令

**分支/worktree：** `codex/pico-cc-p3-commands-mode` / `.worktrees/pico-cc-p3-commands-mode`

**写入范围：**
- 修改：`src/input/session-settings.ts`
- 修改：`src/input/builtin-commands.ts`
- 修改：`src/input/pico-command-registry.ts`
- 修改：`tests/input/session-settings.test.ts`
- 修改：`tests/input/pico-command-registry.test.ts`

**任务：**
- [ ] 将 `/mode` 从 `/model` alias 中拆出，作为真正的交互模式命令。
- [ ] 支持 `/mode` 展示当前模式。
- [ ] 支持 `/mode default|plan|auto|yolo` 更新当前 session 设置。
- [ ] `/status` 展示 mode、permissionMode、model、thinkingEffort。

**验收命令：**

```bash
npm test -- tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts
npx eslint src/input tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts
git diff --check
```

### Worker 3B：常用本地命令

**分支/worktree：** `codex/pico-cc-p3-commands-local` / `.worktrees/pico-cc-p3-commands-local`

**写入范围：**
- 修改：`src/input/builtin-commands.ts`
- 修改：`src/input/pico-command-registry.ts`
- 修改：`src/tui/repl.tsx`
- 修改：`tests/input/pico-command-registry.test.ts`
- 修改：`tests/tui/repl-input-routing.test.tsx`

**任务：**
- [ ] `/clear` 真正清空 TUI 本地 transcript，不影响 session history。
- [ ] `/compact` 触发现有 compactor 或返回清晰不可用原因。
- [ ] `/init` 在当前项目生成或更新 Pico 需要的轻量配置入口。
- [ ] `/doctor` 检查 `.env`、provider、model、cwd、node 版本并输出诊断。

**验收命令：**

```bash
npm test -- tests/input/pico-command-registry.test.ts tests/tui/repl-input-routing.test.tsx
npx eslint src/input src/tui tests/input/pico-command-registry.test.ts tests/tui/repl-input-routing.test.tsx
git diff --check
```

### Worker 3C：帮助、补全与参数提示

**分支/worktree：** `codex/pico-cc-p3-commands-help` / `.worktrees/pico-cc-p3-commands-help`

**写入范围：**
- 修改：`src/input/command-registry.ts`
- 修改：`src/input/process-user-input.ts`
- 修改：`src/tui/suggestions.tsx`
- 修改：`tests/input/command-registry.test.ts`
- 修改：`tests/input/process-user-input.test.ts`
- 修改：`tests/tui/suggestions.test.tsx`

**任务：**
- [ ] `/help <command>` 展示 usage、aliases、说明和参数。
- [ ] 候选面板展示 alias 匹配来源，减少 `Unknown slash command`。
- [ ] 未知命令建议按 alias 和编辑距离排序。
- [ ] 命令描述统一中文或简洁英文，避免混乱。

**验收命令：**

```bash
npm test -- tests/input/command-registry.test.ts tests/input/process-user-input.test.ts tests/tui/suggestions.test.tsx
npx eslint src/input src/tui tests/input/command-registry.test.ts tests/input/process-user-input.test.ts tests/tui/suggestions.test.tsx
git diff --check
```

**阶段 3 集成验收：**

- [ ] 合并 3A、3B、3C。
- [ ] 运行阶段最低门槛命令。
- [ ] 冒烟：`npm run dev -- --prompt /mode`、`/doctor`、`/help mode`。
- [ ] 提交：`feat(input): 补齐 Claude 风格命令体系`。

---

## 阶段 4：权限与工具体验

**目标：** 把工具调用和权限确认从“能展示”推进到“可交互、可理解、可追踪”。

**集成分支：** `codex/pico-cc-p4-permissions-tools`

### Worker 4A：权限状态与命令

**分支/worktree：** `codex/pico-cc-p4-permissions-mode` / `.worktrees/pico-cc-p4-permissions-mode`

**写入范围：**
- 修改：`src/input/session-settings.ts`
- 修改：`src/input/pico-command-registry.ts`
- 修改：`src/tui/approval-panel.tsx`
- 修改：`tests/input/session-settings.test.ts`
- 修改：`tests/tui/approval-panel.test.tsx`

**任务：**
- [ ] 增加 `/permissions` 展示当前权限模式和 session approvals。
- [ ] 支持 `/permissions default|auto|yolo|plan` 的最小切换。
- [ ] ApprovalPanel 明确展示 allow once / allow session / deny / edit 四个动作。
- [ ] `/status` 与状态栏同步展示权限模式。

**验收命令：**

```bash
npm test -- tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts tests/tui/approval-panel.test.tsx
npx eslint src/input src/tui tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts tests/tui/approval-panel.test.tsx
git diff --check
```

### Worker 4B：工具调用卡片增强

**分支/worktree：** `codex/pico-cc-p4-tools-card` / `.worktrees/pico-cc-p4-tools-card`

**写入范围：**
- 修改：`src/tui/tool-card.tsx`
- 修改：`src/tui/diff-preview.tsx`
- 修改：`src/tui/tui-reporter.ts`
- 修改：`tests/tui/tool-card.test.ts`
- 修改：`tests/tui/diff-preview.test.tsx`
- 修改：`tests/tui/tui-reporter.test.ts`

**任务：**
- [ ] 工具卡片显示 running / success / failed / denied 状态。
- [ ] 对 edit/write/bash 展示 diff 或路径摘要。
- [ ] 长输出默认折叠，展开时保留截断提示。
- [ ] 失败状态显示可复制的错误摘要。

**验收命令：**

```bash
npm test -- tests/tui/tool-card.test.ts tests/tui/diff-preview.test.tsx tests/tui/tui-reporter.test.ts
npx eslint src/tui tests/tui/tool-card.test.ts tests/tui/diff-preview.test.tsx tests/tui/tui-reporter.test.ts
git diff --check
```

### Worker 4C：工具命令与披露

**分支/worktree：** `codex/pico-cc-p4-tools-disclosure` / `.worktrees/pico-cc-p4-tools-disclosure`

**写入范围：**
- 修改：`src/input/pico-command-registry.ts`
- 修改：`src/tools/tool-disclosure.ts`
- 修改：`src/tools/search-tools.ts`
- 修改：`tests/input/pico-command-registry.test.ts`
- 修改：`tests/tools/tool-disclosure.test.ts`

**任务：**
- [ ] `/tools` 区分核心工具、已披露工具、可搜索工具。
- [ ] `/tools <query>` 复用 search_tools 逻辑展示命中结果。
- [ ] 工具名称、读写属性、风险级别输出稳定可测试。
- [ ] 未加载扩展工具时给出如何搜索的提示。

**验收命令：**

```bash
npm test -- tests/input/pico-command-registry.test.ts tests/tools/tool-disclosure.test.ts
npx eslint src/input src/tools tests/input/pico-command-registry.test.ts tests/tools/tool-disclosure.test.ts
git diff --check
```

**阶段 4 集成验收：**

- [ ] 合并 4A、4B、4C。
- [ ] 运行阶段最低门槛命令。
- [ ] 冒烟：`npm run dev -- --prompt /permissions`、`/tools bash`。
- [ ] 提交：`feat(tui): 增强权限与工具调用体验`。

---

## 阶段 5：回滚与会话管理增强

**目标：** 让用户能在 TUI 中理解当前 session、历史 session、快照和 fork 关系。

**集成分支：** `codex/pico-cc-p5-session-rewind`

### Worker 5A：Session 列表与恢复

**分支/worktree：** `codex/pico-cc-p5-session-list` / `.worktrees/pico-cc-p5-session-list`

**写入范围：**
- 修改：`src/cli/session-resolver.ts`
- 修改：`src/input/pico-command-registry.ts`
- 新增：`src/tui/session-selector.tsx`
- 修改：`tests/cli-session-resolver.test.ts`
- 新增：`tests/tui/session-selector.test.tsx`

**任务：**
- [ ] 增加 session 摘要结构：id、cwd、createdAt、updatedAt、messageCount。
- [ ] `/sessions` 展示当前项目可恢复的 session 列表。
- [ ] `/resume <session-id>` 在 TUI 内提示用户重启或切换的最小路径。
- [ ] SessionSelector 组件支持空列表、当前项、长 id 截断。

**验收命令：**

```bash
npm test -- tests/cli-session-resolver.test.ts tests/input/pico-command-registry.test.ts tests/tui/session-selector.test.tsx
npx eslint src/cli src/input src/tui tests/cli-session-resolver.test.ts tests/input/pico-command-registry.test.ts tests/tui/session-selector.test.tsx
git diff --check
```

### Worker 5B：Rewind 选择体验

**分支/worktree：** `codex/pico-cc-p5-rewind-selector` / `.worktrees/pico-cc-p5-rewind-selector`

**写入范围：**
- 修改：`src/tui/rewind-selector.tsx`
- 修改：`src/input/pico-command-registry.ts`
- 修改：`src/cli/file-history.ts`
- 修改：`tests/tui/rewind-selector.test.tsx`
- 修改：`tests/cli-file-history.test.ts`

**任务：**
- [ ] `/snapshots` 展示时间、messageId、文件数量、变更摘要。
- [ ] `/rewind` 无参数时展示最近快照和 mode 使用说明。
- [ ] `/rewind <id> code|conversation|both` 支持 TUI 文本路径。
- [ ] 找不到快照时输出可行动提示。

**验收命令：**

```bash
npm test -- tests/tui/rewind-selector.test.tsx tests/cli-file-history.test.ts tests/input/pico-command-registry.test.ts
npx eslint src/tui src/input src/cli tests/tui/rewind-selector.test.tsx tests/cli-file-history.test.ts tests/input/pico-command-registry.test.ts
git diff --check
```

### Worker 5C：Fork 与继续语义可见化

**分支/worktree：** `codex/pico-cc-p5-fork-status` / `.worktrees/pico-cc-p5-fork-status`

**写入范围：**
- 修改：`src/cli/session-resolver.ts`
- 修改：`src/tui/status-bar.tsx`
- 修改：`src/input/session-settings.ts`
- 修改：`tests/cli-session-resolver.test.ts`
- 修改：`tests/tui/status-bar.test.tsx`

**任务：**
- [ ] sessionMode 区分 new / continue / resume / fork。
- [ ] fork session 在状态栏显示来源 session 短 id。
- [ ] `/status` 输出 sessionId、sessionMode、forkFrom。
- [ ] 继续/恢复失败时给出明确错误。

**验收命令：**

```bash
npm test -- tests/cli-session-resolver.test.ts tests/tui/status-bar.test.tsx tests/input/session-settings.test.ts
npx eslint src/cli src/tui src/input tests/cli-session-resolver.test.ts tests/tui/status-bar.test.tsx tests/input/session-settings.test.ts
git diff --check
```

**阶段 5 集成验收：**

- [ ] 合并 5A、5B、5C。
- [ ] 运行阶段最低门槛命令。
- [ ] 冒烟：`npm run dev -- --prompt /sessions`、`/snapshots`。
- [ ] 提交：`feat(cli): 增强 session 与回滚交互`。

---

## 阶段 6：子代理与 Agent 体验

**目标：** 让 `.claude/agents` 不只是可读取，还能参与任务分派和运行状态展示。

**集成分支：** `codex/pico-cc-p6-agents`

### Worker 6A：Agent 列表与选择

**分支/worktree：** `codex/pico-cc-p6-agents-list` / `.worktrees/pico-cc-p6-agents-list`

**写入范围：**
- 修改：`src/input/agent-loader.ts`
- 修改：`src/input/pico-command-registry.ts`
- 新增：`src/tui/agent-list.tsx`
- 修改：`tests/input/agent-loader.test.ts`
- 新增：`tests/tui/agent-list.test.tsx`

**任务：**
- [ ] `/agents` 展示内置代理和 `.claude/agents` 代理。
- [ ] agent 摘要包含 name、description、tools、source。
- [ ] AgentList 支持空态、长描述截断、来源标记。
- [ ] agent frontmatter 解析失败时不阻断其他 agent。

**验收命令：**

```bash
npm test -- tests/input/agent-loader.test.ts tests/input/pico-command-registry.test.ts tests/tui/agent-list.test.tsx
npx eslint src/input src/tui tests/input/agent-loader.test.ts tests/input/pico-command-registry.test.ts tests/tui/agent-list.test.tsx
git diff --check
```

### Worker 6B：Agent 分派命令

**分支/worktree：** `codex/pico-cc-p6-agents-dispatch` / `.worktrees/pico-cc-p6-agents-dispatch`

**写入范围：**
- 修改：`src/input/pico-command-registry.ts`
- 修改：`src/input/process-user-input.ts`
- 修改：`src/tools/default-registry.ts`
- 修改：`tests/input/process-user-input.test.ts`
- 修改：`tests/input/pico-command-registry.test.ts`

**任务：**
- [ ] `/agent <name> <task>` 转成明确 prompt 或 delegate_task 调用意图。
- [ ] 找不到 agent 时给出最接近建议。
- [ ] agent task 为空时展示 usage。
- [ ] 保持普通 `/agents` 列表行为不变。

**验收命令：**

```bash
npm test -- tests/input/process-user-input.test.ts tests/input/pico-command-registry.test.ts tests/tools/default-registry.test.ts
npx eslint src/input src/tools tests/input/process-user-input.test.ts tests/input/pico-command-registry.test.ts tests/tools/default-registry.test.ts
git diff --check
```

### Worker 6C：子代理运行状态展示

**分支/worktree：** `codex/pico-cc-p6-agents-status` / `.worktrees/pico-cc-p6-agents-status`

**写入范围：**
- 修改：`src/tui/tui-reporter.ts`
- 修改：`src/tui/message-row.tsx`
- 修改：`src/tui/tool-card.tsx`
- 修改：`tests/tui/tui-reporter.test.ts`
- 修改：`tests/tui/tool-card.test.ts`

**任务：**
- [ ] delegate_task 工具调用显示 agent 名称、任务摘要、状态。
- [ ] 多任务批量分派时显示总数和完成数。
- [ ] 子代理失败时保留失败摘要，不吞掉其他成功结果。
- [ ] 长任务结果默认折叠。

**验收命令：**

```bash
npm test -- tests/tui/tui-reporter.test.ts tests/tui/tool-card.test.ts
npx eslint src/tui tests/tui/tui-reporter.test.ts tests/tui/tool-card.test.ts
git diff --check
```

**阶段 6 集成验收：**

- [ ] 合并 6A、6B、6C。
- [ ] 运行阶段最低门槛命令。
- [ ] 冒烟：`npm run dev -- --prompt /agents`。
- [ ] 提交：`feat(input): 增强子代理交互体验`。

---

## 阶段 7：真实项目验证与发布收口

**目标：** 用真实项目目录验证完整 Claude Code 风格工作流，并补齐启动文档和回归脚本。

**集成分支：** `codex/pico-cc-p7-acceptance`

### Worker 7A：真实 TUI 冒烟脚本

**分支/worktree：** `codex/pico-cc-p7-acceptance-smoke` / `.worktrees/pico-cc-p7-acceptance-smoke`

**写入范围：**
- 新增：`scripts/tui-smoke.mjs`
- 新增：`tests/tui/tui-smoke-script.test.ts`
- 修改：`package.json`

**任务：**
- [ ] 新增 `npm run smoke:tui`，依次执行 `/status`、`/mode`、`/tools`、`/help`。
- [ ] 脚本读取 `.env`，缺 provider 配置时输出 skip 原因并成功退出。
- [ ] 测试覆盖有配置和无配置两种路径。
- [ ] 输出包含命令、退出码、关键摘要。

**验收命令：**

```bash
npm test -- tests/tui/tui-smoke-script.test.ts
npm run smoke:tui
npx eslint scripts tests/tui/tui-smoke-script.test.ts
git diff --check
```

### Worker 7B：用户启动文档

**分支/worktree：** `codex/pico-cc-p7-acceptance-docs` / `.worktrees/pico-cc-p7-acceptance-docs`

**写入范围：**
- 新增：`docs/tui-claude-code-parity.md`
- 修改：`README.md`

**任务：**
- [ ] 说明在任意项目目录启动 Pico 的推荐方式。
- [ ] 说明 session：new / continue / resume / fork。
- [ ] 列出支持的 slash commands、`.claude/commands`、`.claude/agents`。
- [ ] 列出常见错误：`.env` 缺失、provider 配置缺失、未知命令。

**验收命令：**

```bash
npm test -- tests/input tests/tui
npx eslint src/input src/tui tests/input tests/tui
git diff --check
```

### Worker 7C：最终回归子代理

**分支/worktree：** 不写代码，只在 `main` 集成后运行。

**任务：**
- [ ] 运行完整目标测试。
- [ ] 运行 lint。
- [ ] 运行 `git diff --check`。
- [ ] 运行 `npm run smoke:tui`。
- [ ] 手工抽查命令：`/mode`、`/permissions`、`/sessions`、`/agents`、`/rewind`。
- [ ] 输出最终验证报告，列出仍未覆盖的真实交互风险。

**最终验收命令：**

```bash
npm test -- tests/input tests/tui tests/cli-run-agent.test.ts tests/cli-session-resolver.test.ts tests/cli-file-history.test.ts
npx eslint src/input src/tui src/cli scripts tests/input tests/tui tests/cli-run-agent.test.ts tests/cli-session-resolver.test.ts tests/cli-file-history.test.ts
git diff --check
npm run smoke:tui
```

**阶段 7 集成验收：**

- [ ] 合并 7A、7B。
- [ ] 启动 7C 验证子代理。
- [ ] 修复最终验证发现的问题。
- [ ] 提交：`docs(tui): 补充 Claude 风格交互启动指南`。
- [ ] 总控任务单全部勾选，目标完成。

---

## 阶段推进顺序

- [x] 阶段 2：视觉和交互精修。
- [ ] 阶段 3：命令体系补全。
- [ ] 阶段 4：权限与工具体验。
- [ ] 阶段 5：回滚与会话管理增强。
- [ ] 阶段 6：子代理与 Agent 体验。
- [ ] 阶段 7：真实项目验证与发布收口。

---

## 下一步执行入口

从阶段 2 开始：

1. 主协调者创建集成分支 `codex/pico-cc-p2-visual`。
2. 为 2A、2B、2C 创建三个 worktree。
3. 启动三个子代理，分别执行自己的任务。
4. 每个 worker 完成后跑自己的验收命令并提交。
5. 主协调者依次合并，跑阶段 2 集成验收。
6. 阶段 2 完成后勾选本文件，再进入阶段 3。
