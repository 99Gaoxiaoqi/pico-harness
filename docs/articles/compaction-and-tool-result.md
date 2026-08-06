# pico-harness 上下文管理：语义压缩与 Tool Result 归档

> 本文记录 pico-harness 如何管理 Agent 运行时的上下文窗口——当对话历史不断增长、工具返回结果越来越庞大时，系统如何在不丢失关键信息的前提下把上下文控制在 LLM 窗口内。涉及压缩的触发与策略、Tool Result 的归档与回读、以及失败场景下的降级兜底。

---

## 一、问题：上下文窗口是稀缺资源

大模型 Agent 运行在一个基本约束下：**每轮推理的输入 token 不能超过上下文窗口**。一个 128K 窗口听起来很大，但很快就会被消耗殆尽：

- 系统提示 + 工具 Schema：固定占 5K-15K token
- 每轮对话历史：用户输入 + 模型回复 + 工具调用 + 工具结果
- 单次工具返回的暴击：`read_file` 一个大文件、`bash` 一条编译命令的输出、`grep` 匹配数百条结果

一个真实场景：Agent 读了一个 2MB 的日志文件，返回结果约 50 万 token——远超任何模型的窗口。如果这单条结果直接进上下文，后续所有推理都会失败。

pico-harness 把这个问题拆成两个层面解决：

1. **Tool Result 层**：单条工具结果在进入上下文**之前**就被截断/归档
2. **上下文压缩层**：当累积的历史消息总量逼近窗口时，把旧前缀压缩成摘要

---

## 二、Tool Result 处理：投影与归档

### 核心思想：原文只存一次，消费者只拿有界投影

pico 的 Tool Result 处理有一条清晰的设计原则——**工具的原始输出只写入一次内容寻址存储（Evidence CAS），上下文里只保留一份有界的"投影"**。所有消费者（模型、Reporter、Hook、UI）都从这份投影读取，不会各自猜测大小。

### 投影决策：2048 token 分水岭

每条工具结果在进入 Session 之前，先经过 `buildRuntimeToolResultProjection`（`src/tools/tool-result-observation.ts:33`）做投影决策：

```
工具输出
  │
  ├─ ≤ 2048 token ──→ 原文保留（mode: "full"）
  │
  └─ > 2048 token ──→ 生成 1600 字符预览（mode: "preview"）
                       原文按 SHA-256 写入 Evidence CAS
                       模型只拿到 pico://evidence/... URI
```

**2048 token** 是分水岭（`DEFAULT_RUNTIME_PROJECTION_THRESHOLD_TOKENS = 2048`）。低于这个值的工具结果原文进上下文；高于的，原文落盘到 Evidence CAS，模型只收到一份 **1600 字符**（`DEFAULT_SUMMARY_MAX_CHARS`）的 head-tail 预览。

### 统一 head-tail 预览

预览采用统一的 head-tail 截断（`src/tools/result-summarizer.ts`）：保留输出的头尾各一半预算，中间标注省略字符数。头部保留开头（文件 import、配置、命令开始），尾部保留结尾（exit code、错误摘要、测试结果）。

之所以不做"按工具类型分策略的智能提取"（如只保留 tsc 错误行、只保留测试 FAIL 行），是因为：

1. **原文不丢**——超过 2048 token 的结果已通过 Evidence CAS（SHA-256 寻址）持久化，模型可随时 `read_evidence` 分页回读完整原文
2. **按需支付优于持续维护**——智能提取需要为每种工具输出形态手写正则识别器，上游工具版本升级就要跟随维护；而模型多一次 `read_evidence` 调用的成本是按需支付的（只在需要精确细节时才付）
3. **通用性**——作为通用 agent，按特定工具类型分策略（tsc/vitest）不适用于 Python/Java/Go 等多语言场景，反而可能因误判导致比 head-tail 更差的效果

### Evidence CAS：内容寻址 + 分页回读

归档的原文通过 **SHA-256 内容寻址存储**（`src/context/evidence-archive.ts`）管理：

```
原始输出（如 2MB 日志）
  │
  ├─ stableJson → SHA-256 → 文件名（contentHash）
  ├─ writeImmutableJson（临时文件 + hard link，原子写入）
  └─ 返回 URI: pico://evidence/<sessionId>/<contentHash>
```

模型需要完整原文时，调用 `read_evidence` 工具按 **16KiB/页**分页回读（`DEFAULT_EVIDENCE_PAGE_LIMIT_BYTES`，上限 64KiB）：

```
模型看到预览 + "需要完整原文时调用 read_evidence(pico://evidence/...)"
  │
  ├─ read_evidence(ref, offsetBytes=0, limitBytes=16384)
  │    → 返回第 0-16383 字节 + truncated: true + nextOffsetBytes: 16384
  │
  └─ read_evidence(ref, offsetBytes=16384, ...)
       → 返回第 16384-32767 字节 ...
```

这个设计保证了三个性质：
1. **单条大结果永远撑不爆上下文**——模型只持有 1600 字符预览
2. **原文不丢失**——SHA-256 内容寻址，完整性可校验
3. **可翻页回读**——模型按需分页获取，不需要一次性全量加载

### 各工具自身的输出自限

除了统一的投影机制，每个工具还有自身的输出上限作为第一道防线：

| 工具 | 限制 | 策略 |
|---|---|---|
| read_file | 500 行/页、2000 字符/行、16MiB/文件 | 行数分页，行号稳定 |
| bash | 10MiB 执行缓冲 | 超限杀进程树，保留已捕获头部（按到达顺序的早期输出） |
| grep | 500 条匹配上限 | 前 N 条 + 截断提示 |
| glob | 100 条上限 | 前 100 条 |
| web | 2MiB 响应字节、默认 8K 字符（上限 50K） | 流式到 2MiB 停 |

这些自限是工具层的保护，投影决策（2048 token 阈值）是运行时的第二道防线，Evidence CAS 是第三道。三层共同保证：**无论工具返回多大，进入上下文的永远是有界的**。

---

## 三、语义压缩：当历史总量逼近窗口

Tool Result 投影解决的是"单条暴击"，但即使每条结果都被截断到 1600 字符，历史消息累积到一定轮数后仍然会逼近窗口。这时候就需要**语义压缩**——把旧前缀浓缩成一份结构化摘要。

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
│   旧前��� → 6 段结构化摘要（真实 LLM 调用）                    │
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

midTurn 是"轮内主动"压缩——在一个用户 turn 内，工具批量执行产生大量结果后，**不等下一轮发现溢出，立刻检查是否需要压缩**（`src/engine/loop.ts:985`）：

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

当字符级投影压不进预算时，系统调用 LLM 把旧前缀压缩成一份结构化摘要（`src/context/full-compactor.ts:51`）：

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
  session, messages, request, signal,
  lastCheckpoint?.summaryText,  // ← previousSummary
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

版本前缀 `sha256-content:v1:` 让重放端能区分新旧格式，向后兼容历史 checkpoint。

### fail-open：失败不等于崩溃

压缩可能失败——LLM 调用超时、返回空、或安全切点找不到。pico 的设计是 **fail-open**：压缩失败时不崩溃，把机会留给下一道防线。

`prepareModelContext`（`src/engine/loop.ts:1203`）在 full compaction 失败时：

```typescript
// fail-open: full compaction 失败但字符级投影已完成，不立即硬重置。
// 返回 projected（可能略超预算），让 generateWithOverflowRetry 的
// provider overflow 紧急压缩再尝试一次。
logger.warn({ ... }, "[Engine] full compaction 失败, fail-open");
return projected;
```

这样形成了"字符级投影 → LLM 摘要 → overflow 紧急压缩 → 硬重置"的四级降级链。前一级失败不丢上下文，只是把处理时机推给下一级。硬重置是最后的兜底——连紧急压缩都失败时才触发。

### 硬重置兜底：清零但不完全失忆

当所有压缩手段都失败时，`hardResetRuntimeHistory`（`src/engine/loop.ts:1042`）清空历史，但不是完全清零——它复用 `buildEvidenceSnapshot` 从被覆盖的消息中提取**最近 8 条结构化证据**：

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

| 取舍 | 选择 | 理由 |
|---|---|---|
| 摘要 vs 截断 | LLM 摘要 | 截断丢语义，摘要保留任务上下文 |
| 何时摘要 | 推迟到必须时 | 先用零成本字符级，LLM 摘像是最后手段 |
| 单次 vs 滚动 | 滚动增量更新 | 避免重复处理已折叠事件，降成本提正确性 |
| 失败策略 | fail-open 而非 fail-fast | 给 overflow 紧急压缩多一次机会，不立即丢上下文 |
| 原文存储 | 内容寻址 CAS | 完整性可校验，分页回读，不丢失 |
| 预览策略 | 统一 head-tail + Evidence CAS 回读 | 原文不丢，预览精度差的代价只是多一次 read_evidence |

它也有明确的**不做**：
- 不做多通道并行压缩（pico 是单宿主，不需要 A/B 实验通道）
- 不做子任务隔离的 TaskRun（pico 的子代理用独立的内存 history）
- 不改子代理压缩路径（子代理无 Session，用字符级 Compactor）

---

## 六、验证

这套系统的测试分四层：

| 层级 | 类型 | 验证内容 |
|---|---|---|
| L1 | 集成测试（mock） | 内容哈希正确性、checkpoint 结构、控制流 |
| L2 | e2e 真实模型 | 6 段摘要的保真度——3 个场景 case，anchor 匹配 recall ≥ 0.8 |
| L3 | e2e 真实模型 | 滚动摘要增量更新——第二次摘要保留第一次的关键事实（recall ≥ 0.7） |
| L3-deep | e2e 真实模型 | 深度衰减——3 轮"摘要的摘要"后核心 anchor 仍存活（recall ≥ 0.5） |
| L4 | e2e 真实模型 | 85% 水位自动触发 + fail-open 不崩溃——`AgentEngine.run` 完整路径 |

L2/L3/L3-deep/L4 用真实模型（默认 `deepseek-v4-flash-0731`，可通过 `COMPACTION_E2E_MODEL` 覆盖）验证，不是 mock。历史实测 recall 多数达到 1.00（包括 3 轮深度衰减后核心 anchor 全部存活的场景），但真实模型存在单次波动，阈值设为 0.8/0.7/0.5 留余量。

---

## 结语

pico-harness 的上下文管理哲学是：**把上下文窗口当成受限 RAM，压缩是内存管理器而非可选优化**。

Tool Result 层在 durable 边界吸收单条暴击（Evidence CAS + 2048 token 投影），上下文压缩层在累积逼近时阶梯降级（字符级 → LLM 摘要 → overflow 紧急 → 硬重置），每一步都有 fail-open 兜底，每一步都不破坏不可变事实源。这让 Agent 能在长任务中持续运行，而不会因为上下文溢出而崩溃或丢失关键进度。
