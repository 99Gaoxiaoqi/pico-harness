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

并行度固定为三条开发泳道，每条泳道内部按原子交付顺序推进。各原子交付单独提交，前一个提交建立最小稳定接口，后一个提交只扩展本泳道行为；不为了增加代理数量拆分共享写入文件。

## Atomic Deliverables

### 安全泳道

- [x] 12.1a 定义 sandbox 配置、路径/命令/网络判定结果和 fail-closed 错误语义。
- [x] 12.1b 将 workspace-write 与网络策略落实到 Bash 子进程执行边界，覆盖重定向和子进程入口。
- [x] 12.1c 统一 Write/Edit/Bash 的 YOLO 行为，并增加一条工作区内成功、越界确定性拒绝的集成场景。

### 模型泳道

- [x] 12.2a 扩展 route capability schema，并为旧配置提供兼容默认值和明确校验错误。
- [x] 12.2b 在 provider 调用前完成 context/output/vision/reasoning/tool-call/cache/fallback 能力预检。
- [x] 12.2c 汇总当前 route/session 的 usage/context 数据，并提供与 TUI 解耦的 `/usage`、`/context` 命令服务。

### 代码智能泳道

- [x] 12.3a 实现 LSP stdio JSON-RPC 生命周期、超时、取消、退出与 server 发现/降级。
- [x] 12.3b 实现 definitions/references/symbols/diagnostics/call hierarchy 的统一领域接口。
- [x] 12.3c 实现渐进式 Repo Map，并接入 ToolDisclosure/`search_tools`，增加一条临时 TypeScript 仓库集成场景。

### 集成泳道（主代理串行）

- [x] 12.4a 合并三条泳道，统一 config/runtime/registry 接线并解决错误语义冲突。
- [x] 12.4b 接入 `/usage`、`/context` TUI 命令，执行最终最小集成验证并更新路线图。

## Integration Sequence

- [x] 第一波：三条泳道分别完成 12.1a、12.2a、12.3a，尽早固定接口并返回首个可审查提交。
- [x] 第二波：同一 worktree 连续完成 12.1b-c、12.2b-c、12.3b-c，保持文件所有权不变。
- [x] 第三波：主代理在独立集成分支完成 12.4a-b，不允许任务分支直接更新 main。
- [ ] 最终更新 ROADMAP，合并推送 main，并清理本阶段临时 worktree 和分支。

## Validation

- YOLO 主链：工作区内普通读写无审批；工作区外、敏感目录和 hardline 命令无法通过模型提示或 session grant 绕过。
- 模型主链：能力不兼容在发请求前返回明确错误；`/context` 与 `/usage` 使用当前 route/session 的真实数据。
- 代码智能主链：真实临时 TypeScript 仓库可生成 Repo Map，并完成至少一次符号查询或导航；LSP 不可用时明确降级而不拖垮 TUI。
- 最终只运行 Stage 12 相关确定性集成、`npm run typecheck` 和 `npm run build`，不新增单元测试。

## Open Questions

- 无阻塞问题；LSP server 的发现采用“项目配置优先、已安装可执行文件其次、Repo Map 确定性降级”的顺序。
