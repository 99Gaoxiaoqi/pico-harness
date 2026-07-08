# Pico Claude Code 风格启动与交互复刻计划

> 面向主协调者和实现子代理：本计划是第二阶段持久化任务单。每个任务必须保持极简实现、边做边测、完成后由主协调者在本文件勾选。子代理不要修改本计划文件，避免并行合并冲突。

**目标：** 让 Pico 的启动方式和交互习惯更接近 Claude Code：在任意项目目录启动默认新会话，可继续/恢复会话；TUI 保持单一当前输入框；提供模型、思考强度、工具、权限、回滚等可见且可操作的入口。

**原则：**

- 不照搬源码，只复刻可观察的产品机制和交互。
- 不做大框架重写；优先在现有 CLI/TUI/input 层补最小能力。
- 子任务写入范围尽量不重叠；完成一个合并一个，合并后立即验证并勾选。
- full `typecheck` 目前有既有债务，第二阶段验收以目标测试、lint、`git diff --check` 和真实 TUI 冒烟为准。

---

## 当前基线

- [x] 基线提交：第一阶段 slash command、@ mention、skill command、TUI 候选与 `.env` 启动修复已合入 `main`。
- [x] 第二阶段 worktree 已创建。
- [x] 子代理已启动并拿到各自写入范围。
- [ ] 子代理开发结果已全部集成回 `main`。
- [ ] 集成测试子代理完成最终验证。

---

## Worker A：项目启动与 Session 语义

**分支/worktree：** `codex/pico-cc-session` / `.worktrees/pico-cc-session`

**写入范围：**

- 新增：`src/cli/session-resolver.ts`
- 可改：`src/cli/main.ts`
- 可改：`src/cli/run-agent.ts`
- 可改：`tests/cli-run-agent.test.ts`
- 新增：`tests/cli-session-resolver.test.ts`

**任务：**

- [x] 默认启动时创建新的 session id，不再按工作目录固定复用同一个 session。
- [x] 增加 `--continue` / `-c`：继续当前项目最近一次 session。
- [x] 增加 `--resume <session-id>` / `-r <session-id>`：恢复指定 session。
- [x] 增加 `--fork-session <session-id>`：从指定 session 派生新 session id。
- [x] 把 session 选择结果显示给 TUI header/status 使用。

**验收命令：**

```bash
npm test -- tests/cli-session-resolver.test.ts tests/cli-run-agent.test.ts
npx eslint src/cli tests/cli-session-resolver.test.ts tests/cli-run-agent.test.ts
git diff --check
```

---

## Worker B：TUI 外壳与 Claude 风格状态区

**分支/worktree：** `codex/pico-cc-tui-shell` / `.worktrees/pico-cc-tui-shell`

**写入范围：**

- 新增：`src/tui/logo-panel.tsx`
- 新增：`src/tui/status-bar.tsx`
- 可改：`src/tui/app.tsx`
- 可改：`src/tui/message-row.tsx`
- 新增：`tests/tui/status-bar.test.tsx`
- 新增：`tests/tui/logo-panel.test.tsx`

**任务：**

- [x] 启动首屏显示简洁 Logo/名称，不重复渲染历史输入框。
- [x] 顶部或底部状态区显示 model、provider、cwd、session 模式。
- [x] 输入框只在底部保留一个当前框，历史区只显示 user/assistant 消息。
- [x] 系统提示、命令输出、错误用轻量状态行呈现。

**验收命令：**

```bash
npm test -- tests/tui/status-bar.test.tsx tests/tui/logo-panel.test.tsx tests/tui/tui-reporter.test.ts
npx eslint src/tui tests/tui/status-bar.test.tsx tests/tui/logo-panel.test.tsx
git diff --check
```

---

## Worker C：Prompt 输入编辑体验

**分支/worktree：** `codex/pico-cc-prompt-input` / `.worktrees/pico-cc-prompt-input`

**写入范围：**

- 可改：`src/tui/input-controller.ts`
- 可改：`src/tui/input-box.tsx`
- 可改：`src/tui/suggestions.tsx`
- 可改：`tests/tui/input-box.test.tsx`
- 可改：`tests/tui/suggestions.test.tsx`

**任务：**

- [ ] 支持左右方向键、Home/End、Ctrl+A/Ctrl+E。
- [ ] 支持 Ctrl+U 清空行、Ctrl+W 删除前一个词。
- [ ] 粘贴多行时保持现有 Alt/Shift+Enter 多行语义。
- [ ] slash/@ 候选在有光标后仍按当前 token 补全。

**验收命令：**

```bash
npm test -- tests/tui/input-box.test.tsx tests/tui/suggestions.test.tsx
npx eslint src/tui tests/tui/input-box.test.tsx tests/tui/suggestions.test.tsx
git diff --check
```

---

## Worker D：模型、思考强度与工具状态命令

**分支/worktree：** `codex/pico-cc-command-state` / `.worktrees/pico-cc-command-state`

**写入范围：**

- 新增：`src/input/session-settings.ts`
- 可改：`src/input/builtin-commands.ts`
- 可改：`src/input/pico-command-registry.ts`
- 可改：`src/cli/run-agent.ts`
- 新增：`tests/input/session-settings.test.ts`
- 可改：`tests/input/pico-command-registry.test.ts`

**任务：**

- [ ] `/model` 不只展示，还能切换当前 session 后续请求使用的模型。
- [ ] `/thinking` 与 `/effort` 设置思考强度，保持 provider 不支持时清晰提示。
- [ ] `/tools` 展示可用工具和只读/写入属性。
- [ ] `/status` 汇总 model、effort、session、cwd、权限模式。

**验收命令：**

```bash
npm test -- tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts tests/cli-run-agent.test.ts
npx eslint src/input src/cli tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts
git diff --check
```

---

## Worker E：Claude 资源兼容层

**分支/worktree：** `codex/pico-cc-assets` / `.worktrees/pico-cc-assets`

**写入范围：**

- 可改：`src/input/markdown-command-loader.ts`
- 可改：`src/input/skill-commands.ts`
- 新增：`src/input/agent-loader.ts`
- 可改：`tests/input/markdown-command-loader.test.ts`
- 可改：`tests/input/skill-commands.test.ts`
- 新增：`tests/input/agent-loader.test.ts`

**任务：**

- [ ] 兼容加载 `.claude/commands/**/*.md` 和 `~/.claude/commands/**/*.md`。
- [ ] 子目录命令用冒号命名，例如 `.claude/commands/git/review.md` 注册为 `/git:review`。
- [ ] 支持 `$1`、`$2`、`$ARGUMENTS` 的最小参数替换。
- [ ] 兼容读取 `.claude/agents/*.md`，并在 `/agents` 中展示。

**验收命令：**

```bash
npm test -- tests/input/markdown-command-loader.test.ts tests/input/skill-commands.test.ts tests/input/agent-loader.test.ts
npx eslint src/input tests/input/markdown-command-loader.test.ts tests/input/skill-commands.test.ts tests/input/agent-loader.test.ts
git diff --check
```

---

## Worker F：回滚与权限交互入口

**分支/worktree：** `codex/pico-cc-rewind-approval` / `.worktrees/pico-cc-rewind-approval`

**写入范围：**

- 新增：`src/tui/rewind-selector.tsx`
- 新增：`src/tui/approval-panel.tsx`
- 新增：`src/tui/diff-preview.tsx`
- 可改：`src/input/pico-command-registry.ts`
- 可改：`src/cli/run-agent.ts`
- 新增：`tests/tui/rewind-selector.test.tsx`
- 新增：`tests/tui/approval-panel.test.tsx`
- 新增：`tests/tui/diff-preview.test.tsx`

**任务：**

- [ ] `/snapshots` 展示当前 session 可回滚点。
- [ ] `/rewind` 与 `/undo` 接到既有文件历史能力，先做文本交互，不做复杂弹窗。
- [ ] ApprovalPanel 展示工具名、命令/路径、允许一次/本 session/拒绝/修改。
- [ ] DiffPreview 复用现有 diff 字符串，做最小高亮和截断。

**验收命令：**

```bash
npm test -- tests/tui/rewind-selector.test.tsx tests/tui/approval-panel.test.tsx tests/tui/diff-preview.test.tsx tests/input/pico-command-registry.test.ts
npx eslint src/tui src/input tests/tui/rewind-selector.test.tsx tests/tui/approval-panel.test.tsx tests/tui/diff-preview.test.tsx
git diff --check
```

---

## 集成顺序

- [x] 合并 Worker A：先稳定 session id 和启动语义。
- [ ] 合并 Worker D：在稳定 session 语义上接入模型/思考状态。
- [ ] 合并 Worker E：接入 Claude commands/agents 资源。
- [x] 合并 Worker B：接入外壳与状态区。
- [ ] 合并 Worker C：接入输入编辑体验。
- [ ] 合并 Worker F：接入 rewind/approval UI。

---

## 集成测试任务

**验证子代理：** 最后单独启动，不参与实现，只做验证和问题定位。

- [ ] 运行目标单元测试。
- [ ] 运行 lint。
- [ ] 运行 `git diff --check`。
- [ ] 用 `.env` 启动真实 TUI 冒烟：`npm run dev -- --prompt /status`、`/model`、`/help`。
- [ ] 验证默认 session、新建 session、`--continue`、`--resume` 行为。
- [ ] 验证 TUI 不再重复渲染用户输入框。

**最终验收命令：**

```bash
npm test -- tests/input tests/tui tests/cli-run-agent.test.ts
npx eslint src/input src/tui src/cli tests/input tests/tui tests/cli-run-agent.test.ts
git diff --check
npm run dev -- --prompt /status
```
