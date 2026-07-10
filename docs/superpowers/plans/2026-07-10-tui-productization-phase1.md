# Pico TUI 产品化第一阶段实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 Pico TUI 的运行时真实性、焦点和滚动问题，并交付 Claude/Kimi 风格的基础产品外壳与可信命令入口。

**架构：** 保留现有 Ink/React、CommandRegistry 和 AgentEngine，只补一条 AbortSignal 链、一个顶层焦点所有权规则和一份统一 transcript 行模型。运行设置继续存放在 SessionSettings，但 Slash 命令与 runAgent 必须读取同一对象。

**技术栈：** TypeScript 5.9、React 19、Ink 7、Vitest 4、现有 AgentEngine/Session/CommandRegistry。

---

## 文件结构

- `src/cli/run-agent.ts`：接收中止信号和 TUI 复用的运行时依赖。
- `src/engine/loop.ts`：在 provider、重试和工具批次边界响应中止。
- `src/tui/repl.tsx`：管理每轮 AbortController、真实设置和 dialog 生命周期。
- `src/tui/app.tsx`：唯一焦点所有者、auto-follow 和产品外壳。
- `src/tui/tui-reporter.ts`：不可变条目更新和结构化错误。
- `src/tui/transcript-layout.ts`：统一工具聚合后的行高与 Unicode 显示宽度。
- `src/tui/message-list.tsx`：消费统一 display entries 和视觉行切片。
- `src/input/command-registry.ts`：命令类别、来源、可用状态和参数补全元数据。
- `src/input/markdown-command-loader.ts`：收敛 Markdown 命令扫描范围。
- `src/input/pico-command-registry.ts`：接通 Plan/Permission 并暴露真实运行状态。
- `src/cli/main.ts`：补齐 session 启动参数。
- `src/tui/logo-panel.tsx`、`src/tui/status-bar.tsx`：欢迎页与状态信息去重。
- `tests/e2e/tui-real-llm-e2e.test.ts`：真实模型的中断、审批和工具流程。

### 任务 1：真实中断链路

**文件：**
- 修改：`src/cli/run-agent.ts`
- 修改：`src/engine/loop.ts`
- 修改：`src/tui/repl.tsx`
- 测试：`tests/cli-run-agent.test.ts`
- 测试：`tests/loop.test.ts`
- 测试：`tests/tui/repl-input-routing.test.tsx`

- [x] **步骤 1：编写失败测试**

新增断言：`runAgentFromCli` 将 `signal` 传给 Engine；已 abort 的 run 不追加 assistant 成功消息；TUI interrupt 会调用当前 controller 的 `abort()`。

```ts
const controller = new AbortController();
controller.abort(new DOMException("interrupted", "AbortError"));
await expect(runAgentFromCli(options, { signal: controller.signal })).rejects.toMatchObject({
  name: "AbortError",
});
```

- [x] **步骤 2：运行测试并确认红灯**

运行：`npx vitest run tests/cli-run-agent.test.ts tests/loop.test.ts tests/tui/repl-input-routing.test.tsx`

预期：类型或断言失败，因为依赖对象尚不接受 `signal`，TUI 也没有当前 AbortController。

- [ ] **步骤 3：实现最小中止链路**

为 `RunAgentCliDependencies` 增加 `signal?: AbortSignal`；`AgentEngine.run` 增加可选 signal；provider generate、retry 和 `ToolScheduler` 使用该 signal；TUI 每轮创建 controller，`onInterrupt` 先 abort 再清队列。

- [ ] **步骤 4：运行聚焦测试**

运行：`npx vitest run tests/cli-run-agent.test.ts tests/loop.test.ts tests/tui/repl-input-routing.test.tsx`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/cli/run-agent.ts src/engine/loop.ts src/tui/repl.tsx tests/cli-run-agent.test.ts tests/loop.test.ts tests/tui/repl-input-routing.test.tsx
git commit -m "fix(tui): 接通真实中断链路"
```

### 任务 2：焦点仲裁与审批状态更新

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/repl.tsx`
- 修改：`src/tui/approval-panel.tsx`
- 修改：`src/tui/tool-card.tsx`
- 修改：`src/tui/tui-reporter.ts`
- 测试：`tests/tui/app.test.tsx`
- 测试：`tests/tui/approval-panel.test.tsx`
- 测试：`tests/tui/tui-reporter.test.ts`

- [ ] **步骤 1：编写失败测试**

覆盖审批期间 InputBox 不接收普通字符、ToolCard 不响应 `e`、审批从 running 更新到 done 时返回新对象。

```ts
expect(createApprovalDialogRequest(notice).layer).toBe("modal");
expect(nextEntries[toolIndex]).not.toBe(previousEntries[toolIndex]);
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npx vitest run tests/tui/app.test.tsx tests/tui/approval-panel.test.tsx tests/tui/tui-reporter.test.ts`

预期：现有 approval 是 overlay，reporter 原地修改工具条目。

- [ ] **步骤 3：实现最小焦点规则**

审批仍以内联样式渲染，但 dialog layer 改为 modal；`useInput` 使用 `isActive` 或由 App 顶层分发；工具卡不再自行监听全局 `e`。Reporter 用对象替换更新工具状态。

- [ ] **步骤 4：运行聚焦测试**

运行：`npx vitest run tests/tui/app.test.tsx tests/tui/approval-panel.test.tsx tests/tui/tui-reporter.test.ts`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/tui/app.tsx src/tui/repl.tsx src/tui/approval-panel.tsx src/tui/tool-card.tsx src/tui/tui-reporter.ts tests/tui
git commit -m "fix(tui): 统一审批与输入焦点"
```

### 任务 3：统一 transcript 行模型

**文件：**
- 创建：`src/tui/transcript-layout.ts`
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/message-list.tsx`
- 修改：`src/tui/tool-grouping.ts`
- 测试：`tests/tui/transcript-layout.test.ts`
- 测试：`tests/tui/message-list.test.ts`
- 测试：`tests/tui/app.test.tsx`

- [ ] **步骤 1：编写失败测试**

覆盖中文双宽、Emoji 字素、聚合工具后的总行数、展开工具行高和离开底部后的新消息计数。

```ts
expect(terminalWidth("你好")).toBe(4);
expect(visualRows("你好", 4)).toEqual(["你好"]);
expect(buildTranscriptLayout(thirtyTools).entries).toHaveLength(1);
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npx vitest run tests/tui/transcript-layout.test.ts tests/tui/message-list.test.ts tests/tui/app.test.tsx`

预期：模块不存在或现有 `string.length` 断言失败。

- [ ] **步骤 3：实现统一布局**

在 `transcript-layout.ts` 中先聚合工具，再生成每条显示行数和总行数。使用字素分割与终端宽度计算，MessageList 和 App 均消费同一结果。普通 Up/Down 不再控制 transcript。

- [ ] **步骤 4：运行聚焦测试**

运行：`npx vitest run tests/tui/transcript-layout.test.ts tests/tui/message-list.test.ts tests/tui/app.test.tsx`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/tui/transcript-layout.ts src/tui/app.tsx src/tui/message-list.tsx src/tui/tool-grouping.ts tests/tui
git commit -m "fix(tui): 修正长会话与中文滚动"
```

### 任务 4：命令真实性与 Session 启动语义

**文件：**
- 修改：`src/tui/repl.tsx`
- 修改：`src/cli/main.ts`
- 修改：`src/cli/run-agent.ts`
- 修改：`src/input/session-settings.ts`
- 修改：`src/input/pico-command-registry.ts`
- 修改：`src/approval/manager.ts`
- 测试：`tests/input/pico-command-registry.test.ts`
- 测试：`tests/cli/session-resolver.test.ts`
- 测试：`tests/cli-run-agent.test.ts`

- [ ] **步骤 1：编写失败测试**

覆盖 `/mode plan` 下一轮传入 `planMode: true`，`/permissions yolo` 更新实际 approval policy，以及 CLI 识别 `--session`、`--continue`、`--fork`。

```ts
expect(capturedOptions.planMode).toBe(true);
expect(globalApprovalManager.isYoloMode(sessionId)).toBe(true);
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npx vitest run tests/input/pico-command-registry.test.ts tests/cli/session-resolver.test.ts tests/cli-run-agent.test.ts`

预期：TUI 当前未传 planMode，CLI 参数未注册。

- [x] **步骤 3：接通真实设置**

TUI 每次 run 从同一 `SessionSettings` 读取 mode/permission；Plan 映射到 `planMode`；yolo/auto/default 映射到 ApprovalManager；main.ts 注册已有 resolver 支持的 session 参数。

- [x] **步骤 4：运行聚焦测试**

运行：`npx vitest run tests/input/pico-command-registry.test.ts tests/cli/session-resolver.test.ts tests/cli-run-agent.test.ts`

预期：PASS。

结果：`npm test -- tests/input/pico-command-registry.test.ts tests/cli-session-resolver.test.ts tests/cli-run-agent.test.ts` 72 个测试通过；`npm run typecheck`、`npm run lint`、`git diff --check` 通过。

- [x] **步骤 5：提交**

```bash
git add src/tui/repl.tsx src/cli/main.ts src/cli/run-agent.ts src/input/session-settings.ts src/input/pico-command-registry.ts src/approval/manager.ts tests
git commit -m "fix(cli): 接通模式权限与会话参数"
```

### 任务 5：命令目录与发现体验

**文件：**
- 修改：`src/input/command-registry.ts`
- 修改：`src/input/markdown-command-loader.ts`
- 修改：`src/input/slash-argument-hints.ts`
- 修改：`src/tui/input-controller.ts`
- 修改：`src/tui/suggestions.tsx`
- 修改：`src/tui/help-panel.tsx`
- 测试：`tests/input/command-registry.test.ts`
- 测试：`tests/input/markdown-command-loader.test.ts`
- 测试：`tests/tui/input-controller.test.ts`
- 测试：`tests/tui/suggestions.test.tsx`

- [ ] **步骤 1：编写失败测试**

覆盖 command category/source/availability、忽略非 command Markdown 目录、控制器保留全部候选、UI 窗口随 selectedIndex 滚动。

```ts
expect(commands.some((item) => item.name.includes("references"))).toBe(false);
expect(controller.getSuggestions()).toHaveLength(20);
expect(renderedWindow).toContain("command-12");
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npx vitest run tests/input/command-registry.test.ts tests/input/markdown-command-loader.test.ts tests/tui/input-controller.test.ts tests/tui/suggestions.test.tsx`

预期：现有 controller 在数据层截断为 5，Markdown loader 递归接受全部 `.md`。

- [ ] **步骤 3：实现最小命令目录**

扩充现有 descriptor，不新增第二个注册表。扫描器跳过非命令目录；数据层保留完整候选，Suggestions 只渲染固定窗口；HelpPanel 使用相同元数据。

- [ ] **步骤 4：运行聚焦测试**

运行：`npx vitest run tests/input/command-registry.test.ts tests/input/markdown-command-loader.test.ts tests/tui/input-controller.test.ts tests/tui/suggestions.test.tsx`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/input src/tui/input-controller.ts src/tui/suggestions.tsx src/tui/help-panel.tsx tests/input tests/tui
git commit -m "feat(tui): 统一命令发现与补全"
```

### 任务 6：Logo、状态行和结构化错误

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/message-list.tsx`
- 修改：`src/tui/logo-panel.tsx`
- 修改：`src/tui/status-bar.tsx`
- 修改：`src/tui/tui-reporter.ts`
- 修改：`src/tui/message-row.tsx`
- 测试：`tests/tui/logo-panel.test.tsx`
- 测试：`tests/tui/status-bar.test.tsx`
- 测试：`tests/tui/message-list.test.ts`
- 测试：`tests/tui/message-row.test.tsx`

- [ ] **步骤 1：编写失败测试**

Logo 只作为 transcript 首项；状态行不重复 cwd/model；窄终端降级；错误条目按 kind 渲染而非中文前缀。

```ts
expect(rendered.match(/pico/g)).toHaveLength(1);
expect(status).toContain("running");
expect(errorEntry.kind).toBe("error");
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npx vitest run tests/tui/logo-panel.test.tsx tests/tui/status-bar.test.tsx tests/tui/message-list.test.ts tests/tui/message-row.test.tsx`

预期：Logo 仍是固定 header，TuiEntry 没有 error kind。

- [ ] **步骤 3：实现产品外壳**

将 LogoPanel 放入 transcript 开头，移除固定顶部重复信息；状态行展示运行阶段、模式、权限和任务摘要；新增结构化 error entry 和对应渲染。

- [ ] **步骤 4：运行聚焦测试**

运行：`npx vitest run tests/tui/logo-panel.test.tsx tests/tui/status-bar.test.tsx tests/tui/message-list.test.ts tests/tui/message-row.test.tsx`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/tui tests/tui
git commit -m "feat(tui): 完成 Pico 产品外壳"
```

### 任务 7：集成验证与真实模型验收

**文件：**
- 创建或修改：`tests/e2e/tui-real-llm-e2e.test.ts`
- 修改：`ROADMAP.md`

- [ ] **步骤 1：增加真实模型 E2E**

用 `.env` 中真实 provider 配置验证：普通问候不乱调工具、写入触发审批、中断能收口、长回复仍可继续操作。

- [ ] **步骤 2：运行质量检查**

```bash
npm run typecheck
npm run lint
npm test
npm run smoke:tui
RUN_LLM_E2E=1 npm run test:e2e -- tests/e2e/tui-real-llm-e2e.test.ts
```

预期：全部退出码为 0；真实模型测试没有打印密钥。

- [ ] **步骤 3：更新 ROADMAP**

新增“阶段 7：TUI 产品化”，逐项记录本阶段完成状态、测试数量和真实模型验证结果。

- [ ] **步骤 4：提交**

```bash
git add tests/e2e/tui-real-llm-e2e.test.ts ROADMAP.md
git commit -m "test(tui): 补齐产品化真实模型验收"
```

## 计划自检

- 规格覆盖：中断、焦点、滚动、Logo、状态、命令真实性和发现均有对应任务。
- 类型一致性：统一使用 `AbortSignal`、`SessionSettings`、现有 `DialogRequest` 和 `SlashCommand`。
- 范围控制：Plugins/Goal/Tasks 的完整管理面板属于阶段 2，本计划只为其建立可信命令目录和运行时基础。
- 无占位实现：每个任务均给出文件、失败测试、聚焦命令和提交边界。
