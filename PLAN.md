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
- `codex/pico-5-1-phase2-agent-registry` 当前占用 `src/tools/subagent.ts` 和 `tests/subagent.test.ts`；其合并前只开发无冲突文件。
- `codex/pico-5-1-phase2-tool-ui` 当前占用 `src/tui/tool-card.tsx` 和 `src/tui/tui-reporter.ts`；UI 展示在其合并后串行接入。
- `src/tools/subagent.ts`、`src/engine/loop.ts`、`src/runtime/agent-runtime.ts` 的最终接线由本功能分支单一所有者完成。

## 任务

- [x] 新增 `src/tools/subagent-spec.ts`，定义并校验临时 Agent 合约；instructions 只能追加安全骨架。
- [x] 扩展 `src/tools/agent-profile.ts`，支持可选 `modelRouteId` 与 `thinkingEffort`。
- [x] 扩展 `src/input/agent-loader.ts`，读取 Claude Agent `model` frontmatter，避免静默忽略。
- [ ] 等 agent-registry 分支合并后，为 `delegate_task` 的单任务与 `tasks[]` 增加受约束的 `agent` 对象。
- [x] 实现解析优先级：临时 Agent → 命名 Profile → 父会话，并通过 `ModelRouter` fail-closed 校验。
- [ ] 新增 `src/runtime/subagent-model-runtime.ts`，为显式 route 构造独立 Provider、CostTracker、Compactor 与 reasoning 配置。
- [ ] 改造 `AgentEngine.runSub` 使用请求级 Model Runtime；未指定时保持当前继承路径。
- [ ] 接入 `agent-runtime`、usage ledger 与 `SubagentActivityEvent`；后台只允许父路由或可信宿主授权路由。
- [ ] 等 tool-ui 分支合并后展示 requested/resolved route、thinking effort 与 fallback。
- [ ] 完成本地集成成功/失败路径、并发隔离测试和一条真实模型自然语言 E2E。

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
