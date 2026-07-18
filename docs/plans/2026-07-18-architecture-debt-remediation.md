# Pico Harness 架构债务修整任务

> 状态：D1/D2 已实施；D3 窄拆与 Desktop parity 已实施；大规模拆分仍按停止条件保留
> 建立日期：2026-07-18
> 基线：`main@81ff999`
> 设计依据：[架构债务解释与修整方向](../architecture/09-architecture-debt-remediation.md)

## Approach

先闭环 CLI durable transcript 恢复，再统一 Markdown 的渲染、测量和裁剪模型。两项行为债务验收完成后，才允许对 `AgentRuntime` 做有停止条件的窄内部整理；`Session` 和跨 Agent 并发协议不在本轮重构范围。

## Scope

- In:
  - CLI TranscriptEvent 的低频语义持久化与恢复。
  - 旧 Session 的 Message 水合兼容路径。
  - Markdown terminal render model、行高测量、虚拟裁剪和流式渲染。
  - `AgentRuntime` 的窄执行边界提取与相关文档更新。
  - Desktop transcript/reasoning/Markdown parity。
- Out:
  - 重写 `Session`、`RuntimeEventStore` 或 Desktop transcript owner。
  - 持久化逐 token delta、spinner 帧或原始 stdout/stderr 小块。
  - DI 容器、Service Locator、Repository 框架或通用 Runtime Context。
  - Shared Worker、跨 Agent 文件锁或 OCC。
  - Provider、模型路由和工具协议功能扩展。

## Action Items

- [x] 1. 添加 CLI 恢复回归测试，覆盖 reasoning、稳定 ID、结构化事件优先级和旧 Session Message 兼容恢复。

- [x] 2. 定义 durable Transcript 事件策略，复用现有 `Session.recordTranscriptEvent()`，只持久化语义稳定事实。

- [x] 3. 接入 TUI Transcript sink，使用幂等 runtime event ID、Session persistence queue 和串行 flush，不建立第二个存储文件。

- [x] 4. 修改 `hydrateTuiReporter()`：结构化事件直接水合同一 `TranscriptEventStore`；旧数据才走 Message fallback，避免重复 assistant/tool entry。

- [x] 5. 验证 Transcript 闭环：覆盖最终 reasoning/answer、重复恢复、旧会话和 UI-only clear，并确认 delta 不进入 durable sink。

- [x] 6. 提取 `TerminalMarkdownModel`，由 `marked` Token tree 统一生成终端渲染与视觉行，并保持安全过滤和 thinking `dimColor`。

- [x] 7. 让 `MarkdownText`、`TranscriptLayout`、`MessageList`、`MessageRow` 和 `StreamingText` 共用 `render/measure/clip` 模型。

- [x] 8. 调整流式 Markdown：采用完整文档重解析，移除按最后换行符切 stable/unstable 的语义拆分，并加入行高/裁剪回归。

- [x] 9. 有条件整理 `executeAgentRuntime()` 与 `Session`：已提取无资源所有权的 `RuntimeRunExecutor`、纯内存 `SessionMessageLedger`，以及只负责路由/LRU/TTL/pin 的 `SessionManager`；RuntimeEventStore、owner lease、rewind、FileHistory 和 cleanup 仍由原 owner 负责。

- [x] 10. 补齐 Desktop transcript/reasoning/Markdown parity：新增 `thinking` 协议项、结构化 Skill/system 投影、marked Token renderer、危险链接/HTML/控制字符过滤，以及 Desktop Skill durable entry。

- [x] 11. 完成最终验证和文档同步：已通过 lint、typecheck、build、Desktop typecheck、format check、git diff --check，以及 201 个集成测试（193 通过、8 个平台跳过）。

## Milestone Acceptance

### M1：Durable Transcript

- TUI 恢复前后条目顺序、可见内容和稳定 ID 一致。
- reasoning、Skill、system feedback 和子代理终态可恢复。
- 旧 Session 没有 transcript events 时仍按 Message 恢复。
- Message 与 TranscriptEvent 不产生重复 assistant/tool 条目。
- durable 事件增长按语义事件计数，不按 token/chunk 计数。

### M2：Terminal Markdown Model

- 同一内容和宽度下，测量行数与 Ink 最终帧一致。
- 虚拟裁剪结果等于完整渲染后的视觉行切片。
- 围栏代码、嵌套列表、引用、表格、未闭合语法和 CJK 换行通过回归测试。
- 流式渲染不因最后一个换行符拆断 Markdown 块语义。
- 控制字符、HTML 和危险链接安全测试保持通过。

### M3：Composition Root 与 Session 窄边界

- `RuntimeRunExecutor` 对外类型和执行语义不变。
- Session、MCP、Plugin、Hook 和 Provider 的所有权与清理次数不变。
- `SessionMessageLedger` 只拥有纯内存消息派生状态，不拥有 durable writer。
- 新函数具有窄输入输出或独立资源生命周期，并能独立测试。
- 未引入通用依赖容器或第二状态 owner。

### M4：Desktop parity

- Desktop transcript 可恢复 reasoning、Skill、system 和稳定 ID。
- Assistant/thinking 使用 marked Token renderer，危险链接、HTML 和控制字符不会进入 DOM。
- 不新增逐 token durable timeline 或第二事实源。

## Suggested Commit Boundaries

1. `test(TUI): 固定会话转录恢复缺口`
2. `fix(TUI): 恢复持久转录事件`
3. `test(TUI): 固定 Markdown 行模型`
4. `refactor(TUI): 统一 Markdown 渲染测量与裁剪`
5. `refactor(runtime): 收敛运行时装配边界`（仅命中 M3 条件时）
6. `docs(architecture): 记录架构债务修整结果`

## Stop Conditions

- Transcript 方案需要逐 token durable 写入时停止，改为最终态聚合设计。
- Markdown 模型要求复制一套 Markdown parser 时停止，继续以 `marked` Token 为唯一语法来源。
- `AgentRuntime` 提取导致参数袋、循环依赖或资源所有权不清时停止拆分。
- `Session` 拆分需要跨 owner 事务、重复 lease 或双写时停止。
- 任何阶段恢复第二事实源、长期 fallback 或 Shared Worker/OCC 时停止并重新评审。

## Decisions

- CLI 采用现有 `TranscriptEvent` 语义事件和 Session sink；不持久化逐 token delta、phase 或原始 stdout/stderr。
- Markdown 第一版每次完整解析；若后续基准证明帧率不足，再单独引入已完成块缓存。
- Desktop 实时逐 token reasoning、engine/runtime 全面解耦和 AgentRuntime/Session 大规模拆分保留为后续独立任务。
