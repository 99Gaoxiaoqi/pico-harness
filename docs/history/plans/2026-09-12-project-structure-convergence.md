# 项目结构收敛任务（2026-09-12）

> 状态：已完成并合入 `main`。本文保留四个串行待办的范围、约束与验证记录。

目标：在不改变公开行为和持久化语义的前提下，按低风险到高风险的顺序收敛文档漂移、退役代码、仓库资产与核心热点文件。四个待办串行处理；每项完成实现、聚焦验证和差异审查后，才进入下一项。

## 待办

- [x] 1. 修正文档事实：统一记忆迁移、工具运行时、CLI 参数与当前架构叙述；修复正文编码损坏；保持历史文档的历史属性。
- [x] 2. 清理无生产入口代码：用生产依赖图和测试证明逐项确认，删除退役 TUI/命令链、死 UI/样式与只由测试保活的生产实现；不得删除仍承担兼容读取的 Evidence 边界。
- [x] 3. 整理仓库资产：归档已完成计划和一次性验收记录，为保留的 prototype / delivery / scratch 资产建立清晰入口或迁移到语义明确的位置。
- [x] 4. 拆分核心热点：优先抽取 `executeAgentRuntime` 与 `DesktopRuntimeService` 的实现协作者；保持公开接口、Runtime 事件、SQLite 事务 owner 与桌面协议不变。SQLite Store 只拆纯投影/codec 协作者，不拆事务所有权。

## 执行约束

- 每次只处理一个待办，不夹带无关重构。
- 子任务在本 worktree 和 `codex/project-structure-convergence` 分支中执行；主代理负责验收、提交与集成。
- 删除前必须同时核对静态入口、动态入口、包入口、脚本与测试；不以“文件名看起来旧”为删除依据。
- 行为改动优先补一条最相关集成回归；纯文档/归档改动执行链接、格式及相关静态检查。
- 每项结束记录实际验证，不把未运行的检查写成通过。

## 完成标准

- 当前事实文档之间无已知矛盾，CLI 帮助只展示真实支持项。
- 已确认的无入口实现及关联死测试/样式被清除，类型与相关集成测试通过。
- `docs/plans/` 只保留仍在执行的本任务，根目录不再承载一次性验收文档。
- 两个最高风险组合根的公开行为保持不变，职责拆分可由文件边界和相关回归验证。
- 最终状态通过架构检查、根类型检查、Desktop 类型检查、构建及风险匹配的集成测试。

## 实际验证记录

- 待办 1：当前文档 U+FFFD 扫描无匹配；`docs/history/` 保留 4 处无法可靠还原的历史损坏。
- 变更 Markdown 相对链接检查通过（15 个文件），Prettier 检查通过（17 个文件）。
- CLI 入口聚焦集成测试通过（5/5），根 `npm run typecheck` 通过。
- 待办 2：删除无入口的旧 in-process TUI/命令链（附加目录、Cron daemon/draft、Markdown/Skill/Plugin 命令、MCP elicitation、旧会话策略/展示与 Tool Result summarizer）；删除已退役且只由测试保活的 EvidenceRef、workspace portability、tool tier 与 TUI rewind 实现。
- 待办 2：删除 test-only `plan` / Workbar panel barrel，测试改为直连活跃实现；`RuntimeEventBoundaryInspector` 仍用于活跃恢复协议断言，已迁入测试 helper。
- 待办 2：删除无 JSX 消费的 Desktop Environment/Inspector 组件、旧 Workbar wrapper、四个公共死组件及专属样式；保留 `ConversationPage` 活跃 inspector 样式。
- 待办 2：根 typecheck、Desktop typecheck、严格架构检查、变更 TS/TSX ESLint/Prettier 与 `git diff --check` 通过；Desktop 29 项、Runtime/工具 69 项、TUI 12 项聚焦集成测试全部通过。
- 待办 2：`EvidenceArchive` / `EvidenceBlobStore`、agent-graph evidence authority 与 TUI inspector legacy evidence 安全读取保持不变。
- 待办 3：三份已结束计划、子智能体能力卡片验收与已落地的 Pico/Maka 故障流程调研已迁入 `docs/history/`；Desktop 全流程原型迁入 `apps/desktop/prototypes/` 并保留预览入口。
- 待办 3：Terminal-Bench 交付状态仍为 `release-readiness: active`，发布、观察与接受待完成，因此保留 `.delivery/` 机器工作流原位并在文档索引说明。Windows 内网包说明与双击 TUI 入口互相引用后保留根目录。
- 待办 3：旧资产路径全仓引用扫描无残留；变更 Markdown 相对链接、Prettier 和 `git diff --check` 通过；原型 JavaScript 语法检查通过，本地 HTTP 预览的 HTML / JS / CSS 均返回 200。
- 待办 4：`executeAgentRuntime` 将主 Provider / 子代理模型路由装配下沉到 `runtime-assembly.ts`，将 Hook 模型运行端口下沉到 `runtime-hook-assembly.ts`；顶层函数保留装配顺序和资源生命周期，`agent-runtime.ts` 由 3444 行降至 3242 行。
- 待办 4：`DesktopRewindService` 接管 rewind 的进程内幂等状态、耐久 claim 与 fork/file 事务流程；`DesktopRuntimeService` 只提供 Session/信任端口并维持原通知顺序，主文件由 4488 行降至 4271 行。`SqliteRuntimeEventStore` 未参与本轮拆分，避免为形式收口扩大 lease/事务 owner 风险。
- 待办 4：Provider/子代理、Hook 与 Rewind 聚焦集成回归 33/33 通过；根 typecheck、Desktop typecheck、变更文件 ESLint/Prettier、严格架构检查、build 与 `git diff --check` 通过。全量确定性集成测试 1621 项：1609 通过、12 跳过、0 失败。
- 最终审查：Tool Result 文档已改为当前 1 MiB inline/超限合成错误契约；Desktop 全流程原型中的能力缺口已明确限定为冻结时点，不代表当前产品状态。
