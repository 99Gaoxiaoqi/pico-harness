# 阶段 12：可信 YOLO 与代码智能开发计划

## Approach

阶段 12 保持 `pico → TUI` 单入口，将安全边界、模型能力和代码智能拆成三个独立 worktree 并行实现。各任务先提供可独立复用的领域模块，`ROADMAP.md`、共享 TUI 命令接线、最终集成验证和目标分支更新由主代理串行完成。

## Scope

- In:
  - 默认 YOLO 下的 workspace-write、敏感路径、危险命令和网络硬边界。
  - 模型路由能力元数据、请求前能力预检、Usage/Context 查询。
  - LSP 生命周期、代码导航工具和渐进式 Repo Map，并接入工具渐进披露。
- Out:
  - 恢复 headless CLI、REST/WebSocket、ACP、Cron、Docker 或 Plugin runtime。
  - Stage 13 的 Agent Worktree Supervisor 和 MCP OAuth/resources/prompts。
  - 新增单元测试或为同一行为建立多层重复覆盖。

## Parallel Ownership

- `feat/stage12-yolo-sandbox`：`src/safety/`、YOLO sandbox policy、工具执行硬边界和对应集成场景；不修改模型路由、LSP 或共享 TUI 命令文件。
- `feat/stage12-model-capabilities`：provider route capability schema、usage/context service、请求前预检和命令 handler；共享命令注册只提供可合并的最小接线。
- `feat/stage12-lsp-repo-map`：LSP client/manager、Repo Map、代码智能工具与 tool tier/disclosure；不修改模型路由和审批策略。
- 主代理：`ROADMAP.md`、`src/tui/repl.tsx`、`src/tui/runtime-state.ts`、共享 registry/config 接线、最终集成分支和 main。

## Action Items

- [ ] 定义 Stage 12 公共配置、错误语义和共享接线边界，保护现有 Session/TUI-only 契约。
- [ ] 实现 YOLO sandbox policy，使普通工作区操作无审批，越界、敏感路径和 hardline 操作由宿主确定性拒绝。
- [ ] 实现网络策略与 Bash/工具执行一致的硬边界，避免通过 shell、重定向或子进程绕过。
- [ ] 扩展 model route capability 元数据，并在请求前校验 context/output/vision/reasoning/tool-call/cache/fallback 约束。
- [ ] 实现会话级 usage/context 汇总与 `/usage`、`/context` TUI 输出。
- [ ] 实现可管理的 LSP JSON-RPC 生命周期和 definitions/references/symbols/diagnostics/call hierarchy 能力。
- [ ] 实现渐进式 Repo Map，并把 LSP/Repo Map 工具接入 `search_tools` 与 ToolDisclosure。
- [ ] 在独立集成分支串行接通共享 runtime/config/TUI 文件，检查跨任务语义和降级路径。
- [ ] 只新增最小跨模块集成覆盖，并在最终状态运行相关集成场景、typecheck 与 build。
- [ ] 更新 ROADMAP 勾选状态，合并推送 main，并清理本阶段临时 worktree 和分支。

## Validation

- YOLO 主链：工作区内普通读写无审批；工作区外、敏感目录和 hardline 命令无法通过模型提示或 session grant 绕过。
- 模型主链：能力不兼容在发请求前返回明确错误；`/context` 与 `/usage` 使用当前 route/session 的真实数据。
- 代码智能主链：真实临时 TypeScript 仓库可生成 Repo Map，并完成至少一次符号查询或导航；LSP 不可用时明确降级而不拖垮 TUI。
- 最终只运行 Stage 12 相关确定性集成、`npm run typecheck` 和 `npm run build`，不新增单元测试。

## Open Questions

- 无阻塞问题；LSP server 的发现采用“项目配置优先、已安装可执行文件其次、Repo Map 确定性降级”的顺序。
