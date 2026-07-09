# Claude Code Runtime Parity 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Pico 从“Claude Code 风格 TUI”推进到“Claude Code 风格运行时”，优先补齐任务模型、按键系统、长会话性能、权限仲裁、文件索引、插件生命周期和上下文恢复能力。

**架构：** 阶段 6 采用小核心、多适配器方案：先建立稳定的运行时内核（Task Runtime / Keybinding / Permission Arbiter / File Index），再把现有 TUI、tools、approval、input 模块逐步接入。每个子系统独立测试，最后通过 TUI smoke 和全量测试做集成门禁。

**技术栈：** TypeScript、Vitest、Ink/React TUI、Node.js fs/child_process、现有 pico engine/session/tool abstractions。

---

## Claude Code 源码对照

- Task Runtime：`/Users/anxuan/workspace/claude-code-main/src/Task.ts`
- Keybinding：`/Users/anxuan/workspace/claude-code-main/src/keybindings/defaultBindings.ts`
- Keybinding Schema：`/Users/anxuan/workspace/claude-code-main/src/keybindings/schema.ts`
- Virtual Transcript：`/Users/anxuan/workspace/claude-code-main/src/hooks/useVirtualScroll.ts`
- Permission Arbiter：`/Users/anxuan/workspace/claude-code-main/src/hooks/toolPermission/handlers/interactiveHandler.ts`
- File Suggestions：`/Users/anxuan/workspace/claude-code-main/src/hooks/fileSuggestions.ts`
- Plugin Lifecycle：`/Users/anxuan/workspace/claude-code-main/src/services/plugins/pluginOperations.ts`
- Compact / Memory：`/Users/anxuan/workspace/claude-code-main/src/services/compact/compact.ts`
- Session Memory：`/Users/anxuan/workspace/claude-code-main/src/services/SessionMemory/sessionMemory.ts`

## 文件结构

- 创建：`src/tasks/task-types.ts`，统一 Task 类型、状态、ID 前缀和 snapshot。
- 创建：`src/tasks/task-registry.ts`，统一注册、更新、订阅、终止任务。
- 修改：`src/tools/background-manager.ts`，接入统一 TaskRegistry。
- 修改：`src/tools/delegation-manager.ts`，把 subagent/delegation 暴露为 task。
- 创建：`tests/tasks/task-registry.test.ts`，覆盖任务生命周期。
- 创建：`src/tui/keybindings/schema.ts`，定义 keybinding 配置类型。
- 创建：`src/tui/keybindings/defaults.ts`，内置上下文绑定。
- 创建：`src/tui/keybindings/resolver.ts`，解析 key event 到 action。
- 修改：`src/tui/input-controller.ts`，把硬编码按键迁移到 resolver。
- 创建：`tests/tui/keybindings.test.ts`，覆盖上下文、解绑、slash command 绑定。
- 创建：`src/tui/virtual-transcript.ts`，计算可见消息窗口与 spacer。
- 修改：`src/tui/message-list.tsx`，接入可选虚拟渲染。
- 创建：`tests/tui/virtual-transcript.test.ts`，覆盖长列表窗口计算。
- 创建：`src/approval/arbiter.ts`，统一本地审批、hook、channel、classifier 决策竞速。
- 修改：`src/approval/manager.ts`，保留现有审批管理，作为 arbiter 的 local source。
- 创建：`tests/approval/arbiter.test.ts`，覆盖先到先赢、abort 清理、超时。
- 创建：`src/input/file-index.ts`，后台文件索引、缓存、ignore、git/ripgrep 组合。
- 修改：`src/input/file-suggestions.ts`，优先使用 FileIndex。
- 创建：`tests/input/file-index.test.ts`，覆盖缓存刷新与查询。
- 创建：`src/plugins/plugin-types.ts`，定义 plugin manifest、scope、operation result。
- 创建：`src/plugins/plugin-manager.ts`，实现 install/enable/disable/list 的本地最小闭环。
- 创建：`tests/plugins/plugin-manager.test.ts`，覆盖插件生命周期。
- 修改：`src/context/compactor.ts`，增加 compact 失败降级与压缩后恢复挂钩。
- 创建：`tests/context/compactor-recovery.test.ts`，覆盖失败兜底。

## 执行批次

### 任务 0：测试基线分诊

**文件：**
- 修改：`ROADMAP.md`
- 可能修改：`tests/session-persistence.test.ts`
- 可能修改：`tests/tracker.test.ts`
- 可能修改：`tests/engine/reporter-ansi.test.ts`

- [ ] **步骤 1：复现当前全量测试失败**

运行：`npm test`
预期：记录失败文件和失败原因；网络类 e2e 可标为环境问题，本地确定性失败必须修复。

- [ ] **步骤 2：拆出本地确定性失败**

运行：`npm test tests/session-persistence.test.ts tests/tracker.test.ts tests/engine/reporter-ansi.test.ts`
预期：只复现本地失败，方便后续 feature 分支不背脏基线。

- [ ] **步骤 3：按 TDD 修复本地失败**

最小目标：
- session persistence 测试断言应适配当前 JSONL meta/undo/summary 记录，或实现过滤逻辑。
- tracker 测试应稳定捕获 reporter 输出。
- ANSI 测试应明确 color 开关来源。

- [ ] **步骤 4：验证本地基线**

运行：`npm test tests/session-persistence.test.ts tests/tracker.test.ts tests/engine/reporter-ansi.test.ts`
预期：本地确定性失败归零。

- [ ] **步骤 5：Commit**

```bash
git add ROADMAP.md tests/session-persistence.test.ts tests/tracker.test.ts tests/engine/reporter-ansi.test.ts
git commit -m "fix(test): 修复阶段六前置测试基线"
```

### 任务 1：统一 Task Runtime

**文件：**
- 创建：`src/tasks/task-types.ts`
- 创建：`src/tasks/task-registry.ts`
- 修改：`src/tools/background-manager.ts`
- 修改：`src/tools/delegation-manager.ts`
- 测试：`tests/tasks/task-registry.test.ts`

- [ ] **步骤 1：编写失败测试**

测试行为：
- `createTask("local_bash")` 生成 `b_` 前缀 ID。
- task 初始状态为 `pending`。
- `start/complete/fail/kill` 更新状态和时间。
- registry snapshot 按 startTime 稳定排序。

运行：`npm test tests/tasks/task-registry.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现最小 Task 类型与 Registry**

实现：
- `TaskType = "local_bash" | "local_agent" | "remote_agent" | "local_workflow" | "monitor_mcp"`
- `TaskStatus = "pending" | "running" | "completed" | "failed" | "killed"`
- `generateTaskId(type)` 使用 Claude Code 同类前缀。
- `TaskRegistry` 提供 `create/start/complete/fail/kill/list/get/subscribe`。

- [ ] **步骤 3：接入 background manager**

最小接入：
- background bash 创建 `local_bash` task。
- 完成、失败、停止时同步 task 状态。
- 现有 `task_list/task_output/task_stop` 外部行为保持不变。

- [ ] **步骤 4：接入 delegation manager**

最小接入：
- delegate/subagent 创建 `local_agent` task。
- snapshot 中包含 description/toolUseId/outputFile 可选字段。

- [ ] **步骤 5：验证**

运行：
- `npm test tests/tasks/task-registry.test.ts`
- `npm test tests/tools/background-manager.test.ts tests/tools/delegation-manager.test.ts`

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add src/tasks src/tools/background-manager.ts src/tools/delegation-manager.ts tests/tasks tests/tools
git commit -m "feat(task): 引入统一任务运行时"
```

### 任务 2：Keybinding Kernel

**文件：**
- 创建：`src/tui/keybindings/schema.ts`
- 创建：`src/tui/keybindings/defaults.ts`
- 创建：`src/tui/keybindings/resolver.ts`
- 修改：`src/tui/input-controller.ts`
- 测试：`tests/tui/keybindings.test.ts`

- [ ] **步骤 1：编写失败测试**

测试行为：
- Chat 上下文 `ctrl+a` 解析为 `cursor:start`。
- Autocomplete 上下文 `tab` 解析为 `suggestion:accept`。
- 用户绑定 `command:/model` 解析为 slash command action。
- `null` 绑定可禁用默认快捷键。

运行：`npm test tests/tui/keybindings.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 schema/defaults/resolver**

实现最小 API：
- `KeybindingContext`
- `KeybindingAction`
- `KeybindingMap`
- `resolveKeybinding(event, context, userBindings?)`

- [ ] **步骤 3：迁移 input-controller**

迁移范围：
- 保留现有 reducer 输入输出 API。
- 内部先用 resolver 判断特殊动作，再落到 printable input。
- 不改变现有历史、suggestion、multi-line 行为。

- [ ] **步骤 4：验证**

运行：
- `npm test tests/tui/keybindings.test.ts`
- `npm test tests/tui/input-controller.test.ts`

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/keybindings src/tui/input-controller.ts tests/tui
git commit -m "feat(tui): 引入上下文按键绑定内核"
```

### 任务 3：Virtual Transcript

**文件：**
- 创建：`src/tui/virtual-transcript.ts`
- 修改：`src/tui/message-list.tsx`
- 测试：`tests/tui/virtual-transcript.test.ts`

- [ ] **步骤 1：编写失败测试**

测试行为：
- 1000 条消息只返回 viewport 附近窗口。
- overscan 正确扩展窗口。
- 窗口前后 spacer 高度与行高估算一致。
- scrollToBottom 返回最后窗口。

运行：`npm test tests/tui/virtual-transcript.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现纯计算模块**

先不碰 Ink DOM，创建纯函数：
- `computeVirtualTranscript(items, viewportRows, scrollOffset, options)`
- 返回 `{ visibleItems, startIndex, endIndex, topSpacerRows, bottomSpacerRows }`

- [ ] **步骤 3：接入 message-list**

最小接入：
- 小于阈值时走原渲染。
- 超过阈值时渲染 spacer + visible messages。
- 默认阈值 200，避免小 session 行为变化。

- [ ] **步骤 4：验证**

运行：
- `npm test tests/tui/virtual-transcript.test.ts`
- `npm test tests/tui/message-list.test.ts`
- `npm run smoke:tui`

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/virtual-transcript.ts src/tui/message-list.tsx tests/tui
git commit -m "feat(tui): 支持长会话虚拟 transcript"
```

### 任务 4：Permission Arbiter

**文件：**
- 创建：`src/approval/arbiter.ts`
- 修改：`src/approval/manager.ts`
- 测试：`tests/approval/arbiter.test.ts`

- [ ] **步骤 1：编写失败测试**

测试行为：
- 多个 source 并发时，最先 resolve 的 decision 生效。
- loser source 的 cleanup 被调用。
- abort 时所有 source cleanup 被调用并返回 reject。
- timeout 时返回 reject，且 pendingCount 清理。

运行：`npm test tests/approval/arbiter.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 PermissionArbiter**

实现最小 API：
- `racePermissionSources({ sources, signal, timeoutMs })`
- source 返回 `{ promise, cleanup }`
- decision 复用现有 `ApprovalResult`。

- [ ] **步骤 3：接入 ApprovalManager**

接入范围：
- `waitForApproval` 仍可单独使用。
- 新增 local approval source adapter，供后续 hook/channel/classifier 扩展。

- [ ] **步骤 4：验证**

运行：
- `npm test tests/approval/arbiter.test.ts`
- `npm test tests/approval`

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/approval tests/approval
git commit -m "feat(approval): 引入权限决策仲裁器"
```

### 任务 5：File Index

**文件：**
- 创建：`src/input/file-index.ts`
- 修改：`src/input/file-suggestions.ts`
- 测试：`tests/input/file-index.test.ts`

- [ ] **步骤 1：编写失败测试**

测试行为：
- 首次查询构建索引。
- 第二次查询复用缓存。
- `refresh()` 后包含新增文件。
- ignore 目录不进入结果。

运行：`npm test tests/input/file-index.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现 FileIndex**

实现：
- `FileIndex.create({ cwd, commandRunner })`
- `query(text, limit)`
- `refresh()`
- git ls-files 优先，rg --files fallback，scan fallback。

- [ ] **步骤 3：接入 file-suggestions**

兼容：
- `listFileSuggestions(options)` API 不变。
- 未传 index 时保持旧行为。
- TUI 后续可持有长生命周期 index。

- [ ] **步骤 4：验证**

运行：
- `npm test tests/input/file-index.test.ts`
- `npm test tests/input/file-suggestions.test.ts`

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/input/file-index.ts src/input/file-suggestions.ts tests/input
git commit -m "feat(input): 引入文件建议索引缓存"
```

### 任务 6：Plugin Lifecycle MVP

**文件：**
- 创建：`src/plugins/plugin-types.ts`
- 创建：`src/plugins/plugin-manager.ts`
- 测试：`tests/plugins/plugin-manager.test.ts`

- [ ] **步骤 1：编写失败测试**

测试行为：
- 从目录读取 plugin manifest。
- install 到 user/project/local scope。
- enable/disable 修改 settings。
- list 返回已安装和启用状态。

运行：`npm test tests/plugins/plugin-manager.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 2：实现本地 PluginManager**

不做 marketplace 网络安装，先做本地目录生命周期：
- `installFromDirectory(path, scope)`
- `enable(id, scope)`
- `disable(id, scope)`
- `list()`

- [ ] **步骤 3：验证**

运行：`npm test tests/plugins/plugin-manager.test.ts`
预期：全部通过。

- [ ] **步骤 4：Commit**

```bash
git add src/plugins tests/plugins
git commit -m "feat(plugin): 引入本地插件生命周期管理"
```

### 任务 7：Compact Recovery

**文件：**
- 修改：`src/context/compactor.ts`
- 测试：`tests/context/compactor-recovery.test.ts`

- [ ] **步骤 1：编写失败测试**

测试行为：
- summarizer 抛 prompt-too-long 类错误时，compactor 使用更激进字符压缩兜底。
- 压缩后保留最近关键文件/skill/plan 附件恢复入口。

运行：`npm test tests/context/compactor-recovery.test.ts`
预期：FAIL，当前未实现恢复挂钩。

- [ ] **步骤 2：实现失败兜底**

实现：
- 捕获 summarizer 失败。
- 对远期历史按 API round/消息组降级。
- 保持 toolCalls 不删除。

- [ ] **步骤 3：实现恢复挂钩**

最小实现：
- 新增可选 `postCompactRestore?: () => Message[]`。
- compact 完成后追加恢复消息。

- [ ] **步骤 4：验证**

运行：
- `npm test tests/context/compactor-recovery.test.ts`
- `npm test tests/context/compactor.test.ts tests/context/full-compactor.test.ts`

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/context/compactor.ts tests/context
git commit -m "feat(context): 增强压缩失败兜底与恢复"
```

## 集成门禁

- [ ] 目标测试：运行所有新增/修改模块测试。
- [ ] TUI 冒烟：`npm run smoke:tui`。
- [ ] 全量测试：`npm test`。网络 e2e 如果失败，记录具体 endpoint 与错误；本地确定性测试必须通过。
- [ ] ROADMAP：阶段 6 对应任务打勾。
- [ ] 合并：每个 feature 分支 squash 或普通 merge 回 `main`。
- [ ] 推送：`git push origin main`。
