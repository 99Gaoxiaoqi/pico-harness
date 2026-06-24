# Session-scoped Artifact 生命周期设计

## 背景

`ToolResult` 外部化的目标不是把上下文压力转移成磁盘压力，而是把“大段原文”从模型上下文中拿出来，同时保留可追溯、可清理的生命周期。

当前实现已经能把大输出写入 session-scoped artifact store，并在上下文中留下 typed observation。session-scoped lifecycle 用来避免多个会话共用同一个 artifact 池后产生残留、串读或磁盘膨胀。

## 当前问题

### TTL 不是自动删除

`ttlHours` 只是 metadata 里的过期资格，不代表文件会在时间点到达时自动消失。没有后台任务、没有下一次 cleanup、没有显式 sweep 时，过期 artifact 会继续留在磁盘上。

因此文档和 API 命名都应该避免暗示“设置 TTL 等于定时删除”。更准确的语义是：artifact 在 `createdAt + ttlHours` 后可以被 cleanup 删除。

### cleanupAfterWrite 只是顺手清理

写入后的 cleanup 是 opportunistic cleanup：它依附在一次新的 artifact write 后执行，用来顺手回收已过期或超过 quota 的文件。

它不是可靠的生命周期边界：

- 长时间没有新写入时，过期文件不会自动清理。
- cleanup 失败不应该让工具结果写入失败，只能记录 warning。
- 它不等价于删除 session，也不应该承担会话销毁的职责。

### 删除 session 应显式删除 session artifacts

当用户、CLI run、飞书会话或未来的持久化 session 被删除时，属于该 session 的 artifacts 应该随 session 显式删除。这个动作和 TTL/quota 无关，也不受 pinned 保护。

`pinned` 的语义是“不要被 TTL cleanup 或 global quota sweep 误删关键证据”。如果 session 本身被删除，pinned artifact 也属于这个 session 的数据边界，应该一起删除。

### 当前与未来的物理 session 隔离

当前 `Session` 已经在内存历史与 `workDir` 上形成会话隔离，但 artifact store 仍使用全局目录：

```text
.claw/artifacts/tool-results/<artifactId>.*
```

这会带来两个问题：

- session 删除很难通过目录边界完成，只能全局扫描 metadata。
- 不同 session 的 artifact 文件混在一起，调试和人工清理成本高。

当前 artifact 也纳入物理 session 隔离，让每个 session 拥有自己的 artifact 子树。

## 建议目录结构

建议路径：

```text
.claw/artifacts/sessions/<safeSessionId>/tool-results/<artifactId>.*
```

示例：

```text
.claw/artifacts/sessions/feishu_chat_A/tool-results/tool-result-1700000000000-1.txt
.claw/artifacts/sessions/feishu_chat_A/tool-results/tool-result-1700000000000-1.json
```

约定：

- `<safeSessionId>` 必须是文件系统安全 ID。当前实现对安全字符保持可读原值；包含不安全字符时使用清洗名加 hash 后缀，避免路径穿越和常见碰撞。
- metadata 里同时保留原始 `sessionId` 和物理路径使用的 `safeSessionId`，方便追踪和审计。
- `artifactId` 继续使用安全 ID，不允许路径穿越。
- session 目录是 cleanupSession / deleteSession 的物理边界。

## 生命周期动作

### writeToolResult

写入工具输出原文和 metadata。写入时可以触发 `cleanupAfterWrite`，但它只是 opportunistic cleanup。

建议 metadata 字段：

- `id`
- `sessionId`
- `safeSessionId`
- `toolName`
- `argsHash`
- `createdAt`
- `sizeBytes`
- `ttlHours`
- `pinned`
- `summary`
- `path`

### cleanupSession

清理某个 session 的 artifact 子树，但保留 session 本身。适用于压缩、重试、临时任务收尾等场景。

关键语义：

- 只删除目标 session 的 artifact。
- 不扫描和删除其它 session。
- 不受 global quota 顺序影响。
- 是否删除 pinned 取决于调用意图：普通 session cleanup 可保留 pinned；deleteSession 必须删除全部。

### deleteSession

删除 session 状态时同步删除该 session 的 artifacts。这里的删除是生命周期边界，不是空间优化。

关键语义：

- 删除目标 session 的 history / working memory / session metadata。
- 删除 `.claw/artifacts/sessions/<safeSessionId>/` 下的 artifacts。
- pinned 不阻止删除。
- 不影响其它 session。

### cleanupExpired

按 TTL 删除过期且未 pinned 的 artifact。可以限定在某个 session 内，也可以做全局扫描。

关键语义：

- TTL 只是 eligibility。
- 没有 cleanup 调用就不会自动发生。
- pinned 默认保留。

### sweepGlobalQuota

当整个 artifacts 根目录超过磁盘 quota 时，从全局维度删除最旧的未 pinned artifact。

这个动作需要跨 session，因为 quota 保护的是整个 `.claw/artifacts` 目录，而不是某一个 session。

## global quota sweep 的意义

global quota sweep 是磁盘兜底机制，不是上下文策略。

它不是 QuickSwap：

- QuickSwap / context compaction 决定模型上下文里保留什么 observation、摘要或短期引用。
- global quota sweep 只决定磁盘上哪些原文 artifact 可以被删除。

它也不是 session 删除：

- session 删除以会话生命周期为边界，目标是清掉某个 session 的数据。
- global quota sweep 以总磁盘占用为边界，目标是保护 `.claw/artifacts` 不无限增长。

推荐规则：

- 统计 `.claw/artifacts` 下所有 session 的 artifact 总大小。
- 超过 `maxTotalBytes` 时，按 `createdAt` 从旧到新删除未 pinned artifact。
- pinned artifact 默认跳过，除非进入更高等级的人工确认或硬上限策略。
- 删除时同步删除内容文件与 metadata 文件。

## ToolResult 使用寿命判断

`ToolResult` 的信息通常会跨几轮使用，而不是只在工具返回后的下一轮使用。比如测试失败输出可能在“定位错误 → 修改代码 → 再跑测试 → 对照错误是否变化”的几轮中持续有价值。

但这不意味着大段原文都应该长期保留在上下文或磁盘里。

建议判断方式：

- **短期原文 artifact：** 大段日志、构建输出、搜索结果、完整文件片段。它们适合写入 artifact，保留几小时到几天，供需要深挖时读取。
- **长期摘要：** 错误类型、文件行号、失败命令、关键 stack frame、测试 suite 名称、用户真正依赖的结论。它们适合进入 session history 或 tracing。
- **关键片段：** 中间错误行、断言 diff、`TSxxxx` 诊断、失败路径。它们应进入 typed summary，即使原文之后被 TTL 或 quota 清掉，模型也不丢主线。
- **长期 pinned：** 少量关键失败证据可以 pinned，避免被 TTL 或 quota sweep 过早删除。但 pinned 不应替代 session 删除。

一句话原则：大段原文偏短期，摘要和关键片段偏长期。

## 集成测试草案

新增 `tests/artifact-lifecycle.integration.test.ts` 覆盖当前 session-scoped artifact lifecycle API。

测试覆盖：

- 删除 session 后，目标 session 的 artifact 文件从磁盘消失。
- `cleanupSession` 只影响目标 session，不影响其它 session。
- global sweep 在总 quota 超限时跨 session 删除最旧的未 pinned artifact，并保留 pinned artifact。

这些测试应随 artifact-store/session/observation 的生命周期语义变化同步更新。
