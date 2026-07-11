# pico-harness 进化路线图

> **这份文件是 pico-harness 的持久化开发计划。**
> 每完成一个任务，把 `- [ ]` 改成 `- [x]`。
> 新窗口打开时，先读这个文件了解当前进度。
>
> **当前产品边界：** `pico` → TUI 是唯一公开入口。阶段 1-7 的勾选表示相应能力曾完成交付，不代表历史外壳仍是当前公开 API。REST/WebSocket、ACP、飞书和 one-shot CLI 已退役；Cron/headless、Docker 和 Plugin runtime 不在当前范围。

---

## 📐 开发流程（必须遵守）

### 1. 集成验证

- 后续开发不再新增单元测试；保留既有回归，但不继续扩充内部实现级覆盖
- 一个功能通常只新增一条跨模块成功主链路，确有高风险时在同一场景补关键失败断言
- 在最终代码状态运行最相关的集成测试；跨核心模块时同时完成 typecheck 与 build
- 不为同一行为在多个层级重复验证，也不默认运行无关全量测试

### 2. 小步提交

- 每完成一个功能点就提交一次，**不要堆积一大堆代码**
- 提交信息遵循 Conventional Commits：`feat(scope): 描述` / `fix(scope): 描述`
- scope、subject、body 用中文
- 示例：`feat(provider): 支持 Gemini 流式输出`

### 3. Worktree 并行开发

- 大功能用 worktree 隔离开发，避免互相干扰
- 命名规范：`pico-<阶段号>-<功能名>`，如 `pico-1-streaming`、`pico-1-mcp`
- 完成后合回主分支，删除 worktree

```bash
# 创建 worktree
git worktree add ../pico-1-streaming -b feat/streaming

# 在 worktree 里开发
cd ../pico-1-streaming
# ... 写代码、测试、提交 ...

# 完成后合回
cd ../pico-harness
git merge feat/streaming
git worktree remove ../pico-1-streaming
```

### 4. 进度更新

- 每完成一个任务，**立即**在这个文件里把对应项打勾
- 如果发现新问题或新需求，追加到对应阶段的"补充任务"里
- 每个阶段完成后，在阶段标题后标注完成日期

---

## 阶段 1：基础可用性补齐（P0）

> **目标**：解决"没法用"的问题。流式输出 + Checkpoint + Diff 预览 + Permission + MCP。
>
> **归档说明：** 本阶段的 CLI/飞书条目是历史验收记录；当前对外仅保留 TUI 路径。

### 1.1 流式输出（SSE / Streaming）✅

- [x] `provider/interface.ts` 加 `generateStream()` 方法，返回 AsyncIterable
- [x] `provider/openai.ts` 实现流式（SSE 解析）
- [x] `provider/claude.ts` 实现流式（SSE 解析）
- [x] `engine/reporter.ts` 加 `onTextDelta(delta: string)` 回调
- [x] `engine/loop.ts` 接入流式回调，边接收边输出
- [x] `cli/main.ts` CLI 模式流式打印（TerminalReporter.onTextDelta 输出到 stdout）
- [x] 测试：mock provider 返回流式数据，验证回调顺序（openai 3 个 + claude 9 个测试通过）
- [x] 提交

### 1.2 Checkpoint（git 快照，legacy/manual fallback）✅

- [x] 新建 `safety/checkpoint-manager.ts`
- [x] 在文件变动工具（Write/Edit/Bash 含写）执行前，用 `git stash create` 创建快照
- [x] 每个 turn dedup（同一 turn 多次写操作只快照一次）
- [x] 提供 `rollback(checkpointId)` 方法
- [x] CLI 加 `--rollback <id>` 命令（已由 1.5.8 的 `--rewind` 三轴回滚取代，语义更强）
- [x] 测试：写文件 → 回滚 → 确认内容恢复（8 个测试全通过）
- [x] 提交

### 1.3 Diff 预览 ✅

- [x] `tools/registry-impl.ts` 的 EditFileTool 返回 before/after diff
- [x] WriteFileTool 返回新建文件标记
- [x] `approval/manager.ts` 审批通知附带 diff（`ApprovalNotice.diff` 字段 + `computeApprovalDiff`）
- [x] 飞书审批卡片展示 diff（截断长 diff）
- [x] 测试：edit_file 触发审批 → 卡片含 diff（原 7 个 + 新增 10 个 diff 计算测试通过）
- [x] 提交

### 1.4 细粒度 Permission 系统 ✅

- [x] 重写 `approval/manager.ts` 为 Policy 链模式
- [x] Policy 1：高危命令检测（保留现有正则）
- [x] Policy 2：敏感文件保护（`.env`、`id_rsa`、`credentials`、`.aws/credentials`）
- [x] Policy 3：Git 控制目录保护（`.git/` 写入需审批）
- [x] Policy 4：Plan Mode 守卫（Plan 模式下非计划文件写操作拒绝）
- [x] "approve for session" 记忆（同类操作不再询问）
- [x] 测试：每种 policy 的 allow/deny/ask 场景（40 个测试全通过）
- [x] 提交

### 1.5 MCP 客户端 ✅

- [x] 新建 `mcp/` 目录
- [x] `mcp/stdio-client.ts`：stdio transport 连接 MCP server
- [x] `mcp/http-client.ts`：http/SSE transport
- [x] MCP server 工具自动注册到 ToolRegistry
- [x] 工具名限定（`mcp__<server>__<tool>`）防冲突
- [x] MCP server 配置文件（`mcp.json.example`）
- [x] CLI 加 `--mcp-config <path>` 参数
- [x] 测试：mock MCP server，验证工具注册和调用（22 个测试全通过）
- [x] 提交

---

## 阶段 1.5：文件历史系统（对标 Claude Code）

> **目标**：把 1.2 的 git stash 方案替换为 Claude Code 式的纯 copyFile 备份。
> 不依赖用户项目的 git，文件回滚和对话回滚解耦，三轴可选。

### 1.5.1 数据结构与存储层 ✅

- [x] 新建 `safety/file-history.ts`
- [x] 定义 `FileHistoryBackup`（backupFileName: string | null, version, backupTime）
- [x] 定义 `FileHistorySnapshot`（messageId, trackedFileBackups, timestamp）
- [x] 定义 `FileHistoryState`（snapshots[], trackedFiles: Set, snapshotSequence）
- [x] 备份存储路径：`~/.pico/file-history/{sessionId}/{sha256(path)[:16]}@v{version}`
- [x] `createBackup(filePath, version)`：copyFile + chmod 保留权限
- [x] `resolveBackupPath(fileName)`：解析备份路径
- [x] `getBackupFileName(filePath, version)`：生成 sha256 哈希文件名
- [x] lazy mkdir（99% 命中已有目录，ENOENT 时才 mkdir + 重试）
- [x] 测试：创建备份 → 验证文件内容和权限一致（14 个测试全通过）
- [x] 提交

### 1.5.2 写前备份（trackEdit）✅

- [x] `fileHistoryTrackEdit(state, filePath, messageId)` 函数
- [x] 在 EditTool/WriteTool 执行**前**调用，保存修改前的原始内容（已由 1.5.5 集成）
- [x] 去重：同一文件在同一轮已跟踪则跳过（不覆盖 v1 备份）
- [x] 文件不存在时标记 `backupFileName: null`
- [x] 三阶段设计：Phase 1 读状态 → Phase 2 async 备份 → Phase 3 提交状态
- [x] 测试：写文件前备份 → 验证备份是修改前内容；同文件第二次跳过（5 个测试通过）
- [x] 提交

### 1.5.3 每轮快照（makeSnapshot）✅

- [x] `fileHistoryMakeSnapshot(state, messageId)` 函数
- [x] 每个用户消息结束时调用（已由 1.5.5 集成）
- [x] 遍历所有 trackedFiles，用 `stat` 的 mtime+size 判断是否变化
- [x] 未变 → 复用旧备份（不做 copyFile）
- [x] 变了 → createBackup 新版本
- [x] 文件被删 → 标记 null
- [x] `checkOriginFileChanged(filePath, backupFileName, stats?)`：mtime+size 比较（内联实现）
- [x] 100 个快照上限：滚动窗口，超限时删最老的
- [x] 测试：改文件 → 快照 → 再改 → 快照；未变的文件验证复用（6 个测试通过）
- [x] 提交

### 1.5.4 回滚（rewind）✅

- [x] `fileHistoryRewind(state, messageId)` 函数
- [x] `applySnapshot(state, targetSnapshot)`：遍历所有 trackedFiles（内联实现）
  - null → `unlink` 删除（Agent 新建的文件被撤销）
  - 有变化 → `restoreBackup`（copyFile 从备份恢复）
  - 无变化 → 跳过
- [x] `restoreBackup(filePath, backupFileName)`：copyFile + lazy mkdir（1.5.1 已实现）
- [x] 测试：改 3 个文件 → 回滚 → 验证全部恢复；新建文件回滚后验证删除（5 个测试通过）
- [x] 提交

### 1.5.5 集成到工具系统 ✅

- [x] EditFileTool.execute 前调 `fileHistoryTrackEdit`（通过 preWriteHook）
- [x] WriteFileTool.execute 前调 `fileHistoryTrackEdit`（通过 preWriteHook）
- [x] BashTool：检测 `>` 重定向时备份目标文件
- [x] loop.ts 每轮结束时调 `fileHistoryMakeSnapshot`
- [x] Session 构造时初始化 FileHistoryState
- [x] 测试：端到端——write_file/edit_file → 检查备份自动创建（5 个 e2e 测试通过）
- [x] 提交

### 1.5.6 对话 undo ✅

- [x] Session 新增 `undo(count)` 方法
- [x] 从 history 末尾向前删，跳过 injection（system 消息）
- [x] 遇到 compaction 边界停止
- [x] 截断到第 count 个 user prompt 之前
- [x] 清空 deferredMessages / pendingToolCallIds（已于 3.4 实现，并由 session deferred 测试覆盖）
- [x] JSONL 持久化：追加 undo 记录
- [x] Session 新增 `rewindTo(messageIndex)`：截断到指定位
- [x] 测试：对话 5 轮 → undo(2) → 验证只剩 3 轮；undo 跳过 injection（6 个测试通过）
- [x] 提交

### 1.5.7 三轴选择 ✅

- [x] `rewindCode(messageId)`：只回滚文件，不碰对话
- [x] `rewindConversation(messageIndex)`：只截断对话，不碰文件
- [x] `rewindBoth(messageId, messageIndex)`：两者都回滚
- [x] 回滚对话时生成新 conversationId（fork 语义，保留原历史在磁盘）
- [x] 测试：三轴各自独立 + 组合（3 个测试通过，累计 44）
- [x] 提交

### 1.5.8 历史 CLI 集成 + 替换旧方案 ✅

- 当前等价公开能力已转入 TUI：`/snapshots` 列点，`/rewind` 执行 code / conversation / both 回滚。
- [x] CLI 加 `--rewind` 命令：列出可选快照点
- [x] `--rewind <message-id>`：三轴选择（code / conversation / both）
- [x] `--list-snapshots`：列出所有快照及文件变更统计
- [x] 保留旧的 `safety/checkpoint-manager.ts` 作为 legacy/manual fallback（非公开 TUI 主路径）
- [x] 文档更新：AGENTS.md 和 ROADMAP.md
- [x] 相关测试通过；`npm run typecheck` 已运行并记录既有 tests 类型错误基线
- [x] 提交

---

## 阶段 2：工具生态扩展（P0）

> **目标**：从 4 个工具扩展到"够用的工具集"。

### 2.1 Glob 工具（文件匹配）✅

- [x] 新建 `tools/glob.ts`（GlobTool 独立文件,跨文件工具模式）
- [x] 支持 glob pattern（`**/*.ts`、`src/**/*.test.ts`、`*.{ts,js}`、`[abc]`）
- [x] readOnly + accesses（none）声明
- [x] 测试 + 提交（31 个测试通过）

### 2.2 Grep 工具（ripgrep 封装）✅

- [x] 新建 `tools/grep.ts`（GrepTool 独立文件）
- [x] 封装 ripgrep（如未安装则降级到 Node.js 实现）
- [x] 支持 -i / -n / --type 等常用参数（case_sensitive / line_number / glob）
- [x] readOnly + accesses（none）声明
- [x] 测试 + 提交（23 个测试通过）

### 2.3 TodoList 工具 ✅

- [x] 新建 `context/todo-store.ts`（持久化到 `.claw/todo.json`）
- [x] 新建 `tools/todo.ts`（TodoTool add/update/toggle/remove/list）
- [x] Prompt Composer 注入当前 Todo 状态
- [x] 测试 + 提交（todo-store 19 + todo 23,共 42 个测试通过）

### 2.4 WebSearch + FetchURL ✅

- [x] 新建 `tools/web.ts`（WebSearchTool + FetchURLTool 独立文件）
- [x] FetchURLTool 原生 fetch + HTML strip + 截断
- [x] WebSearchTool 支持配置搜索 API（SEARCH_API_BASE/KEY 环境变量）
- [x] readOnly + accesses（none）声明
- [x] 测试 + 提交（20 个测试通过）

### 2.5 Background Tasks（bash 后台化）

- [x] 新建 `tools/background-manager.ts`
- [x] BashTool 支持 `background: true` 参数
- [x] 后台任务有唯一 ID + stdout/stderr 环形缓冲
- [x] 新增 TaskList / TaskOutput / TaskStop 工具
- [x] 测试 + 提交

### 2.6 PreToolUse / PostToolUse Hooks ✅

> 对标 Claude Code/Codex/Kimi Code 三家源码确认的事实标准协议。现有 RequestMiddleware(代码内)定位不同——hooks 是**用户可配置 shell 扩展点**(不碰源码)。

- [x] 新建 `hooks/types.ts` + `hooks/runner.ts` + `hooks/config.ts`(用户可配置 shell hooks,对齐 Claude Code 协议:stdin JSON + exit 0/2 + stdout permissionDecision)
- [x] `tools/registry-impl.ts` execute 链插入 PreToolUse(可拦截/改写参数)/ PostToolUse(fire-and-forget)
- [x] PreToolUse 可拦截或改写参数(matcher 三模式 + modifiedInput)
- [x] PostToolUse fire-and-forget(不阻断工具)
- [x] 测试 + 提交(config 8 + runner 26 + registry 11,共 45 测试;真实模型 e2e 验证 .bat/.sh 脚本拦截 bash)
- [x] **fail-open 铁律**:任何故障(超时/崩溃/解析失败)都不阻断工具

### 2.7 edit_file 加 replace_all ✅

- [x] `tools/registry-impl.ts` fuzzyReplace 增加 `replaceAll` 选项（L1-L4 各级）
- [x] ToolDefinition 更新参数 schema
- [x] 测试 + 提交（7 个新测试,默认 false 行为不变）

---

## 阶段 5.1：Claude Code TUI Parity（已完成）

> **目标**：按真实 Claude Code 源码对比结果，补齐 Pico 的 TUI 交互内核、统一命令体系、`@` 附件、`/rewind` 确认、项目 session identity 和后续多代理任务基础。
>
> 详细任务拆分见：`docs/plans/2026-07-09-claude-code-parity-parallel.md`

### 第一批：互不依赖并行任务

- [x] A. TUI 布局与焦点弹窗仲裁
- [x] B. 统一 Command Kernel 与 `/help` 元数据
- [x] C. `@file` 附件解析与路径候选
- [x] D. `/rewind` 消息选择器与二次确认
- [x] E. Session Identity 与项目内 Resume 基础

### 第二批：第一批合并后再并行

> 详细任务拆分见：`docs/plans/2026-07-09-claude-code-parity-phase2.md`

- [x] F1. Skill Prompt Command 投影补齐
- [x] G1. Slash 与 @Path Typeahead 行为完善
- [x] H1. Tool UI 状态协议硬化
- [x] I1. Permissions 可视化模型与面板
- [x] J1. 后台 Agent Task Registry 状态快照
- [x] K1. TUI Resume Picker 接线

---

## 阶段 6：Claude Code Runtime Parity（已完成）

> **目标**：继续对比 `/Users/anxuan/workspace/claude-code-main/src`，把 Pico 从“长得像 Claude Code 的 TUI”推进到“运行时机制也接近 Claude Code”。
>
> 详细任务拆分见：`docs/plans/2026-07-09-claude-code-runtime-parity-stage6.md`

- [x] 6.0 测试基线分诊：修复本地确定性失败，网络 e2e 单独标注环境问题
- [x] 6.1 统一 Task Runtime：提供通用 task 状态模型，当前运行时接入 background bash 与 subagent
- [x] 6.2 Keybinding Kernel：完成上下文解析、默认绑定和可注入覆盖机制；未作为公开用户配置入口
- [x] 6.3 Virtual Transcript：长会话虚拟渲染与 scroll 窗口
- [x] 6.4 Permission Arbiter：完成决策竞速原语与 local approval adapter；hook/channel/classifier source 不在当前运行时范围
- [x] 6.5 File Index：`@file` 候选缓存、显式 refresh、ignore/git/rg fallback；TUI 当前启动时构建一次候选
- [x] 6.6 Plugin Lifecycle MVP：历史完成本地 manager 机制；Plugin runtime 不在当前公开 TUI 范围
- [x] 6.7 Compact Recovery：压缩失败兜底与压缩后关键信息恢复

---

## 阶段 7：TUI 产品化（已完成）

> **目标**：采用 Claude Code 的 transcript/渲染思路与 Kimi Code 的命令管理体验，修复 Pico TUI 的运行时真实性、焦点、长会话滚动和能力可发现性。
>
> 设计：`docs/superpowers/specs/2026-07-10-tui-productization-design.md`
>
> 第一阶段计划：`docs/superpowers/plans/2026-07-10-tui-productization-phase1.md`

- [x] 7.1 真实中断链路：AbortSignal 贯穿 TUI、Engine、Provider 和 ToolScheduler（TUI 聚焦测试覆盖中断链路；真实模型 E2E 验证中断后同 session 可继续）
- [x] 7.2 焦点仲裁：审批、候选、输入和 transcript 单一键盘所有权（TUI 聚焦测试覆盖审批/Help/候选/InputBox 键盘所有权）
- [x] 7.3 Transcript 行模型：工具聚合、Unicode 宽度、展开行高和 auto-follow（TUI 聚焦测试覆盖虚拟 transcript、Logo/error 裁剪、CJK/Emoji 宽度和极窄布局）
- [x] 7.4 命令真实性：Plan、Permission 和 Session 启动语义接入真实运行时（聚焦测试 72 个通过；typecheck / lint / diff check 通过）
- [x] 7.5 命令发现：扫描收敛、完整候选、分类与统一 Help 元数据（input/tui 聚焦测试 421 个通过；typecheck / lint / diff check 通过）
- [x] 7.6 产品外壳：Logo 首项、动态状态行和结构化错误（TUI 聚焦测试 312 个通过；typecheck / lint / diff check 通过；真实任务摘要收口测试 33 个通过）
- [x] 7.7 真实模型 E2E 与完整集成验证（新增 `tests/e2e/tui-real-llm-e2e.test.ts`；未设置 `RUN_LLM_E2E` 时 helper 1 个通过、真实模型 4 个 skipped；`RUN_LLM_E2E=1` 共 5 个通过，覆盖问候无工具、写入审批挂起后拒绝、中断 AbortError 后同 session 续跑、长回复多轮 transcript）
- [x] 7.8 Claude Code 风格 Skill 与 Workspace：显式 Skill 激活、additional directories、`/add-dir`、审批前路径守卫、TUI 可见事件与真实模型 E2E（设计：`docs/superpowers/specs/2026-07-10-claude-skill-workspace-design.md`；计划：`docs/superpowers/plans/2026-07-10-claude-skill-workspace.md`）

---

## 阶段 3：上下文与控制流增强（P1）

> **目标**：让 Agent 更聪明地管理上下文、更可控地执行任务。

### 3.1 MicroCompaction ✅

- [x] `context/compactor.ts` 增加旧 tool result 渐进清理策略
- [x] 按缓存年龄（>1 小时）+ 使用率（≥0.5）触发
- [x] 旧 tool result 替换为 `[Old tool result cleared]` 标记
- [x] 保留近 20 条消息完整（retainLastMsgsMicro 独立保护区，不改原 retainLastMsgs）
- [x] 测试 + 提交（compactor-micro 10 个测试）

### 3.2 Steer 机制（运行时注入）✅

- [x] `engine/loop.ts` 加 steer queue（`src/engine/steer-queue.ts`）
- [x] API call 期间可注入文本，drain 到下一个 tool message（A 点 peek 临时注入、C 点 drain 落 session）
- [x] CLI 支持 `--steer <text>` 在运行中注入（启动时 push 一次）
- [x] 飞书支持运行中发消息注入（chatId→SteerQueue 映射）
- [x] 测试 + 提交（steer 9 个测试）

### 3.3 undo 回滚 ✅

> 实际由阶段 1.5.6 提前实现，能力超出原 ROADMAP 描述（三轴回滚 + fork 语义）。本节打勾收尾。

- [x] `engine/session.ts` 加 undo 方法（1.5.6 已实现 `undo(count)` / `rewindTo(messageIndex)`）
- [x] 回滚到上一个 user prompt 或 compaction 边界（`undo(count)` 截断到第 count 个 user prompt 之前，遇 compaction 边界停止）
- [x] CLI 支持 `--undo` 命令（已被 `--rewind <id> --rewind-mode conversation|code|both` 取代，三轴覆盖、语义更强）
- [x] 测试 + 提交（`tests/engine/session-undo.test.ts` 14 个测试；Windows EBUSY 但逻辑正确）

### 3.4 deferredMessages ✅

- [x] `engine/session.ts` 保证 tool 调用顺序完整性（pendingToolCallIds 跟踪）
- [x] tool result 到齐前暂存后续消息（deferredMessages 队列，flush 顺序回放）
- [x] 测试 + 提交（session-deferred 10 个测试）

### 3.5 Goal Mode ✅

- [x] 新建 `engine/goal-manager.ts`（单例，避免 TodoStore 跨实例 bug）
- [x] 状态机：active / paused / blocked / complete
- [x] budget 配置存储与上下文展示（tokens / turns / wall-clock）；引擎执行预算仍由独立 IterationBudget 控制
- [x] 新增 CreateGoal / GetGoal / UpdateGoal 工具（`src/tools/goal.ts` 跨文件模式）
- [x] Goal context 在 continuation boundary 注入（PromptComposer + Grace Call）
- [x] 测试 + 提交（goal-manager 24 + goal 28，共 52 个测试）

### 3.6 Plan Review 审批 ✅

- [x] `context/plan-store.ts` 加 ExitPlanMode 触发审批流（`src/tools/plan-exit.ts` 走工具路径自动挂审批）
- [x] 审批卡片展示 plan 内容（飞书卡片 + 终端 notifier 展示 PLAN.md）
- [x] 用户可选 approve / reject / modify（ApprovalResult 加 modifiedContent 三态）
- [x] 测试 + 提交（plan-exit 10 个测试）

### 3.7 shouldContinueAfterStop ✅

- [x] `engine/loop.ts` 非工具停止后 host 可决定续接（回调 `{continue, continuePrompt?}`）
- [x] 测试 + 提交（continue-after-stop 7 个测试）

---

## 阶段 4：多模型与多端入口（历史完成，多端外壳已退役）

> **历史目标**：从"CLI + 飞书"到"多端可用"。下列条目记录曾完成的实现；后续 REST/WebSocket、ACP、飞书和 one-shot CLI 外壳已退役。当前仅 `pico` → TUI 是公开入口。

### 4.1 Gemini Provider ✅

- [x] 新建 `provider/gemini.ts`（GeminiProvider 实现 generate + generateStream）
- [x] factory.ts 加 gemini 分发（ProviderKind + createProvider/createRawProvider switch）
- [x] Gemini 原生协议适配（generateContent/streamGenerateContent、system_instruction 顶层、parts 结构、functionCall）
- [x] 测试 + 提交（13 mock 测试 + 1 e2e skip）

### 4.2 Credential Pool ✅

- [x] 新建 `provider/credential-pool.ts`（round-robin 轮询 + 60s 冷却 + 全限流兜底）
- [x] 多凭证配置（LLM_API_KEYS 复数优先于 LLM_API_KEY 单数）
- [x] 限流时自动轮换（retry.ts 遇 429 标记限流 + 切 key 重试）
- [x] 测试 + 提交（pool 10 + rotation 4，共 14 测试）

### 4.3 REST + WebSocket 协议 ✅（历史完成，已退役）

- [x] 新建 `server/` 目录（http.ts + ws.ts）
- [x] REST API：POST /sessions、GET /sessions/:id、POST /sessions/:id/messages、POST /approvals/:taskId、GET /tools
- [x] WebSocket：流式 text-delta + cursor {seq, epoch}
- [x] 多端同步：volatile 事件不推进 seq（session-store 加 volatile 字段 + epoch）
- [x] 测试 + 提交（http 12 + ws 8 + epoch 12，共 32 测试）

### 4.4 ACP 协议适配器 ✅（历史完成，已退役）

- [x] 新建 `acp/` 目录（protocol.ts + stdio-server.ts + server.ts）
- [x] stdio 驱动 + initialize/session/prompt 方法（复用 MCP stdio 骨架，方向相反）
- [x] IDE 文件桥接（fs/readTextFile / fs/writeTextFile，路径锚定防穿越）
- [x] 4 模式映射（default/plan/auto/yolo → planMode + YOLO approval）
- [x] 测试 + 提交（24 测试）

### 4.5 Docker 部署 ✅（历史完成，当前不支持）

- [x] `Dockerfile`（多阶段构建：builder 编译 better-sqlite3 + prod 干净运行时）
- [x] `docker-compose.yml`（环境变量透传 + workspace 卷挂载 + 端口映射）
- [x] 环境变量配置文档（`docs/deployment.md`，env 矩阵 + 4 入口模式 + 排障）
- [x] 测试 + 提交（沙箱无 Docker，纯 lint + 人工 review）

---

## 阶段 5：高级特性（P2 · 按需迭代）

> **目标**：从"能用"到"好用"。按实际需求挑着做。

- [x] 5.1 AgentSwarm（批量子代理）— delegate_task 已支持 tasks[] 批量 + 并发池，远超原始设想
- [x] 5.2 Cron 调度 — 不做（Cron/headless 调度不在当前 TUI-only 产品范围，不再以已退役的 REST API 作为替代承诺）
- [x] 5.3 Auxiliary Client（辅助模型做压缩/标题）— AUX*LLM*\* 配置 + FullCompactor 用 aux + Compactor summarizer 工厂
- [x] 5.4 Tool Search 渐进披露 — 工具分组分层 + `search_tools` 检索激活；当前由 TUI 内部装配 ToolDisclosure
- [x] 5.5 Image / Media 支持 — 方案 B（加 images 字段，content 保持 string），3 provider 多模态翻译 + TUI `/image` / `@image:` 传图
- [x] 5.6 TUI 界面 — ink + React 19：交互 REPL + 逐行流式渲染 + isStatic memo + QueryGuard + SpinnerMode + 工具折叠 + 多行输入；当前为 `pico` 默认入口
- [x] 5.7 Rate Limit Tracking — header 解析 + CredentialPool 精确冷却 + 3 provider 回传
- [x] 5.8 版本化迁移（JSONL schema 版本号）— meta record + migration 框架

---

## 阶段 8：TUI-only 产品边界收口 ✅（2026-07-10）

> 本阶段把公开入口、会话运行时、配置、验证与历史状态收口到 TUI；不恢复已退役外壳，不新增 headless 或 Plugin runtime。

- [x] 8.1 `pico` 成为可构建、可安装的唯一公开 TUI 入口；退役 one-shot / server / ACP 启动参数和遗留启动脚本
- [x] 8.2 TUI 会话共享 Goal、Todo、TaskRegistry、ToolDisclosure、SkillRegistry、MemoryNudger、FileIndex 和 SteerQueue
- [x] 8.3 `search_tools` 每次从实时 registry 检索后注册的 delegate / MCP 扩展工具，不自我披露
- [x] 8.4 `.pico/config.json` 接通 `commandsDir`、附加工作区和 TUI keybindings；文件索引支持 TTL 与写后失效
- [x] 8.5 移除重复的通用对话 arbiter，保留 TUI 本地对话与审批链；工作区外路径在审批前明确提示 `/add-dir`
- [x] 8.6 PR 门禁包含确定性 E2E、build、package dry-run 和构建产物 PTY smoke；真实模型验收 fail-closed 并接入 nightly/manual workflow
- [x] 8.7 公开文档统一 TUI-only 边界、`/snapshots` / `/rewind` 文件历史与 SkillRegistry 已实现能力，阶段 4 外壳标为历史退役
- [x] 8.8 归档旧计划，通过 `rg`、lint、format、typecheck、全量测试、真实模型验收、TUI smoke 和发布包验证

---

## 阶段 9：模型路由与 Claude Code 核心交互 ✅（2026-07-10）

- [x] 9.1 参考 OpenCode 引入 `providerID/modelID` 模型路由：provider map、端点模型发现、本地兼容校验和跨端点原子切换
- [x] 9.2 `/rewind` 收敛为用户消息级 checkpoint：提示词/相对时间/单条文件变化选择器，原子恢复 code/conversation/transcript/input/mode
- [x] 9.3 权限与模式收敛：单一 interaction mode、默认 yolo、Claude 风格三选审批、结构化 session grant、外部目录原子授权、Bash 越界写守卫与 bypass-immune 安全边界

---

## 阶段 10：TUI 滚动与大型工具输出收敛 ✅（2026-07-11）

> **目标**：修复工具展开后 transcript 失去自动跟底的问题，引入鼠标滚轮交互，并按 Claude Code 主线、Kimi Code 分页思路收敛大型工具输出。

- [x] 10.1 TUI 视口状态拆分为 follow / manual / tool-anchor，工具锚点失效和新 prompt 提交时恢复跟底
- [x] 10.2 全屏 TUI 支持鼠标滚轮，滚回底部后恢复自动跟随，退出与异常路径恢复终端 mouse mode
- [x] 10.3 Bash 大输出先完整落盘再返回预览，默认阈值对齐 Claude Code 的 30,000 字符
- [x] 10.4 Read 支持 offset / limit 分页、总量提示和 PARTIAL 语义，并阻断 artifact 读取的二次外部化
- [x] 10.5 Grep / Glob / MCP / 未知工具按工具类型使用分页或通用大输出兜底
- [x] 10.6 使用跨模块集成测试验证滚动窗口、大输出落盘和分页读取，并完成 main 分支验收
- [x] 10.7 修复宿主 xterm 与 PTY 尺寸漂移时的全帧重复刷屏：前端网格探测、自适应右边界留列与 Ctrl+L 安全重绘

---

## 阶段 11：TUI 可靠执行闭环 ✅（2026-07-11 完成）

> **目标**：先把已经公开的执行、会话、文件历史与 TUI 状态能力做成可靠闭环；本阶段不扩展第二入口，不新增单元测试，只在最终集成状态运行一条跨模块主链路。
>
> **并行边界**：第一波 11.1 / 11.2 / 11.3 使用独立 worktree 并行；第二波 11.4 / 11.5 等第一波合入集成分支后再启动。`ROADMAP.md`、共享依赖和最终 TUI 接线由主代理统一维护。

- [x] 11.1 执行事务层：AbortSignal 下沉到工具执行上下文；Bash 使用可流式回传、可杀进程树的执行方式；以每轮文件变化 journal 补齐 Bash / formatter / 脚本等写入的 rewind 记录
- [x] 11.2 Session 运行时持久化：保存并恢复 model route、mode、thinking、goal、usage/cost、授权目录和 transcript 水合所需状态
- [x] 11.3 TUI 事件投影：为消息、阶段和 tool call 建立唯一 ID 与 append-only event store；由 reducer 投影界面，消除重复渲染、同名工具错配和可变状态漂移
- [x] 11.4 Session 与运行中交互：启动水合、会话搜索/热切换/fork；区分 steer、queue、interrupt/replace；增加结构化 AskUser 交互
- [x] 11.5 Inspector 与 Changes：浏览完整工具输出和 artifact；按轮展示完整文件 patch、单文件恢复并可跳转 `/rewind`

---

## 阶段 12：可信 YOLO 与代码智能（已完成）

> **目标**：在默认无审批的交互模式下保留宿主硬边界，并让模型路由、上下文预算和代码理解建立在真实能力元数据之上。三个任务在阶段 11 接口稳定后使用独立 worktree 并行。
>
> **执行计划**：`docs/plans/2026-07-11-stage12-trusted-yolo-code-intelligence.md`

- [x] 12.1 YOLO 沙箱与策略：workspace-write、网络策略、敏感目录和危险命令边界；普通操作不弹审批，但越界不能仅靠模型或提示词约束
- [x] 12.2 模型能力与 Usage：route 记录 context/output/vision/reasoning/tool-call/cache/price/fallback 能力；请求前预检；提供 `/context` 与 `/usage`
- [x] 12.3 LSP 与 Repo Map：支持 definitions、references、symbols、diagnostics、调用层级和渐进式仓库地图，并接入现有工具披露机制

---

## 阶段 13：隔离式并行与 MCP 生命周期（待阶段 12 完成）

> **目标**：让写入型子代理和外部工具连接都成为可观察、可中止、可恢复的 TUI 内部能力。两个任务的 TUI 接线串行完成，避免并发修改 `runtime-state.ts` / `repl.tsx`。

- [ ] 13.1 Agent Worktree Supervisor：写入型子代理默认独立 branch/worktree；提供 `/tasks` 状态、输出 tail、停止、重试、追加指令、完成通知和主代理串行合并
- [ ] 13.2 MCP 生命周期：连接提升到 TUI 生命周期级；支持 reload、enable/disable、reconnect，并分步补齐 OAuth、resources 和 prompts

---

## 阶段 12.5：模型级思考能力（进行中）

> **目标**：参考 Z Code 与 OpenCode，把全局固定思考强度改为模型级 reasoning profile；选中模型后自动解析默认档位、可选档位和协议请求映射。
>
> **并行边界**：能力 Schema/Resolver 先形成共享接口；Provider 请求映射和 TUI 交互在独立 worktree 并行；主代理只在独立集成 worktree 合并、接线并运行一条跨模块集成主链。

- [ ] 12.5.1 定义 `defaultLevel + levels + providerOptionsByLevel` 的类型安全模型级 Reasoning Capability，并兼容旧 `reasoning: boolean`
- [ ] 12.5.2 接通 `.pico/config.json` 解析、版本化模型 ID 归一化和 GLM 5.2 / DeepSeek V4 / toggle 模型内置规则
- [ ] 12.5.3 将 OpenAI、Anthropic、Gemini 请求转换改为应用当前模型 level 的协议补丁，不再向所有模型统一发送 `reasoning_effort`
- [ ] 12.5.4 将 `/thinking` 的显示、参数补全和校验改为读取当前 route 的真实 levels
- [ ] 12.5.5 在 `/model` 切换时保留兼容 level；不兼容时自动切换到目标模型默认 level，并持久化有效状态
- [ ] 12.5.6 在独立集成分支验证“切换模型 → 档位变化 → 请求体变化”主链，完成构建、合并、推送和临时资源清理

---

## 📊 历史交付进度与当前收口

| 阶段         | 总任务数 | 完成   | 状态                                |
| ------------ | -------- | ------ | ----------------------------------- |
| 阶段 1       | 5        | 5      | ✅ 完成                             |
| 阶段 1.5     | 8        | 8      | ✅ 完成                             |
| 阶段 2       | 7        | 7      | ✅ 完成                             |
| 阶段 3       | 7        | 7      | ✅ 完成                             |
| 阶段 4       | 5        | 5      | ✅ 历史完成；多端外壳已退役         |
| 阶段 5       | 8        | 8      | ✅ 历史闭环（5.2 不做；5.4 已实现） |
| 阶段 5.1     | 11       | 11     | ✅ 完成                             |
| 阶段 6       | 8        | 8      | ✅ 完成                             |
| 阶段 7       | 8        | 8      | ✅ 完成                             |
| 阶段 8       | 8        | 8      | ✅ TUI-only 收口完成                |
| 阶段 9       | 3        | 3      | ✅ 模型路由与核心交互完成           |
| 阶段 10      | 7        | 7      | ✅ TUI 滚动与大型输出收敛完成       |
| 阶段 11      | 5        | 5      | ✅ TUI 可靠执行闭环完成             |
| 阶段 12      | 3        | 3      | ✅ 可信 YOLO 与代码智能完成         |
| 阶段 12.5    | 6        | 0      | ⏳ 模型级思考能力                   |
| 阶段 13      | 2        | 0      | ⏳ 隔离式并行与 MCP 生命周期        |
| **当前总计** | **101**  | **93** | ⏳ 当前：模型级思考能力             |

---

## 📝 补充任务（发现的新问题追加到这里）

<!-- 开发过程中发现的新需求，追加到这里，注明发现日期 -->

- [x] 2026-07-10：参考 OpenCode 引入 `providerID/modelID` 模型路由；`.pico/config.json` provider map 关联协议、端点和凭证环境变量，`/model` 仅从配置/发现目录安全切换完整路由，旧 `LLM_*` 保持兼容；本地 HTTP 集成测试覆盖模型发现、非法路由拒绝和真实请求切换。

- 2026-07-10（未排期）：SkillRegistry 如需新增指令更新 API，必须另行设计和验证；当前只承诺已实现的执行记录与检索，不声称会自动改写 Skill。

- 2026-07-07（阶段 2 真实模型 e2e 发现）：`TodoStore.load()` 幂等性导致跨实例不可见 ✅ 已修复（2026-07-08）
  - 现象：`load()` 首次加载后置 `loaded=true`，后续调用直接返回内存缓存，不再重读磁盘。多个 `TodoStore` 实例（如 PromptComposer 的、TodoTool 的、CLI 新进程的）各自维护独立内存缓存，互相看不到对方的写入。
  - 影响：单实例内一致，但跨实例/跨进程读取时拿不到最新 todo.json。对 CLI `--list-snapshots` 这类新进程读取场景是隐患。
  - 根因：TodoTool（`default-registry.ts`）和 PromptComposer（`composer.ts`）各自 `new TodoStore(workDir)`，两个独立实例。
  - 修复方案：对齐 GoalManager 单例注入范式（项目既有最佳实践，`goal-manager.ts:11` 注释早已点明）：
    - `TodoStore` 新增 `reload()` 方法（强制重读盘，跨进程兜底）；
    - `default-registry.ts` / `composer.ts` / `loop.ts`（`AgentEngineOptions`）均加 `todoStore?` 注入参数，未注入则内部 new（向后兼容）；
    - 所有 host 入口（`run-agent.ts` / `main.ts` 的 ACP+飞书 / `http.ts`）创建唯一 `TodoStore` 单例，同时传给 registry + Composer + engine。
  - 验证：新增 2 个测试（reload 强制重读 + 单例注入回归），todo-store 21 + todo 23 + composer 33 + integration 9 + memory 9 + loop-goal + http 全过；全量 mock 测试无新增回归（失败项均为 Windows EBUSY/CRLF baseline）。

---

## 📅 变更记录

- 2026-07-11：收敛项目配置与工具入口
  - 新增项目 `.pico/config.json`；默认选择火山方舟 Coding Plan，并从账号 `/models` 接口筛出 35 个支持文本输出与 Function Calling 的 Agent 模型，写入上下文、输出、视觉、reasoning、tool-call 和 cache 元数据；DeepSeek provider 保留为备用。
  - 火山方舟与 DeepSeek 密钥分别只通过 `VOLCENGINE_API_KEY`、`LLM_API_KEY` 环境变量读取，不进入 JSON 或 Git。
  - 删除面向用户的 `/tools` 命令；模型内部 `search_tools` 延迟披露机制保持不变，MCP 状态和审批策略继续由 `/mcp`、`/permissions` 分别承载。
  - LSP/Repo Map 保持宿主自动发现与降级，不增加要求用户操作的代码智能命令。

- 2026-07-11：完成阶段 12 可信 YOLO 与代码智能
  - YOLO 普通工作区操作保持无审批；外部写入、敏感路径、网络和 hardline 由宿主策略确定性拒绝，macOS Bash 使用 OS 沙箱，缺少等价后端时 fail-closed。
  - 模型 route 记录能力、限额、价格与 fallback 来源；请求前预检图像、工具、reasoning 和 context，`/usage`、`/context` 区分 reported、estimated、partial 与 unknown。
  - TUI 生命周期接入 LSP JSON-RPC、导航/诊断/调用层级和 Repo Map 降级；六个代码智能工具复用 `search_tools` 渐进披露。
  - 最终只运行三条阶段 12 集成主链；typecheck、build、ESLint 和格式检查通过。

- 2026-07-11：完成阶段 11 TUI 可靠执行闭环
  - 执行层支持可中止进程树、流式工具输出与跨工具文件事务；Session 持久化 route/mode/thinking/goal/usage/授权目录并支持搜索、热切换和 fork。
  - TUI 使用有界 append-only event store 与稳定消息/tool ID，运行输入区分 steer/queue/replace，结构化 AskUser 可被审批安全抢占后恢复。
  - Ctrl+E 接入完整 Tool Inspector 和可信 artifact 分页；新增 `/changes`，支持完整 patch、指纹防并发覆盖、hard-link 安全的原子单文件恢复及跳转 `/rewind`。
  - 最终只运行一条 Stage 11 跨模块集成场景；typecheck、build 与该场景全部通过。

- 2026-07-11：持久化阶段 11-13 开发任务
  - 阶段 11 先收敛执行事务、Session、TUI 事件投影、运行中交互与 Changes/Inspector；第一波三个独立 worktree 并行，第二波在共享接口合入后启动。
  - 阶段 12 增加 YOLO 硬沙箱、模型能力/Usage 和 LSP/Repo Map；阶段 13 增加 Agent Worktree Supervisor 与 MCP 常驻生命周期。
  - 延续 TUI-only 边界；不恢复 headless CLI、REST/WebSocket、ACP、Cron、Docker 或 Plugin runtime；后续只新增跨模块集成验证。

- 2026-07-11：修复 ChatGPT.app 166x17 全屏重复刷屏
  - ChatGPT.app 中 xterm 可能已缩至约 87 列，后端 PTY 却仍上报 166 列；Ink 启动前用 CPR 读取前端真实网格，并将它作为布局上限。
  - Yoga 根布局按有效终端宽度自适应保留右边界 1 列并裁剪溢出，防止 spinner 帧和动态缩放触发隐式 wrap；保持 Ink 默认全帧渲染，避免增量模式造成中文与复杂布局错位。
  - Ctrl+L 改为 Ink 管理的空帧/完整帧重画，不再裸写 stdout 破坏差分帧状态。
  - 生产配置集成验收分离模拟 PTY 166x17 与前端 87x40，验证 CPR 分片回应、中文流式多帧与后续缩至 80 列均不产生残影。

- 2026-07-11：完成阶段 10 TUI 滚动与大型工具输出收敛
  - Transcript 视口改为 follow / manual / tool-anchor 三态；工具展开锚点失效、新 prompt 提交和滚回底部时恢复自动跟随。
  - 全屏 TUI 启用 SGR 1000/1006 鼠标滚轮，保留 PageUp/PageDown 回退，并在卸载与挂起链路对称恢复终端 mouse mode。
  - Bash 超过 30,000 chars 后完整写入 session artifact；未知/MCP 工具使用 50,000 chars 通用阈值，Grep/Glob 超限时提示缩小查询。
  - Read 新增 1-based offset/limit 分页、PARTIAL 与下一页提示；单页最多 30,000 chars，并阻断 artifact 回读的二次外部化。
  - 验证：PR-safe E2E 4 个文件、15 条用例通过；lint、typecheck、build 与 audit 通过。

- 2026-07-10：`/rewind` 对齐 Claude Code 用户消息级机制
  - 顶层用户消息进入模型前建立唯一 RewindPoint，内部 ReAct turn 不再生成用户可见快照。
  - 选择器展示原始提示词、相对时间和该条消息真实文件变化；确认页默认 code+conversation，无代码变化时只提供 conversation。
  - conversation/both 精确持久化 `rewind_to(messageIndex)`，同步 fork Session、截断可见 transcript、移除未来活动分支，并把原 prompt 回填输入框。
  - manifest 新字段全部可选；旧 turn 快照不进入消息选择器，仍可通过显式 messageId 执行 code-only 兼容回滚。

- 2026-07-10：修复 TUI 工作区审批、Goal 与工具卡交互
  - 审批 dialog 按 taskId 隔离，并发请求不再覆盖；连续 Enter 只处理一次，abort/finally 会清理本轮全部审批框。
  - 未授权外部路径继续在普通写审批前拒绝；`/add-dir` 后主 Agent、spawn、delegate、profile 与递归子代理共享同一组 WorkspaceRoots。
  - 新增只读 `/goal` 状态命令并接入共享 GoalManager、帮助面板与 slash suggestions。
  - 最近工具卡在后续回复出现后仍可用 Ctrl+E 展开；长回复会自动滚回工具卡，非空输入草稿仍优先使用 Ctrl+E 跳到行尾。
  - 验证：全量 mock 156 个文件、1933 项通过；确定性 E2E 10 项、相关真实模型 E2E 7 项通过；lint、format、typecheck、build、audit 与 TUI smoke 通过。

- 2026-07-10：完成阶段 8 TUI-only 收口
  - 发布入口、会话共享运行时、动态工具、项目配置、工作区审批和文档边界全部收口。
  - 默认测试 1915 项通过、确定性 E2E 10 项通过；构建产物 PTY 发起 1 次本地模型请求并完成渲染。
  - 真实模型全链路覆盖流式、工具、Goal、审批、Skill / 附加工作区、Hooks 与 TUI；修正 thinking 模型探针 token 与旧 schema v1 断言。

- 2026-07-10：项目收口清理
  - 重新核对阶段 1～7，补计阶段 5.1 与阶段 7，当前正式任务为 67/67 完成。
  - 将阶段 1.5.6 的 deferred 状态清理同步为已由 3.4 实现，历史执行计划明确标记为非当前进度来源。
  - 将 SkillRegistry 指令更新从测试中的隐藏 TODO 移入阶段 8 候选，不纳入当前交付范围。

- 2026-07-10：完成 7.8 Claude Code 风格 Skill 与 Workspace
  - `/skill <name> [arguments]` 与动态 `/<skill-name>` 均生成显式激活的 synthetic user prompt，TUI 记录结构化 Skill 事件。
  - 新增 WorkspaceRoots、`/add-dir`、可重复 `--add-dir` 与 `.pico/config.json` additionalDirectories；文件边界在审批前确定性拒绝。
  - Read/Write/Edit/Glob/Grep、审批 diff 与文件历史共享附加目录能力；未授权目录不弹无效审批，授权后恢复正常写审批。
  - 验证：全量 mock 153 个文件、1881 项通过；lint、typecheck、build、audit 通过；真实模型 Skill + 外部目录闭环 1/1 通过。

- 2026-07-08：阶段 5.6 TUI 界面实现（修订原"不做"决策）
  - 原 ROADMAP 标 5.6"不做（与 HTTP+WS 路线重复）"；经 Claude Code 源码调研确认其用 ink+React，决定采用同款技术栈实现交互 REPL
  - **技术栈**（对标 `/d/work/claude-code-main` 源码确认）：ink 7 + React 19 + TSX；Claude Code 用 `@anthropic/ink`（内部 fork），公开版 ink API 一致
  - **核心组件**（`src/tui/`）：
    - `tui-reporter.ts`：TuiReporter implements Reporter，8 个 engine 事件→TuiEntry 状态映射（onTextDelta 流式累积、onToolCall/Result 工具卡片、onThinking spinner）
    - `app.tsx`：顶层布局（顶栏 model/workDir + 消息列表 + 输入框），Ctrl+C 退出，状态机 idle/thinking
    - `message-list.tsx`：对话流渲染，轮次分隔线，assistant 代码块着色
    - `tool-card.tsx`：工具卡片（树形缩进 ⎿ + 参数 JSON 关键字段高亮 + 状态图标 ✓✗⠋ + 摘要着色）
    - `input-box.tsx`：useInput 自实现极简输入框（免装 ink-text-input 依赖）
    - `spinner.tsx`：思考动画（useEffect 80ms 切帧）
    - `repl.tsx`：REPL 启动器，复用 runAgentFromCli + 共享 TuiReporter，固定 sessionId 复用 session
  - **入口**：`src/cli/main.ts` 加 `--tui` flag，与 feishu/acp/serve 平级，opt-in 不影响现有入口
  - **极简哲学**：TuiReporter 经依赖注入接入 engine（零改动 engine）；每轮调 runAgentFromCli 复用既有装配链（零改动 run-agent.ts）
  - 验证：TuiReporter 11 单测全过（事件→状态映射）；typecheck 零新增错误；冒烟测试进程能启动（ink 成功挂载）
  - 策略：worktree 两波并行（第一波串行建 MVP 骨架，第二波 components/entry 两个子代理并行因文件集不相交）
- 2026-07-08：阶段 5.6 TUI 深度对齐 Claude Code（7 项核心机制重构）
  - 经 Claude Code 源码深度调研（Messages.tsx/SpinnerAnimationRow/QueryGuard/StreamingMarkdown 等），对标其核心渲染机制重构 TUI
  - **7 项核心改造**：
    1. **SpinnerMode 5 阶段**（对标 `Spinner/types.ts`）：requesting/thinking/tool-use/responding/idle，随 engine 事件切换，文案+颜色变
    2. **spinner 动画隔离**（对标 `SpinnerAnimationRow`）：用 ink 7 `useAnimation`，frame 状态自包含不触发父组件 setState，多 spinner 共享单一 timer（性能优化）
    3. **逐行流式渲染**（对标 `StreamingMarkdown`）：`streaming-text.tsx` 按最后换行分割 stable/unstable，stable memo 不重渲染，避免长文本 O(n²)
    4. **isStatic 按状态判定**（对标 `shouldRenderStatically`）：按 tool resolve 状态逐条判 static（非按索引切分），配合 React.memo 跳过重渲染
    5. **无固定顶栏**（对标 Claude Code 布局）：Logo 作为消息流首项，输入框 borderBottom only
    6. **工具结果折叠/展开**（对标 `shouldCollapseDiffs`）：默认折叠只显字节数，按 Ctrl+E 展开
    7. **QueryGuard 并发防护**（对标 `QueryGuard.ts`）：三态状态机 + generation 号防陈旧，useSyncExternalStore 订阅，防连按 Enter 并发提交
  - **新增文件**：query-guard.ts / streaming-text.tsx / message-row.tsx（React.memo + isStatic）
  - **额外**：多行输入（Alt+Enter 换行）+ 输入历史（↑↓ 翻）
  - 验证：TUI 测试 46 个全过（query-guard 12 + streaming 9 + reporter 17 + shouldRenderStatically 8）；typecheck 零新增错误
  - 策略：worktree 两波并行（第一波基础设施串行，第二波 msg/io 两子代理并行因文件集不相交）
  - 技术约束：OffscreenFreeze 依赖 @anthropic/ink 私有 `useTerminalViewport`，公开 ink 无此 hook，用 `<Static>` + React.memo 等价替代
- 2026-07-08：阶段 5.4 Tool Search 渐进披露实现（修订原"不做"决策）
  - 原 ROADMAP 标 5.4"不做（15 工具 << 50 阈值）"；经重新评估决定采用**工具分组分层**方案实现（非全量检索披露，避免过度设计）
  - **核心三件套**（`src/tools/`）：
    - `tool-tiers.ts`：CORE_TOOLS 常量集（read/write/edit/bash/glob/grep/todo 共 7 个核心工具）+ getTier() 分层判定
    - `tool-disclosure.ts`：ToolDisclosure 状态机——disclose()/pickForLLM()(核心∪disclosed扩展)/getDisclosed()/reset()；不影响 registry.execute 路由（安全网：模型误调未披露工具也能执行）
    - `search-tools.ts`：SearchToolsTool 元工具——模型用关键词检索激活扩展工具，命中调 disclose() 加入 disclosed 集合，下一轮自动可用
  - **接入层**：
    - `engine/loop.ts`：AgentEngineOptions 加 toolDisclosure? 字段；run() 拦截点（getAvailableTools 后）pickForLLM 筛选 + search_tools schema 始终注入；trace 记录 totalToolCount
    - `default-registry.ts` + `run-agent.ts` + `main.ts`(ACP/飞书) + `http.ts`：所有 host 入口创建 ToolDisclosure 单例，对齐 GoalManager/TodoStore 注入范式；向后兼容（未注入则行为不变）
  - **极简哲学**：不改 BaseTool 接口（tier 用集中常量表），不改 execute 路由，不改 ToolDefinition schema
  - 验证：三件套单测 21 + loop 拦截点测试 4 = 25 个新测试全过；typecheck 零新增错误（接口对接 host↔loop 零误差）；全量 mock 测试无回归
  - 策略：worktree 两波并行（第一波串行建三件套，第二波 loop/host 两个子代理并行因文件集不相交）
- 2026-07-07：阶段 4 多模型与多端入口全部完成（5/5）
  - 4.1 Gemini Provider：原生协议适配（generateContent API、system_instruction 顶层、parts 结构），factory/profile 加 gemini 分发（+13 测试）
  - 4.2 Credential Pool：round-robin 轮换 + 60s 冷却 + 全限流兜底，429 自动切 key 重试（+14 测试）
  - 4.3 REST + WebSocket：server/ 模块（REST 端点矩阵 + WS 流式），cursor {seq, epoch} 多端同步，volatile 事件不推进 seq（+32 测试）
  - 4.4 ACP 协议：acp/ 三件套（protocol + stdio-server + server），initialize/session/prompt/fs 桥接，4 模式映射（+24 测试）
  - 4.5 Docker：多阶段构建处理 better-sqlite3 + compose + 部署文档
  - 三批策略：Batch 1（gemini/rest-ws/acp 并行）+ Batch 2（credential-pool 共用 factory）+ Batch 3（docker 压轴）
  - 验证：全量 npm test 1154 passed（净增 86 测试），失败项均为 Windows baseline
- 2026-07-07：阶段 3 上下文与控制流增强全部完成（7/7）
  - 3.1 MicroCompaction：年龄>1h+使用率≥0.5 触发渐进清理，`[Old tool result cleared]` 标记，近 20 条保护区（+10 测试）
  - 3.2 Steer 运行时注入：SteerQueue + A 点 peek/C 点 drain，CLI `--steer` + 飞书运行中注入（+9 测试）
  - 3.3 undo：确认由 1.5.6 实现（三轴 rewind + fork 语义），打勾收尾
  - 3.4 deferredMessages：pendingToolCallIds 跟踪 + deferredMessages 暂存，保证 tool result 顺序完整（+10 测试）
  - 3.5 Goal Mode：GoalManager 单例 + 状态机 + 3 工具 + PromptComposer/Grace Call 注入，budget 复用 IterationBudget（含 wall-clock）（+52 测试）
  - 3.6 Plan Review 审批：ExitPlanMode 工具走审批 middleware，支持 approve/reject/modify 三态，飞书卡片展示 plan（+10 测试）
  - 3.7 shouldContinueAfterStop：非工具停止后 host 回调续接（+7 测试）
  - Batch 1（4 worktree 并行不碰 loop.ts）+ Batch 2（3 worktree 串行改 loop.ts）两批策略规避 loop.ts 冲突
  - 验证：全量 npm test 1068 passed（净增 109 测试），失败项均为 Windows baseline
- 2026-07-07：阶段 3.3 undo 确认由 1.5.6 完成并打勾收尾
  - ROADMAP 3.3 的 4 个子项全部勾选；阶段 1.5.6 早已实现 `Session.undo(count)` / `rewindTo(messageIndex)` 及三轴 rewind（code/conversation/both，含 fork 语义）
  - CLI 用 `--rewind <id> --rewind-mode conversation|code|both` 覆盖原 `--undo`，能力超出原 ROADMAP 描述
  - 测试 `tests/engine/session-undo.test.ts` 14 个（Windows EBUSY 但逻辑正确）
  - 进度统计：阶段 3 完成数 +1（7→1），总计 20
- 2026-07-07：阶段 2 工具生态扩展，5 项并行完成（2.6 Hooks 暂缓到阶段 3）
  - 2.1 Glob 工具（自实现 glob→RegExp,支持 `**`/`*`/`?`/`[abc]`/`{a,b}`,+31 测试）
  - 2.2 Grep 工具（优先 ripgrep,降级 Node.js,支持 glob 过滤与大小写,+23 测试）
  - 2.3 TodoList 工具（TodoStore 持久化 `.claw/todo.json`,composer 注入,+42 测试）
  - 2.4 WebSearch + FetchURL（原生 fetch + HTML strip,环境变量配置搜索 API,+20 测试）
  - 2.7 edit_file replace_all（fuzzyReplace L1-L4 全替换,L4 逐区间缩进重对齐,+7 测试）
  - 跨文件工具模式（对标 SkillViewTool）从根源消除 registry-impl.ts 并行冲突
  - agent-profile KNOWN_TOOL_NAMES 白名单扩充 5 个新工具
  - 验证：合并后全量 `npm test` 950 passed（净增 123 测试,失败项为 Windows baseline）
- 2026-07-07：阶段 1 全部收尾，1.1 / 1.2 / 1.3 子项 100% 闭环
  - Claude 流式输出（`generateStream`，9 个测试）；复用 `buildRequestBody` / `translateContentBlocks`
  - 审批通知附带 before/after diff（`computeApprovalDiff` 复用 `generateSimpleDiff`，10 个测试）
  - 飞书审批卡片与终端 notifier 展示变更预览，bash 重定向也识别目标文件
  - 文档收尾：CLI 流式打印、`--rollback` 已被 `--rewind` 取代全部打勾
  - 验证：���并后全量 `npm test` 827 passed（失败项为 Windows EBUSY baseline，无新增回归）
- 2026-07-07：阶段 1.5.8 CLI 集成与阶段 2.5 Background Tasks 完成
  - CLI 支持 `--list-snapshots`、`--rewind <message-id>` 和 `--rewind-mode code|conversation|both`
  - 文件历史快照 manifest 持久化，支持跨 CLI 进程列点和回滚
  - BashTool 支持 `background: true`，新增 `task_list` / `task_output` / `task_stop`
  - 后台任务支持 stdout/stderr 环形缓冲、停止超时兜底和已完成任务裁剪
  - 验证：目标测试 97 个通过，全量 `npm test` 835 个通过，真实模型 CLI / 流式 / 子代理集成通过
- 2026-07-07：1.5.6 JSONL 持久化 + compaction 边界 + BashTool 重定向检测完成（subagent 执行，已合并）
  - undo 事件 JSONL 持久化 + recover 重放（+14 测试）
  - BashTool `>`/`>>` 重定向目标备份（+10 测试）
  - 全量 805 测试通过
- 2026-07-07：阶段 1.5 核心完成（1.5.1~1.5.7，44 个测试，9 次提交）
  - 文件历史系统：纯 copyFile 备份替换 git stash，不依赖用户项目 git
  - 三轴 rewind：code（文件）/ conversation（对话）/ both，fork 语义
  - 1.5.8 CLI 集成（fileHistory.snapshots 持久化 + --rewind/--list-snapshots）待后续 session 实现
- 2026-07-06：阶段 1 全部完成（流式输出 + Checkpoint + Diff 预览 + Permission + MCP，共 80 个测试）
- 2026-07-06：初始计划创建，基于 Kimi Code + Hermes Agent 调研对比
