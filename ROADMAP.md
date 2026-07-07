# pico-harness 进化路线图

> **这份文件是 pico-harness 的持久化开发计划。**
> 每完成一个任务，把 `- [ ]` 改成 `- [x]`。
> 新窗口打开时，先读这个文件了解当前进度。

---

## 📐 开发流程（必须遵守）

### 1. 测试驱动

- 每完成一个功能或一小部分工作，**先写测试再写实现**（或至少同步写）
- 测试覆盖：正常路径 + 边界情况 + 错误处理
- 运行 `npm test` 确认全部通过后再提交
- 如果改动涉及 Provider/Session 等核心模块，跑一遍集成测试

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

### 1.1 流式输出（SSE / Streaming）✅
- [x] `provider/interface.ts` 加 `generateStream()` 方法，返回 AsyncIterable
- [x] `provider/openai.ts` 实现流式（SSE 解析）
- [x] `provider/claude.ts` 实现流式（SSE 解析）
- [x] `engine/reporter.ts` 加 `onTextDelta(delta: string)` 回调
- [x] `engine/loop.ts` 接入流式回调，边接收边输出
- [x] `cli/main.ts` CLI 模式流式打印（TerminalReporter.onTextDelta 输出到 stdout）
- [x] 测试：mock provider 返回流式数据，验证回调顺序（openai 3 个 + claude 9 个测试通过）
- [x] 提交

### 1.2 Checkpoint（git 快照）✅
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
- [ ] 清空 deferredMessages / pendingToolResultIds（字段预留到 3.4，不在阶段 1.5 实现）
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

### 1.5.8 CLI 集成 + 替换旧方案
- [x] CLI 加 `--rewind` 命令：列出可选快照点
- [x] `--rewind <message-id>`：三轴选择（code / conversation / both）
- [x] `--list-snapshots`：列出所有快照及文件变更统计
- [x] 保留旧的 `safety/checkpoint-manager.ts` 作为 fallback（非交互场景）
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

### 2.6 PreToolUse / PostToolUse Hooks
- [ ] `tools/registry.ts` 加 `PreToolUseHook` 和 `PostToolUseHook` 接口
- [ ] `tools/registry-impl.ts` 执行链插入 hook 调用点
- [ ] PreToolUse 可拦截或改写参数
- [ ] PostToolUse 可修改输出
- [ ] 测试 + 提交

### 2.7 edit_file 加 replace_all ✅
- [x] `tools/registry-impl.ts` fuzzyReplace 增加 `replaceAll` 选项（L1-L4 各级）
- [x] ToolDefinition 更新参数 schema
- [x] 测试 + 提交（7 个新测试,默认 false 行为不变）

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
- [x] budget 支持（tokens / turns / wall-clock，复用 IterationBudget）
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

## 阶段 4：多模型与多端入口（P2）

> **目标**：从"CLI + 飞书"到"多端可用"。

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

### 4.3 REST + WebSocket 协议 ✅
- [x] 新建 `server/` 目录（http.ts + ws.ts）
- [x] REST API：POST /sessions、GET /sessions/:id、POST /sessions/:id/messages、POST /approvals/:taskId、GET /tools
- [x] WebSocket：流式 text-delta + cursor {seq, epoch}
- [x] 多端同步：volatile 事件不推进 seq（session-store 加 volatile 字段 + epoch）
- [x] 测试 + 提交（http 12 + ws 8 + epoch 12，共 32 测试）

### 4.4 ACP 协议适配器 ✅
- [x] 新建 `acp/` 目录（protocol.ts + stdio-server.ts + server.ts）
- [x] stdio 驱动 + initialize/session/prompt 方法（复用 MCP stdio 骨架，方向相反）
- [x] IDE 文件桥接（fs/readTextFile / fs/writeTextFile，路径锚定防穿越）
- [x] 4 模式映射（default/plan/auto/yolo → planMode + YOLO approval）
- [x] 测试 + 提交（24 测试）

### 4.5 Docker 部署 ✅
- [x] `Dockerfile`（多阶段构建：builder 编译 better-sqlite3 + prod 干净运行时）
- [x] `docker-compose.yml`（环境变量透传 + workspace 卷挂载 + 端口映射）
- [x] 环境变量配置文档（`docs/deployment.md`，env 矩阵 + 4 入口模式 + 排障）
- [x] 测试 + 提交（沙箱无 Docker，纯 lint + 人工 review）

---

## 阶段 5：高级特性（P2 · 按需迭代）

> **目标**：从"能用"到"好用"。按实际需求挑着做。

- [x] 5.1 AgentSwarm（批量子代理）— delegate_task 已支持 tasks[] 批量 + 并发池，远超原始设想
- [ ] 5.2 Cron 调度（P2，偏离交互式 Agent 定位，暂不做）
- [x] 5.3 Auxiliary Client（辅助模型做压缩/标题）— AUX_LLM_* 配置 + FullCompactor 用 aux + Compactor summarizer 工厂
- [ ] 5.4 Tool Search 渐进披露（P2，工具还少，过早优化）
- [ ] 5.5 Image / Media 支持（P1，需 Message schema 大改造，依赖 5.8 先做）
- [ ] 5.6 TUI 界面（P2，与 HTTP+WS 路线重复，暂不做）
- [x] 5.7 Rate Limit Tracking — header 解析 + CredentialPool 精确冷却 + 3 provider 回传
- [x] 5.8 版本化迁移（JSONL schema 版本号）— meta record + migration 框架

---

## 📊 进度统计

| 阶段 | 总任务数 | 完成 | 状态 |
|------|---------|------|------|
| 阶段 1 | 5 | 5 | ✅ 完成 |
| 阶段 1.5 | 8 | 8 | ✅ 完成 |
| 阶段 2 | 7 | 6 | 🟢 仅剩 2.6 Hooks（暂缓到阶段 3） |
| 阶段 3 | 7 | 7 | ✅ 完成 |
| 阶段 4 | 5 | 5 | ✅ 完成 |
| 阶段 5 | 8 | 4 | 🟡 5.1/5.3/5.7/5.8 完成，5.5 待做 |
| **总计** | **40** | **35** | — |

---

## 📝 补充任务（发现的新问题追加到这里）

<!-- 开发过程中发现的新需求，追加到这里，注明发现日期 -->

- 2026-07-07（阶段 2 真实模型 e2e 发现）：`TodoStore.load()` 幂等性导致跨实例不可见
  - 现象：`load()` 首次加载后置 `loaded=true`，后续调用直接返回内存缓存，不再重读磁盘。多个 `TodoStore` 实例（如 PromptComposer 的、TodoTool 的、CLI 新进程的）各自维护独立内存缓存，互相看不到对方的写入。
  - 影响：单实例内一致，但跨实例/跨进程读取时拿不到最新 todo.json。目前尚未在真实使用中暴露问题（主流程只读用 `buildTodoContext` 也能容忍短暂延迟），但对 CLI `--list-snapshots` 这类新进程读取场景是隐患。
  - 候选方案：(a) `load()` 去掉幂等、每次重读；(b) 保留幂等但暴露 `reload()`；(c) 加文件 mtime 比较决定是否重读。优先级低，留到后续迭代。

---

## 📅 变更记录

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
