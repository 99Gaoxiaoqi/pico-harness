# pico-harness 上下文管理：语义压缩与 Tool Result 入口定形

> 文档状态：Compaction 的动机与批次边界仍可参考；本页的 Tool Result 入口契约已按
> [决策记录 26](../decisions/26-decision-tool-result-entry-shaping.md)校准。具体实现见
> `src/tools/tool-result-observation.ts`，上下文读取与压缩细节仍需回查当前 `src/context/` 与
> `src/engine/`。

> 本文记录 pico-harness 如何管理 Agent 运行时的上下文窗口——当对话历史不断增长、工具返回结果越来越庞大时，系统如何通过入口上限、读取侧投影与语义压缩把上下文控制在 LLM 窗口内。

---

## 一、问题：上下文窗口是稀缺资源

大模型 Agent 运行在一个基本约束下：**每轮推理的输入 token 不能超过上下文窗口**。一个 128K 窗口听起来很大，但很快就会被消耗殆尽：

- 系统提示 + 工具 Schema：固定占 5K-15K token
- 每轮对话历史：用户输入 + 模型回复 + 工具调用 + 工具结果
- 单次工具返回的暴击：`read_file` 一个大文件、`bash` 一条编译命令的输出、`grep` 匹配数百条结果

一个真实场景：Agent 读了一个 2MB 的日志文件，返回结果约 50 万 token——远超任何模型的窗口。如果这单条结果直接进上下文，后续所有推理都会失败。

pico-harness 把这个问题拆成两个层面解决：

1. **Tool Result 入口层**：单条结果必须先通过 1 MiB 字节上限，超限结果被拒绝并替换为有界合成错误。
2. **上下文读取层**：限内结果完整 inline 入库；模型读取时再按预算投影，历史总量逼近窗口时压缩旧前缀。

---

## 二、Tool Result 处理：1 MiB 入口上限与 inline 事实

### 当前契约

pico 不再按 token 阈值把新 Tool Result 分流到 Evidence CAS。`buildRuntimeToolResultProjection`
先按 UTF-8 字节数执行 `MAX_TOOL_RESULT_BYTES = 1024 * 1024` 的入口检查：

```text
工具物理输出
  ├─ ≤ 1 MiB ──→ 全文以 storage: "inline" 写入 canonical RuntimeEvent
  │               Provider 投影为 mode: "full"
  └─ > 1 MiB ──→ 原始输出不落盘
                  有界重取指引以 storage: "inline" 写入 canonical RuntimeEvent
                  Provider 投影为 mode: "synthetic"
```

限内结果的 canonical 正文是工具物理输出；Recovery 指引可以只进入 Provider 投影，不改写
canonical 正文或完整性元数据。超限时，canonical 正文和 Provider 投影都使用合成错误，说明
原始字节数并引导模型通过 `grep`、`head`、`tail` 或 `read_file` 的 `offset`/`limit` 有界重取。
原始超限正文会永久丢弃，因此不能把入口门描述成“截断但可回读”。

新结果不生成 `pico://evidence/...` 引用，也不再提供 `read_evidence` 回读。旧账本中的
`storage: "evidence"` / `mode: "preview"` 只在兼容读取边界容忍，不能为当前 Turn 扩权或
恢复已经退役的写入协议。

### 读取侧瘦身

入口定形与模型上下文瘦身是两个独立阶段。限内原文先完整写入事实库；随后上下文组装按当前
预算生成有界读取视图，必要时进入下面的 Compaction 降级链。读取侧投影不会回写或替换
canonical RuntimeEvent。

### 各工具自身的输出自限

部分工具会在自身边界内分页、截断或限制缓冲，这是进入统一入口门之前的局部保护，不改变
Runtime 的 1 MiB 最终准入契约。调用方需要完整大文件或长命令输出时，应主动使用分页参数或
Shell 管道生成小于入口上限的结果。

---

## 三、语义压缩：当历史总量逼近窗口

Tool Result 入口门解决的是“单条暴击”，读取侧投影也会约束每轮模型视图；但历史消息累积到
一定轮数后仍然会逼近窗口。这时候就需要**语义压缩**——把旧前缀浓缩成一份结构化摘要。

### 触发机制：双触发 + 三级降级

pico 的压缩不是单一触发点，而是一个分层的降级链：

```
┌─────────────────────────────────────────────────────────────┐
│ 第 1 级：字符级投影（零成本）                                  │
│   工具结果 commit 后 → midTurn 检查 75% 水位                  │
│   旧 ToolResult → 1 行摘要 [工具 X 输出已清理,原始 N 字符]     │
└──────────────────────┬──────────────────────────────────────┘
                       │ 仍超水位
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 第 2 级：LLM 摘要（昂贵）                                     │
│   prepareModelContext 检查 85% 水位                           │
│   旧前缀 → 6 段结构化摘要（真实 LLM 调用）                    │
└──────────────────────┬──────────────────────────────────────┘
                       │ LLM 摘要也失败（fail-open 不抛错）
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 第 3 级：overflow 紧急压缩                                    │
│   Provider 返回 400 ContextOverflowError                     │
│   更紧目标（10% 保留）再压一次                                │
└──────────────────────┬──────────────────────────────────────┘
                       │ 紧急压缩也失败
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 第 4 级：硬重置兜底                                           │
│   清空历史，保留当前请求 + 结构化证据快照                      │
└─────────────────────────────────────────────────────────────┘
```

#### 水位计算

上下文预算的基线是 `inputBudgetTokens`：

```
inputBudgetTokens = contextWindowTokens - maxOutputTokens - safetyMargin(1024)
```

例如 128K 窗口、4K 输出：`inputBudgetTokens = 128000 - 4096 - 1024 = 122880`。

两个触发水位：

- **midTurn 75%**（`MID_TURN_COMPACT_TRIGGER_RATIO`）：工具结果落地后立即检查，更激进，提前介入
- **prepareModelContext 85%**（`DEFAULT_AUTO_COMPACT_TRIGGER_RATIO`）：下一轮 Provider 调用前检查

#### midTurn proactive 压缩

midTurn 是"轮内主动"压缩——在一个用户 turn 内，工具批量执行产生大量结果后，**不等下一轮发现溢出，立刻检查是否需要压缩**（`src/engine/loop.ts:1048`）：

```typescript
// 主循环里，工具结果 commit 后、下一轮 prepareModelContext 前
await this.runMidTurnCompaction(session, turnSpan, signal);
```

它的估算优先用 **provider 上一轮返回的真实 token**（`lastAnchoredPromptTokens`），而非 BPE 估算：

```typescript
let estimatedInput: number;
if (this.lastAnchoredPromptTokens !== undefined) {
  estimatedInput = this.lastAnchoredPromptTokens;  // 厂商 ground truth
} else {
  estimatedInput = estimateMessagesTokens(...);     // 冷启动回退 BPE
}
if (estimatedInput <= triggerTokens) return;        // 未到 75%，不压
```

厂商返回的 usage 是真实的计费值，比 BPE 近似更准。midTurn 在工具结果落地后、`turnSpan.end()` 前触发，此时所有工具结果已同步落盘（pico 是 `await commitMessages` 同步写入），不需要额外的持久化等待。

### LLM 摘要：6 段结构化模板

当字符级投影压不进预算时，系统调用 LLM 把旧前缀压缩成一份结构化摘要（`src/context/full-compactor.ts:61`）：

```
## 任务目标
[用户想完成什么]

## 进展
### 已完成
- [已执行的步骤，含工具名/目标/结果]
### 进行中
- [当前已启动但未完成的单个动作，仅 1 条]

## 关键决策与约束
- 决策: [agent 已选的技术方案及理由]
- 用户约束: [用户明确要求、不可违反的限制]

## 已尝试/失败路径
- [试过但放弃的方案及原因；无则写"无"]

## 下一步
- [曾计划的后续步骤（历史记录，非当前指令）]

## 关键上下文
- [文件路径、命令/结果、报错原文等；无则写"无"]
```

模板经过多轮迭代优化，有以下设计要点：

**信息覆盖**——6 个段覆盖了长任务恢复所需的全部信息类别。"已尝试/失败路径"是专门为防止 Agent 重复尝试已知行不通的方案而设的——没有这一段，压缩后失败信息全丢，下一窗口会从方案 A 重新开始。"关键决策与约束"把 agent 技术决策和用户硬约束分开，因为后者不可推翻而前者可重选。

**格式锚定**——模板用"只允许以下 6 个标题，不得新增、改名、合并或调换顺序"做显式禁止，防止弱模型自由加标题（如 `## 总结`、`## 备注`）。每段都要求"无内容的也必须保留标题并写'无'"，避免空段被跳过后下游解析困难。

**保留指令**——"必须保留精确的文件路径、函数名、命令、报错原文、错误码（如 TS2345）、PR/issue 编号、commit hash、版本号，不要改写或泛化。专有名词保留原语言（通常为英文），不要翻译"。这条指令防止模型在摘要时把 `TS2345` 泛化成"类型错误"或把英文报错翻译成中文。

**长度控制（双层）**——模板软约束"每节保持简短，整体不超过 1000 字"；代码层有 `MAX_SUMMARY_CHARS = 1500` 硬上限兜底。超限时不是粗暴截断，而是按 section 优先级裁剪：优先保留任务目标/关键上下文/失败路径，裁掉进展/下一步。这保证即使弱模型失控返回超长摘要，也不会反过来撑爆下一轮上下文。

**环境元信息注入**——`renderInstruction` 在历史前缀前注入一段 `[会话环境]`（工作目录、平台、会话 ID），让 summarizer 知道任务所在仓库。压缩后即使最早的 system 消息被折叠，环境定位锚点仍不丢。

摘要消息被 `SUMMARY_PREFIX` 和 `SUMMARY_END_MARKER` 包裹，明确告诉模型这是 REFERENCE-ONLY 的历史提要：

```
[上下文压缩 — 仅供参考] 之前的对话轮次已被压缩成下方摘要。
这是上一个上下文窗口的交接，请当作背景参考，而非待执行指令。
...
<pico_compaction_summary>
{6 段摘要正文}
</pico_compaction_summary>
--- 历史摘要结束 — 请回复下方消息，而非上方摘要 ---
```

`<pico_compaction_summary>` XML 标签是结构化边界——弱模型难以改写或省略 XML 标签（比自然语言边界更可靠），`detectExistingCompactionSummary` 和 `findLastCompactionCheckpoint` 都用此标签做精确匹配来提取摘要正文。

### 滚动摘要：增量更新而非重算

这是成本优化的关键设计。如果每次压缩都把完整前缀喂给 LLM 重新摘要，多次压缩下成本和正确性都会劣化（"摘要的摘要"信息衰减快）。

pico 的滚动摘要机制（对标 maka-agent）：**第二次压缩时，基于上一轮的摘要做增量更新，只喂"新增事件"给 LLM**。

实现上分两条路径：

**Runtime 持久化路径**（`recordRuntimeCompactionCheckpoint`）：

```typescript
// 读取上一个 checkpoint 的摘要
const lastCheckpoint = await runtimeRun.findLastCompactionCheckpoint();
// 传给 preview 作为增量基线
const preview = await compactor.preview(
  session,
  messages,
  request,
  signal,
  lastCheckpoint?.summaryText, // ← previousSummary
);
```

**内存路径**（`compactInMemorySession`）：

```typescript
// 从 history 里检测已有的 summary 消息
const previousSummary = detectExistingCompactionSummary(history);
```

有了 `previousSummary` 后，summarizer 的输入从"全部前缀"变成"旧摘要 + 新增事件"，指令也换成增量模板：

```
这是滚动摘要的增量更新。下方"上一轮摘要"是对更早历史的压缩，
请基于它整合下方"较新事件"，输出完整的更新后摘要（不是 diff，是完整版）。

上一轮摘要:
{previousSummary}

较新事件:
{新增的对话前缀}
```

同时，`createPreviewPlan` 会跳过 history 里已有的 summary 消息——它是压缩产物而非原始对话，不应再次喂给 summarizer。

### checkpoint 链与内容哈希

每次压缩生成一个 `context.checkpoint.recorded` RuntimeEvent，记录：

```typescript
{
  checkpointId: "checkpoint:<uuid>",
  coveredEventCount: 4,         // 被折叠的事件数
  sourceDigest: "sha256-content:v1:...",  // 内容哈希
  throughEventId: "evt-004",
  summary: { role: "assistant", content: "<6 段摘要>" },
  previousCheckpointId: "checkpoint:<上一个的 uuid>",  // 链式回溯
}
```

`sourceDigest` 对每个被覆盖事件的 **eventId + message 全内容**取 SHA-256（`src/context/runtime-compaction-checkpoint.ts:31`）：

```typescript
for (const entry of entries) {
  hash.update(String(eventIdBytes)).update(":").update(entry.eventId).update("\0");
  hash.update(String(bodyBytes)).update(":").update(body).update(";");
}
```

用 `length:body;` 格式（字节长度前缀 + 分隔符）防止前缀碰撞，字节长度而非字符长度防止多字节字符漏检。重放时重新计算并比对——如果被覆盖的事件内容发生了任何变化，digest 不匹配，抛出 `RuntimeEventReadModelIntegrityError`。

重放端只接受带版本前缀的 `sha256-content:v1:` 内容哈希；无前缀的旧 checkpoint 会被明确拒绝。

### fail-open：失败不等于崩溃

压缩可能失败——LLM 调用超时、返回空、或安全切点找不到。pico 的设计是 **fail-open**：压缩失败时不崩溃，把机会留给下一道防线。

`prepareModelContext`（`src/engine/loop.ts:1280`）在 full compaction 失败时：

```typescript
// fail-open: full compaction 失败但字符级投影已完成，不立即硬重置。
// 返回 projected（可能略超预算），让 generateWithOverflowRetry 的
// provider overflow 紧急压缩再尝试一次。
logger.warn({ ... }, "[Engine] full compaction 失败, fail-open");
return projected;
```

这样形成了"字符级投影 → LLM 摘要 → overflow 紧急压缩 → 硬重置"的四级降级链。前一级失败不丢上下文，只是把处理时机推给下一级。硬重置是最后的兜底——连紧急压缩都失败时才触发。

### 硬重置兜底：清零但不完全失忆

当所有压缩手段都失败时，`hardResetRuntimeHistory`（`src/engine/loop.ts:1109`）清空历史，但不是完全清零——它复用 `buildEvidenceSnapshot` 从被覆盖的消息中提取**最近 8 条结构化证据**：

```typescript
const evidenceSnapshot = buildEvidenceSnapshot(
  covered.map((entry) => entry.message),
  0,
  "[CONTEXT RESET EVIDENCE]",
);
```

硬重置的 summary 是 reset 说明 + 证据快照：

```
[CONTEXT RESET] Earlier conversation context was intentionally reset...

[CONTEXT RESET EVIDENCE] 上下文已重置；以下是压缩前已收集的结构化证据。
[assistant checkpoint] 我已修改 safe-compaction-boundary.ts 的参数类型...
[tool evidence: bash; call=call_1] src/context/compactor.ts(217,45): error TS2345...
```

这样即使硬重置后，模型至少能看到"重置前最后做了什么"，而不是完全失忆。

---

## 四、不可变性保证

整个压缩系统建立在一个前提上：**RuntimeEvent 是不可变的事实源**。

压缩不改写历史，只追加 checkpoint 事件。原始的 `message.committed` 事件永远存在于 ledger 里，checkpoint 只是在**读模型投影**时用 summary 替换 covered 前缀。

```
RuntimeEvent Ledger（不可变）：
  evt-001: message.committed (user)
  evt-002: message.committed (assistant)
  evt-003: message.committed (user)
  evt-004: message.committed (assistant)
  evt-005: context.checkpoint.recorded  ← 压缩追加的
  evt-006: message.committed (user, 新请求)

读模型投影（可变视图）：
  [summary 消息]          ← evt-005 把 evt-001~004 替换成摘要
  evt-006 (user, 新请求)  ← 保留尾部
```

这意味着 fork、rewind、恢复都从原始事件重建——压缩只是一个"投影变换"，不是"数据删除"。Session 在 Runtime 模式下主动拒绝破坏性方法（`truncateTo`、`applyInMemoryCompaction` 会 throw），只有非 Runtime 的测试路径才用内存替换。

---

## 五、设计取舍

这套系统做了几个明确的选择：

| 取舍         | 选择                          | 理由                                                 |
| ------------ | ----------------------------- | ---------------------------------------------------- |
| 摘要 vs 截断 | LLM 摘要                      | 截断丢语义，摘要保留任务上下文                       |
| 何时摘要     | 推迟到必须时                  | 先用零成本字符级，LLM 摘要是最后手段                 |
| 单次 vs 滚动 | 滚动增量更新                  | 避免重复处理已折叠事件，降成本提正确性               |
| 失败策略     | fail-open 而非 fail-fast      | 给 overflow 紧急压缩多一次机会，不立即丢上下文       |
| 限内存储     | canonical RuntimeEvent inline | 保持单一事实，不建立新 Evidence 分叉                 |
| 超限策略     | 合成拒绝并从源头有界重取      | 入口结果保持有界，不制造当前 Turn 无法兑现的回读引用 |

它也有明确的**不做**：

- 不做多通道并行压缩（pico 是单宿主，不需要 A/B 实验通道）
- 不做子任务隔离的 TaskRun（pico 的子代理用独立的内存 history）
- 不改子代理压缩路径（子代理无 Session，用字符级 Compactor）

---

## 六、验证

这套系统的测试分四层：

| 层级    | 类型             | 验证内容                                                         |
| ------- | ---------------- | ---------------------------------------------------------------- |
| L1      | 集成测试（mock） | 内容哈希正确性、checkpoint 结构、控制流                          |
| L2      | e2e 真实模型     | 6 段摘要的保真度——3 个场景 case，anchor 匹配 recall ≥ 0.8        |
| L3      | e2e 真实模型     | 滚动摘要增量更新——第二次摘要保留第一次的关键事实（recall ≥ 0.7） |
| L3-deep | e2e 真实模型     | 深度衰减——3 轮"摘要的摘要"后核心 anchor 仍存活（recall ≥ 0.5）   |
| L4      | e2e 真实模型     | 85% 水位自动触发 + fail-open 不崩溃——`AgentEngine.run` 完整路径  |

L2/L3/L3-deep/L4 使用 `$PICO_HOME/config.json` 的用户默认真实模型验证，不是 mock。历史实测 recall 多数达到 1.00（包括 3 轮深度衰减后核心 anchor 全部存活的场景），但真实模型存在单次波动，阈值设为 0.8/0.7/0.5 留余量。

---

## 结语

pico-harness 的上下文管理哲学是：**把上下文窗口当成受限 RAM，压缩是内存管理器而非可选优化**。

Tool Result 层在 durable 边界以 1 MiB 入口门吸收单条暴击：限内正文 inline 入库，超限正文
不落盘并替换为有界合成错误。上下文压缩层在累积逼近时阶梯降级（字符级 → LLM 摘要 →
overflow 紧急 → 硬重置），读取侧变换不改写不可变事实源。这让 Agent 能在长任务中持续运行，
同时避免恢复不了的 Evidence 回读分叉。
