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

### 1.1 流式输出（SSE / Streaming）
- [ ] `provider/interface.ts` 加 `generateStream()` 方法，返回 AsyncIterable
- [ ] `provider/openai.ts` 实现流式（SSE 解析）
- [ ] `provider/claude.ts` 实现流式（SSE 解析）
- [ ] `engine/reporter.ts` 加 `onTextDelta(delta: string)` 回调
- [ ] `engine/loop.ts` 接入流式回调，边接收边输出
- [ ] `cli/main.ts` CLI 模式流式打印
- [ ] 测试：mock provider 返回流式数据，验证回调顺序
- [ ] 提交

### 1.2 Checkpoint（git 快照）
- [ ] 新建 `safety/checkpoint-manager.ts`
- [ ] 在文件变动工具（Write/Edit/Bash 含写）执行前，用 `git stash create` 创建快照
- [ ] 每个 turn dedup（同一 turn 多次写操作只快照一次）
- [ ] 提供 `rollback(checkpointId)` 方法
- [ ] CLI 加 `--rollback <id>` 命令
- [ ] 测试：写文件 → 回滚 → 确认内容恢复
- [ ] 提交

### 1.3 Diff 预览
- [ ] `tools/registry-impl.ts` 的 EditFileTool 返回 before/after diff
- [ ] WriteFileTool 返回新建文件标记
- [ ] `approval/manager.ts` 审批通知附带 diff
- [ ] 飞书审批卡片展示 diff（截断长 diff）
- [ ] 测试：edit_file 触发审批 → 卡片含 diff
- [ ] 提交

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

## 阶段 2：工具生态扩展（P1）

> **目标**：从 4 个工具扩展到"够用的工具集"。

### 2.1 Glob 工具（文件匹配）
- [ ] `tools/registry-impl.ts` 新增 GlobTool
- [ ] 支持 glob pattern（`**/*.ts`、`src/**/*.test.ts`）
- [ ] readOnly + accesses 声明
- [ ] 测试 + 提交

### 2.2 Grep 工具（ripgrep 封装）
- [ ] `tools/registry-impl.ts` 新增 GrepTool
- [ ] 封装 ripgrep（如未安装则降级到 Node.js 实现）
- [ ] 支持 -i / -n / --type 等常用参数
- [ ] readOnly + accesses 声明
- [ ] 测试 + 提交

### 2.3 TodoList 工具
- [ ] 新建 `context/todo-store.ts`（持久化到 `.claw/todo.json`）
- [ ] `tools/registry-impl.ts` 新增 TodoTool（add/update/toggle/list）
- [ ] Prompt Composer 注入当前 Todo 状态
- [ ] 测试 + 提交

### 2.4 WebSearch + FetchURL
- [ ] `tools/registry-impl.ts` 新增 WebSearchTool
- [ ] `tools/registry-impl.ts` 新增 FetchURLTool
- [ ] 支持配置搜索 API（默认用免费 API 或浏览器抓取）
- [ ] readOnly + accesses 声明（none）
- [ ] 测试 + 提交

### 2.5 Background Tasks（bash 后台化）
- [ ] 新建 `tools/background-manager.ts`
- [ ] BashTool 支持 `background: true` 参数
- [ ] 后台任务有唯一 ID + stdout/stderr 环形缓冲
- [ ] 新增 TaskList / TaskOutput / TaskStop 工具
- [ ] 测试 + 提交

### 2.6 PreToolUse / PostToolUse Hooks
- [ ] `tools/registry.ts` 加 `PreToolUseHook` 和 `PostToolUseHook` 接口
- [ ] `tools/registry-impl.ts` 执行链插入 hook 调用点
- [ ] PreToolUse 可拦截或改写参数
- [ ] PostToolUse 可修改输出
- [ ] 测试 + 提交

### 2.7 edit_file 加 replace_all
- [ ] `tools/registry-impl.ts` fuzzyReplace 增加 `replaceAll` 选项
- [ ] ToolDefinition 更新参数 schema
- [ ] 测试 + 提交

---

## 阶段 3：上下文与控制流增强（P1）

> **目标**：让 Agent 更聪明地管理上下文、更可控地执行任务。

### 3.1 MicroCompaction
- [ ] `context/compactor.ts` 增加旧 tool result 渐进清理策略
- [ ] 按缓存年龄（>1 小时）+ 使用率（≥0.5）触发
- [ ] 旧 tool result 替换为 `[Old tool result cleared]` 标记
- [ ] 保留近 20 条消息完整
- [ ] 测试 + 提交

### 3.2 Steer 机制（运行时注入）
- [ ] `engine/loop.ts` 加 steer queue
- [ ] API call 期间可注入文本，drain 到下一个 tool message
- [ ] CLI 支持 `--steer <text>` 在运行中注入
- [ ] 飞书支持运行中发消息注入
- [ ] 测试 + 提交

### 3.3 undo 回滚
- [ ] `engine/session.ts` 加 undo 方法
- [ ] 回滚到上一个 user prompt 或 compaction 边界
- [ ] CLI 支持 `--undo` 命令
- [ ] 测试 + 提交

### 3.4 deferredMessages
- [ ] `engine/session.ts` 保证 tool 调用顺序完整性
- [ ] tool result 到齐前暂存后续消息
- [ ] 测试 + 提交

### 3.5 Goal Mode
- [ ] 新建 `engine/goal-manager.ts`
- [ ] 状态机：active / paused / blocked / complete
- [ ] budget 支持（tokens / turns / wall-clock）
- [ ] 新增 CreateGoal / GetGoal / UpdateGoal 工具
- [ ] Goal context 在 continuation boundary 注入
- [ ] 测试 + 提交

### 3.6 Plan Review 审批
- [ ] `context/plan-store.ts` 加 ExitPlanMode 触发审批流
- [ ] 审批卡片展示 plan 内容
- [ ] 用户可选 approve / reject / modify
- [ ] 测试 + 提交

### 3.7 shouldContinueAfterStop
- [ ] `engine/loop.ts` 非工具停止后 host 可决定续接
- [ ] 测试 + 提交

---

## 阶段 4：多模型与多端入口（P2）

> **目标**：从"CLI + 飞书"到"多端可用"。

### 4.1 Gemini Provider
- [ ] 新建 `provider/gemini.ts`
- [ ] factory.ts 加 gemini 分发
- [ ] Gemini 原生协议适配（非 OpenAI 兼容）
- [ ] 测试 + 提交

### 4.2 Credential Pool
- [ ] 新建 `provider/credential-pool.ts`
- [ ] 多凭证配置（环境变量或配置文件）
- [ ] 限流时自动轮换
- [ ] 测试 + 提交

### 4.3 REST + WebSocket 协议
- [ ] 新建 `server/` 目录
- [ ] REST API：session / message / approval / tool
- [ ] WebSocket：流式 text-delta + cursor {seq, epoch}
- [ ] 多端同步：volatile 事件不推进 seq
- [ ] 测试 + 提交

### 4.4 ACP 协议适配器
- [ ] 新建 `acp/` 目录
- [ ] stdio 驱动 + initialize/session/prompt 方法
- [ ] IDE 文件桥接（fs/readTextFile / fs/writeTextFile）
- [ ] 4 模式映射（default/plan/auto/yolo）
- [ ] 测试 + 提交

### 4.5 Docker 部署
- [ ] `Dockerfile`
- [ ] `docker-compose.yml`
- [ ] 环境变量配置文档
- [ ] 测试 + 提交

---

## 阶段 5：高级特性（P2 · 按需迭代）

> **目标**：从"能用"到"好用"。按实际需求挑着做。

- [ ] 5.1 AgentSwarm（批量子代理）
- [ ] 5.2 Cron 调度
- [ ] 5.3 Auxiliary Client（辅助模型做压缩/标题）
- [ ] 5.4 Tool Search 渐进披露
- [ ] 5.5 Image / Media 支持
- [ ] 5.6 TUI 界面（Ink/React）
- [ ] 5.7 Rate Limit Tracking
- [ ] 5.8 版本化迁移（JSONL schema 版本号）

---

## 📊 进度统计

| 阶段 | 总任务数 | 完成 | 状态 |
|------|---------|------|------|
| 阶段 1 | 5 | 2 | 🟡 进行中 |
| 阶段 2 | 7 | 0 | 🔴 未开始 |
| 阶段 3 | 7 | 0 | 🔴 未开始 |
| 阶段 4 | 5 | 0 | 🔴 未开始 |
| 阶段 5 | 8 | 0 | 🔴 未开始 |
| **总计** | **32** | **0** | — |

---

## 📝 补充任务（发现的新问题追加到这里）

<!-- 开发过程中发现的新需求，追加到这里，注明发现日期 -->

---

## 📅 变更记录

- 2026-07-06：初始计划创建，基于 Kimi Code + Hermes Agent 调研对比
