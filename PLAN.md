# 子代理模型路由与自然语言临时 Agent 开发计划

## 目标

- 允许预定义子代理通过稳定的 `provider/model` 路由指定模型。
- 允许用户用自然语言创建一次性子代理，由主模型生成受约束的结构化 `AgentSpec`。
- 未指定模型时保持继承主会话模型，并隔离不同子代理的 Provider、fallback 与凭证状态。

## 范围

- 包含：临时 `AgentSpec`、持久 Agent Profile、Claude Agent `model` 兼容、路由校验、子代理独立 Model Runtime、用量与活动事件中的 resolved route。
- 不包含：自动持久化自然语言 Agent、任意 endpoint/API Key、动态扩大工具权限、第一版跨 Provider 自动 fallback。

## 并发与文件所有权

- 本功能在 `codex/subagent-model-routing` 独立 worktree 开发，不修改主工作区已有未跟踪文件。
- 旧 `agent-registry` / `tool-ui` 分支已确认基于过期主线且与当前实现冲突，不再整体合并，也不再作为文件所有权阻塞。
- `src/tools/subagent.ts`、`src/engine/loop.ts`、`src/runtime/agent-runtime.ts` 的最终接线由本功能分支单一所有者完成。

## 任务

- [x] 新增 `src/tools/subagent-spec.ts`，定义并校验临时 Agent 合约；instructions 只能追加安全骨架。
- [x] 扩展 `src/tools/agent-profile.ts`，支持可选 `modelRouteId` 与 `thinkingEffort`。
- [x] 扩展 `src/input/agent-loader.ts`，读取 Claude Agent `model` frontmatter，避免静默忽略。
- [x] 为 `delegate_task` 的单任务与 `tasks[]` 增加受约束的 `agent` 对象。
- [x] 实现解析优先级：临时 Agent → 命名 Profile → 父会话，并通过 `ModelRouter` fail-closed 校验。
- [x] 新增 `src/runtime/subagent-model-runtime.ts`，为显式 route 构造独立 Provider、CostTracker、Compactor 与 reasoning 配置。
- [x] 改造 `AgentEngine.runSub` 使用请求级 Model Runtime；未指定时保持当前继承路径。
- [x] 接入 `agent-runtime`、usage ledger 与 `SubagentActivityEvent`；后台只允许父路由或可信宿主授权路由。
- [x] 展示 requested/resolved route、thinking effort 与 fallback（首版 fallback 为禁用）。
- [x] 完成本地集成成功/失败路径和并发隔离测试。
- [x] 添加真实模型自然语言 E2E，覆盖自然语言生成 `delegate_task.agent` 与 route 解析。
- [x] 在具备真实凭证的环境执行 DeepSeek 主代理 → GLM 子代理自然语言路由 E2E。

## 验收标准

- 用户可说“创建一个使用 X 模型的只读审查子代理”，无需预先创建配置文件。
- 指定 route 只影响该子代理；主 Agent 与其他子代理不受其 fallback/凭证状态影响。
- 未指定 route 时行为与当前版本一致。
- 无效、歧义或缺凭证 route 在 Provider 网络调用前失败。
- 临时 instructions 不能覆盖安全骨架或扩大 explore/worker 权限。
- 后台执行不能绕过 `credentialRef` 的工作区与模型路由绑定。

## 验证

- 运行相关集成测试和 `npm run typecheck`。
- 若修改 TUI，再运行对应 TUI 测试。
- 在最终代码状态运行一条真实模型 E2E，验证自然语言到 `delegate_task.agent` 的主路径。
- 合并前同步最新 `origin/main`，重新检查冲突文件和最终差异。

## 当前验证状态

- Node 22：合并后的 Hooks、Cron、命令、Runtime、子代理与 TUI 回归 39 个文件、301 条测试通过。
- `npm run lint`、`npm run typecheck`、`npm run build` 通过。
- `npm audit --audit-level=high`：0 个漏洞。
- 真实模型 E2E：DeepSeek 主代理根据自然语言创建临时 Agent，并将子代理路由到 GLM，1 条通过。

## 合并状态

- 已基于包含自然语言 Cron、Hooks 与 MCP 修复的主线 `c632264` 完成集成。
- 冲突处理保留了双方语义：Claude Agent 同时支持 `hooks` 与 `model`，Runtime 同时保留 Hook 计费归属与子代理模型路由，命令测试同时覆盖两类 frontmatter。
- 合并后的本地回归、静态检查、构建、安全审计及 DeepSeek → GLM 真实模型 E2E 均已通过。

---

# Pico 原生内核与 Claude Code 资源兼容计划

## 目标与架构

- Pico 配置、运行状态、信任、模型路由和生命周期保持原生，不依赖 Claude Code CLI、SDK 或安装目录。
- 项目资源统一到 `.pico/`，用户资源统一到 `$PICO_HOME`，工作区状态统一到 `$PICO_HOME/workspaces/<workspace-id>/`。
- `.claude` 与 `.claude-plugin` 仅作为只读兼容输入，经统一资源编译管线转换为 Pico 内部贡献模型。
- 声明型资源自动发现；Hook、MCP、LSP、Shell 插值和可执行文件必须经过工作区信任和内容指纹授权。

## 实现任务

- [ ] 建立 Pico Home、项目资源和工作区状态路径抽象，迁移 `.claw` 原生配置与运行状态。
- [ ] 合并 Skill、Command、Agent 的重复扫描器，固定项目 Pico > 项目 Claude > 用户 Pico > 用户 Claude > builtin 的优先级。
- [ ] 实现 Pico 原生 Plugin manifest 与 Claude Code Plugin 适配器，支持默认目录、可选 manifest、根 `SKILL.md` 和自定义组件路径。
- [ ] 将 Plugin Skills、Commands、Agents、Hooks、MCP、LSP、`bin/`、用户配置和本地依赖接入现有运行时。
- [ ] 为 Plugin 执行型贡献实现内容指纹、授权失效、路径边界和符号链接保护。
- [ ] 将 Claude Plugin Agent 纳入统一 Agent Catalog 和自然语言委派，兼容 `inherit` 与 Claude 模型别名。
- [ ] 增加 Plugin 管理命令、资源来源和兼容状态诊断；未支持组件必须显示 degraded/blocked。
- [ ] 完成迁移、兼容导入、信任、命名空间、变量、模型路由和无 Claude CLI 环境的集成测试。

## 默认兼容边界

- 默认读取项目和用户的 Claude Skills、Commands、Agents；Pico 原生资源始终优先。
- Claude Plugin 可原样放入 `.pico/plugins/<name>` 或 `$PICO_HOME/plugins/<name>`，也可通过显式本地路径加载。
- 第一阶段支持 Skills、Commands、Agents、Hooks、MCP、LSP、用户配置和本地依赖。
- `outputStyles`、themes、monitors、channels 和远程 marketplace 暂不实现，但不得静默忽略。

## 协作与验收

- 公共路径、配置 Schema、统一贡献类型和运行时接线由集成分支单一所有者维护。
- 并行任务只修改独立模块；`markdown-command-loader`、资源 Catalog、锁文件和共享配置串行集成。
- 验收要求包括原样 Claude Plugin fixture、自然语言 Claude Agent 委派、执行型贡献信任、`.claw` 迁移与 worktree 状态隔离。
- 最终在最新 `origin/main` 上通过 lint、typecheck、build、全量测试、安全审计和无 `claude` CLI 的打包 smoke。

---

# 2026-07-14 main 全面 Review 修复计划

## 目标与决策

- 修复全面审查中已复现或代码确认的高风险问题，并补充针对性集成测试。
- Agent 配置以本产品原生 `AgentProfile` / `.claw/agents.yaml` 为唯一运行时事实源。
- `.claude/agents/*.md` 作为兼容输入，经适配器归一化后使用；不得与原生 Profile 按名称隐式拼接权限、模型或 Hooks。
- 并行开发仅处理文件边界清晰的任务；`agent-runtime.ts` 与 Agent 配置统一由单一所有者串行集成。

## 第一批并行任务

- [x] `codex/review-session-tui`：按 `(cwd, sessionId)` 隔离 SessionSettings；修复失效模型路由恢复迁移；补集成测试。
- [x] `codex/review-cron-daemon`：避免 claim 前异常遗留 queued Run；串行化 workspace registration 与 runtime refresh；补并发/恢复测试。
- [x] `codex/review-runtime-budget`：将 AgentRuntime 初始化纳入可靠清理边界；让子代理计入 Token/成本预算；补失败与预算测试。

## 串行集成任务

- [x] 在 `codex/review-fixes-integration` 审查并合并三个任务分支。
- [x] 统一 `.claude/agents` 兼容导入与 `.claw/agents.yaml` 原生 Profile 的解析、优先级和权限语义。
- [x] 处理剩余中风险契约：Markdown command 的模型/工具收窄、显式 Skill Hooks、短生命周期异步委派拒绝。
- [x] 处理 CLI 参数优先级，并修正 TERM=dumb 恢复与 TUI 路由展示。
- [x] 更新真实模型 E2E 的过期契约、Schema 与安全 fixture；恢复本地测试契约。
- [x] 按 `realpath(cwd) + sessionId` 统一隔离 Session settings、会话授权与 CLI resume/fork 语义缓存。
- [x] 按大小写不敏感的 canonical name 合并 Agent 目录，native 无效/空权限声明作为 tombstone 阻止低优先级回落。
- [x] Hook executor 在 dispose 时等待进程树终止屏障（POSIX 进程组 / Windows `taskkill /T /F`），降级 HookRunner 也纳入 Registry drain；同时固化 PostToolUse 仅接收截断后输出的契约。
- [x] 在最终代码状态运行 lint、typecheck、build、全量集成测试、PR-safe E2E、相关真实模型 E2E 和格式检查。

## 最终验证（2026-07-14）

- Node 22 全量测试：238 files / 2292 tests 通过，2 files / 27 tests 按条件跳过。
- PR-safe E2E：9 files / 25 tests 通过。
- 真实模型 E2E：15 files / 45 tests 通过，2 tests 按条件跳过；包含 DeepSeek 主代理自然语言创建临时 Agent 并路由到 GLM 子代理。
- lint、typecheck、build、Prettier、TUI/package smoke 通过；`npm audit --audit-level=high` 为 0 漏洞。

## 已确认的后续增强（不阻断本轮）

- 子代理显式 route 的 route-aware fallback 与多凭证轮换：必须继续通过 ModelRouter 校验 endpoint/凭证，不恢复裸模型 fallback。
- Worker 子代理 provider call 的 durable `attemptId` 归属：需由 RuntimeStore/WorktreeSupervisor 传入可信 attempt 真值。
- 自定义 embedding host 的 `credentialRef` 二次校验；当前第一方 production host 已 fail-closed，生产路径不可达。

## 合并与冲突约束

- 三个子任务分别使用独立 worktree 和唯一分支，只提交各自范围，不更新 `main`。
- `src/runtime/agent-runtime.ts`、Agent Profile/loader、锁文件、Schema 与公共配置由集成线单一所有者处理或审查。
- 子任务完成后先合并到独立集成分支；验证失败不得更新 `main`。
- 合并前再次确认 `origin/main` 是否前移；含义不明确的冲突停止自动处理。
