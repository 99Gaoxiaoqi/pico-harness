# Pico TUI Slash Command 与 @ Mention 实现计划

> **面向实现子代理：** 本计划用于并行 worktree 开发。每个任务必须遵守指定写入范围，不要改动其他 worker 的文件；不要回滚他人的修改。实现时优先 TDD，小步验证，完成后报告变更文件、测试命令和遗留风险。

**目标：** 给 Pico TUI 增加 Claude Code 风格的 `/` 命令、`@` 引用、skills 显示/调用和输入候选能力。

**架构：** 新增 `src/input/` 输入处理层，在 TUI/CLI 入口进入 engine 前完成 slash command 与 mention 解析。保持 `src/schema/message.ts` 不变：本地命令不进模型，prompt 命令展开为文本，mention 解析为受限上下文附件后拼入 prompt。

**技术栈：** TypeScript + Ink + Vitest。优先复用 `SkillLoader`、`ReadFileTool`/文件安全边界、现有 TUI `InputBox`/`TuiReporter`。

---

## 总体边界

### In

- `/help`、`/clear`、`/exit`、`/status`、`/model`、`/tools`、`/skills`、`/skill <name>`、`/agents`。
- `/` 候选面板：最多 5 条，支持上下选择、Tab 补全、Enter 执行。
- `@file`、`@dir`、`@file#L10`、`@file#L10-20`、`@"path with spaces"`、`@skill:name`、`@agent:name`。
- `.pico/commands/*.md` 与 `~/.pico/commands/*.md` 的 prompt command 加载。

### Out

- 暂不做 `local-jsx` 弹窗命令。
- 暂不做 MCP resource mention。
- 暂不改 `Message` schema。
- 暂不实现完整 `/resume` 交互列表、插件市场、MCP command、语音、IDE at mention。

## 子代理并行分配

## 并行执行状态

- [x] Worker A / Slash Command 核心：完成于 `.worktrees/pico-input-commands`，分支 `codex/pico-input-commands`，提交 `c2eb236`。状态 `DONE_WITH_CONCERNS`，concern 为计划文件在该 worktree 基点不存在，按调度消息实现；新增 `src/input` 命令核心与 12 个测试。
- [x] Worker B / @ Mention 与附件解析：完成于 `.worktrees/pico-input-mentions`，分支 `codex/pico-input-mentions`。状态 `DONE_WITH_CONCERNS`，concern 为全量 typecheck 既有债务；新增 mention、附件、文件候选模块与 11 个测试。
- [x] Worker C / Skills 与 Markdown Commands：完成于 `.worktrees/pico-skill-commands`，分支 `codex/pico-skill-commands`。状态 `DONE_WITH_CONCERNS`，concern 为全量 typecheck 既有债务；新增 skill command、markdown command loader，目标测试 44 个通过。
- [x] Worker D / TUI 候选面板与 InputBox 交互：完成于 `.worktrees/pico-tui-suggestions`，分支 `codex/pico-tui-suggestions`。状态 `DONE_WITH_CONCERNS`，concern 为 `.test.tsx` 默认不被当前 Vitest include 收集，以及 out-of-scope `repl.tsx` lint 基线；候选 UI 目标测试通过。
- [x] Worker E / TUI/CLI 输入处理集成：完成于 `.worktrees/pico-input-integration`，分支 `codex/pico-input-integration`。状态 `DONE_WITH_CONCERNS`，concern 为临时兼容 `processUserInput` 需在集成 Worker A 后替换、`.test.tsx` 收集问题、既有 typecheck 债务。

**下一步集成顺序：** A → C → B → E → D。集成 D/E 前需要统一 `.tsx` 测试策略：要么改名为 `.test.ts`，要么扩展 `vitest.config.ts` include。

### Worker A：Slash Command 核心

**建议分支/worktree：** `codex/pico-input-commands`

**写入范围：**
- 创建：`src/input/types.ts`
- 创建：`src/input/slash-parser.ts`
- 创建：`src/input/command-registry.ts`
- 创建：`src/input/builtin-commands.ts`
- 创建：`src/input/process-user-input.ts`
- 创建：`tests/input/slash-parser.test.ts`
- 创建：`tests/input/command-registry.test.ts`
- 创建：`tests/input/process-user-input.test.ts`

**职责：**
- 定义 `InputProcessResult`、`SlashCommand`、`LocalCommandResult`、`PromptCommandResult`。
- 解析 `/name args`，支持 aliases。
- 实现内置命令的纯函数骨架。
- `/help` 输出命令清单。
- `/model`、`/status` 返回只读信息占位，具体数据由集成层传入 context。
- `/clear`、`/exit` 返回结构化 local action，不直接操作 TUI。

**验收：**
- 普通输入返回 `{ kind: "prompt" }`。
- `/help` 返回 `{ kind: "local", action: "display" }`。
- `/clear` 返回 `{ kind: "local", action: "clear" }`。
- 未知 `/xxx` 返回清晰错误，不调用模型。

### Worker B：@ Mention 与附件解析

**建议分支/worktree：** `codex/pico-input-mentions`

**写入范围：**
- 创建：`src/input/mentions.ts`
- 创建：`src/input/context-attachments.ts`
- 创建：`src/input/file-suggestions.ts`
- 创建：`tests/input/mentions.test.ts`
- 创建：`tests/input/context-attachments.test.ts`
- 创建：`tests/input/file-suggestions.test.ts`

**职责：**
- 解析 `@file`、`@dir`、`@file#Lx`、`@file#Lx-y`、quoted path。
- 解析 `@skill:name` 和 `@agent:name`。
- 解析结果转为 `ContextAttachment`，第一版用文本块注入 prompt。
- 文件读取限制：默认最多 200 行或 20KB；目录最多 100 项。
- 文件候选：优先 `git ls-files`，失败回退 `rg --files`，再失败回退 Node 目录扫描。

**验收：**
- 多个 mention 与中文文本混排能正确识别。
- 行号范围越界时安全截断。
- 大文件不会完整注入。
- 候选函数在非 git 目录也可工作。

### Worker C：Skills 与 Markdown Commands

**建议分支/worktree：** `codex/pico-skill-commands`

**写入范围：**
- 创建：`src/input/markdown-command-loader.ts`
- 创建：`src/input/skill-commands.ts`
- 创建：`tests/input/markdown-command-loader.test.ts`
- 创建：`tests/input/skill-commands.test.ts`
- 可修改：`src/context/skill.ts`，仅允许增加不破坏兼容的 helper。

**职责：**
- 复用 `SkillLoader.listSummaries()` 和 `SkillLoader.viewBody()`。
- `/skills` 展示所有 skill 名称和 description。
- `/skill <name>` 展示完整正文。
- 将 `.claw/skills/**/SKILL.md` 可选投影为 `/skill-name` prompt command。
- 加载 `.pico/commands/*.md` 与 `~/.pico/commands/*.md`。
- markdown command frontmatter 第一版支持 `description`、`argument-hint`、`allowed-tools`、`model`。

**验收：**
- 临时 `.claw/skills/demo/SKILL.md` 能被 `/skills` 和 `/skill demo` 读取。
- `.pico/commands/review.md` 能注册为 `/review` prompt command。
- 重名命令按优先级处理：项目 > 用户 > skill projection > builtin。

### Worker D：TUI 候选面板与 InputBox 交互

**建议分支/worktree：** `codex/pico-tui-suggestions`

**写入范围：**
- 创建：`src/tui/suggestions.tsx`
- 创建：`src/tui/input-controller.ts`
- 修改：`src/tui/input-box.tsx`
- 创建或扩展：`tests/tui/input-box.test.tsx`
- 创建：`tests/tui/suggestions.test.tsx`

**职责：**
- 给 `InputBox` 增加可注入候选源：slash command suggestions 与 file mention suggestions。
- 输入 `/` 时展示命令候选；输入 `@` 时展示文件候选。
- 支持 ↑/↓ 选择、Tab 补全、Enter 执行当前输入。
- 候选 UI 风格参考 Claude Code：左侧 `/name` 或 `@path`，右侧描述，最多 5 项。
- 保留现有历史输入、多行输入、disabled 行为。

**验收：**
- 无候选时行为与现有 TUI 一致。
- `/sk` + Tab 能补全成 `/skills `。
- `@src/t` + Tab 能补全文件。
- 运行中 disabled 时不响应输入和候选。

### Worker E：TUI/CLI 集成

**建议分支/worktree：** `codex/pico-input-integration`

**写入范围：**
- 修改：`src/tui/repl.tsx`
- 修改：`src/tui/tui-reporter.ts`
- 修改：`src/cli/run-agent.ts`
- 修改：`src/cli/main.ts`
- 创建：`tests/tui/repl-input-routing.test.tsx`
- 扩展：`tests/cli-run-agent.test.ts`

**职责：**
- 在 TUI `handleSubmit` 中调用 `processUserInput()`。
- 本地 display 命令直接追加 TUI 系统消息，不调用模型。
- `/clear` 清空当前 TUI entries。
- `/exit` 退出 TUI。
- prompt command 和 mention-expanded prompt 继续走 `runAgentFromCli`。
- CLI 单轮模式也复用同一输入处理层：本地命令写 stdout，prompt 命令调用模型。

**验收：**
- `/help` 不调用 provider。
- `/clear` 清屏但不破坏 session。
- 普通 prompt 保持原行为。
- mention 展开后 provider 收到包含附件上下文的 prompt。

## 集成顺序

1. 合并 Worker A：命令类型与处理核心。
2. 合并 Worker C：skills / markdown command 接入命令注册表。
3. 合并 Worker B：mention 解析与附件注入。
4. 合并 Worker E：TUI/CLI 入口接入输入处理。
5. 合并 Worker D：候选 UI。若 D 先完成，集成时按 A/B/C 的最终 API 调整 imports。

## 全局验证

每个 worker 至少运行：

```bash
npm test -- tests/input tests/tui
npx eslint src/input src/tui tests/input tests/tui
git diff --check
```

最终集成后运行：

```bash
npm test -- tests/input tests/tui tests/cli-run-agent.test.ts
npx eslint src/input src/tui src/cli tests/input tests/tui tests/cli-run-agent.test.ts
npm run typecheck
```

注意：当前仓库全量 `npm run typecheck` 已存在非 TUI 类型债务；最终报告需要区分新增错误与既有错误。

## 风险与约束

- 当前主工作区已有未提交 TUI 修改；worker 不得回滚这些修改。
- `InputBox` 现为追加式输入，没有完整光标模型；第一版候选只处理末尾 token。
- mention 不能绕过文件安全边界；大文件必须截断。
- 不要复制 Claude Code 源码实现，只复刻机制和交互。
