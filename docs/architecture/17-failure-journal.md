# 失败日记六层框架：跨项目对照分析

> 文档状态：研究材料。本文用于跨项目比较和候选设计，不表示相关能力已经进入 Pico 当前
> 产品；实现状态以 [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) 与代码为准。

> 本文是记忆模式组第四讲"失败日记（Failure Journal）"的收尾分析。失败日记把一次失败从事故记录转化为**可召回、可复用、可审计**的工程资产。本文以教学提炼的六层框架为坐标，逐层对照 pico-harness / maka-agent / claude-code 三个项目的现状，并参照 mem0、Letta（MemGPT）作为业界参照，回答三个问题：失败记忆在各项目里长什么样、为什么是这样、pico 若要补齐该怎么做（以及该不该做）。

---

## 一、背景与定位

### 1.1 失败日记解决什么

进度追踪（第三讲）解决的是**本次失败怎么救**：标记 `needs_rework` → 废弃错误快照 → 重绑机械状态 → 继续推进。它的视野是**这一个 session**。

失败日记解决的是**下次怎么不再犯**：把一次事故蒸馏成一条可被未来相似任务召回的规则。它的视野是**下一个 session**。两者是两个时间尺度，互不替代。

### 1.2 "被打扫过的世界"

做 demo 时我们习惯把失败藏起来：工具调用失败了就重试，上下文乱了就新开会话，中间结果错了就手工修一下，最后展示给用户的是一条干净的成功路径。Manus 团队在上下文工程实践中强调：**在长循环任务里，失败本来就是循环的一部分。保留失败动作和后续观察，会让模型调整对相似动作的判断；清除失败痕迹，则等于清除了它能够利用的证据。**

这指出的不是某个 bug，而是一个**系统性采样偏差**：demo、测试、session 自动清理，都会天然抹掉失败痕迹。Agent 因此永远活在一个没有失败样本的洁净室里，每次任务都像第一天上班。

### 1.3 一个三层叠加的真实例子

一个跨租户薪酬结算事故不是单一 bug，是三层叠加：

1. **上下文卫生**：客户 B 的旧 `payroll_group_id` 残留在自然语言里。
2. **参数绑定纪律**：工具封装允许从文本提取 id——机械态取值来源没钉死在 `SessionState` / 工具返回值上，而是开放给了自然语言复述。
3. **验证闸门**：租户一致性校验兜住了前两层的合谋。

第 2 层是根因。失败日记要蒸馏的教训——"跨租户的 `payroll_*_id` 一律不从自然语言摘要提取"——本质上是一条**机械态绑定规则**，而不是业务规则。这也呼应了 pico 三态分析中的结论：机械态（参数从哪来、绑到哪去）恰恰是各项目最薄的一环。

---

## 二、六层框架

完整失败日记是一条管线，不是一个载体。顶部有一个蒸馏关系：**L2 失败事实（原始事故细节）→ 蒸馏 → L3 可召回教训（短经验卡）**。L2 是审计用的"为什么"，L3 是召回用的"下次怎么做"。

其下是六层：

| 层  | 名称                               | 回答的问题                                                                   |
| --- | ---------------------------------- | ---------------------------------------------------------------------------- |
| 1   | 失败边界（Failure Boundary）       | 这次**值不值得**记？（hard / gate / semantic / safety 四类判定）             |
| 2   | 失败分类（Failure Classification） | 给失败归类便于召回（tool / retrieval / goal_drift / boundary_leak）          |
| 3   | 证据包（Evidence Packet）          | 保存失败当时的三平面快照（Workspace · Narrative · State · Observation）      |
| 4   | 根因与补救（Root Cause & Repair）  | 把 symptom / root_cause / repair / lesson **四者分开**                       |
| 5   | 召回触发器（Recall Trigger）       | 说明下次**何时、在哪类任务**自动想起（task_family · tool · mechanical_keys） |
| 6   | 留存与审查（Retention & Review）   | draft → needs_review → approved → archived，**只有审查过的才进召回库**       |

底部是一条主流程：失败发生 → 判定边界 → 分类 → 存证 → 写教训 → 下次召回。

六层里有几层是其他模式没有、失败日记特有的：**层 1（失败边界）和层 5（召回触发器）**是失败日记真正区别于普通记忆的地方——它们把"什么时候记"和"什么时候用"都钉死成结构化条件，而不是靠模糊语义匹配碰运气。

---

## 三、逐层对照

### 层 1：失败边界

判定一次失败是否值得进入失败日记。四类：`hard`（崩溃/硬终止）、`gate`（验证闸门拦截）、`semantic`（语义错误，如用户纠正）、`safety`（安全策略拒绝）。这是失败日记的第一道闸门，也直接回应"不是所有失败都该记"——偶发环境错误（API 超时、一次性脏数据）不应被蒸馏成硬规则，否则 Agent 过拟合、不敢动。

| 项目                   | 现状                                                                                                                                                                                                   | 证据                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pico**               | ❌ 无失败识别。最接近的信号是 Goal stall 状态机，但它**不产出失败记录**：`STALL_BLOCK_THRESHOLD=8` 硬终止后走 Grace Call，run 以 `completed` 收尾，不 emit 任何失败事件，goal.status 仍停在 `"active"` | `src/engine/goal-manager.ts:77-79`；`src/engine/loop.ts:2184-2188`                                                                                                                            |
| **pico**（信号源可用） | RuntimeRun 有成败判定（`RuntimeTerminalStatus = "completed" \| "failed" \| "cancelled" \| "interrupted"`）；工具失败、审批被拒、模型调用失败都有对应事件                                               | `src/engine/session-runtime-event.ts:25`；`src/engine/tool-result-contract.ts:1-6`；`approval.settled decision="rejected"` (`runtime-run.ts:1156-1163`)；`model.call.settled status="failed"` |
| **maka**               | ❌ 无独立失败边界。记忆提取的 `deterministicMemoryPolicyRejection` 只做**安全拒绝**（密钥泄漏），不做失败判定                                                                                          | `packages/runtime/src/memory-extraction-proposal.ts:326`                                                                                                                                      |
| **claude-code**        | ❌ 无独立失败边界事件类型。失败散落在 tool error / approval denial，但没有"这次值得蒸馏"的判定器                                                                                                       | —                                                                                                                                                                                             |

**关键约束（pico）**：现有记忆提取管线**显式排除失败 run**。`runtime-run-executor.ts:220-226` 的 post-terminal 调度只认 `event.data.status === "completed"`；`runtime-evidence-reader.ts:109-120` 的 `assertTerminal` 硬要求 `status === "completed"`，否则抛 `terminal_not_completed`。这是**有意为之**：失败 run 的轨迹质量差，提取普通 preference/fact 会产出垃圾。失败日记若要接入，必须绕开或另开一条路径，不能直接放宽门禁（否则污染成功路径）。

### 层 2：失败分类

| 项目            | kind 体系                                                                                           | 有无 failure 类                          | 证据                                         |
| --------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **pico**        | `["preference", "correction", "project_fact", "reference"]`（4 种，按"用户表达意图"分）             | ❌ 无                                    | `src/memory/domain.ts:4`                     |
| **maka**        | `["preference", "identity", "context", "knowledge", "failure", "note"]`（6 种，按"知识本体类型"分） | ✅ 有 `failure`                          | `packages/core/src/long-term-memory.ts:9-16` |
| **claude-code** | `["user", "feedback", "project", "reference"]`（4 类）                                              | ❌ 无独立 failure（`feedback` 部分承担） | `src/memdir/memoryTypes.ts:14-19`            |

**maka 的 `failure` 不是摆设**：提取 prompt 明确引导模型产出它——

> 'Extract only durable facts, preferences, identity, project context, reusable knowledge, **failures**, or notes that can help in a later session.'
>
> — `packages/runtime/src/memory-extraction-proposal.ts:216`

JSON schema 也将 `failure` 列为合法 kind（同文件 `memoryItemShapeDescription()`）。pico 的提取 prompt（`src/memory/worker.ts:393-401`）只提 "stable workspace facts"，不点 failures。

**为什么 pico 加 failure 比 maka 难**：不只是加个枚举值。pico 的 kind 是被**正则先验 + 后处理改写双重锁死**的——

```
正则先验 (proposal-signal.ts，只认四类模式)
    ↓ 匹配不上
模型从 JSON schema 四选一 (enum 从 MEMORY_KINDS 展开)
    ↓ parser 校验越界直接拒绝
stabilizeCandidateKind 强制改写 (proposal-engine.ts:150)
    ↓
落库
```

`proposal-signal.ts` 里没有任何匹配"失败"的正则（没有 `failure`/`lesson`/`mistake` 模式）。整条流水线的模具只有四个槽。加新 kind 必须**同时改**：枚举定义 → 正则模式 → JSON schema → stabilize 改写规则，四处联动。maka 跳过了正则先验这一层，直接让模型在六个 kind 里自由选，扩展新 kind 只需动枚举和 prompt。

### 层 3：证据包

保存失败当时的三平面快照。失败日记的 L2 载体就是这层——它不是新存事故原始数据，而是给账本里已有的失败区间挂一个"索引指针"。

| 项目            | 证据载体                                                                                                                                            | 复用价值                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **pico**        | `Source` interface 已有 `eventIds / startSequence / endSequence / digest / evidenceRef?`；`EvidenceRef` 是统一溯源 overlay（带流身份的区间 cursor） | ✅ **可直接挂失败快照**——`Source` + `EvidenceRef` 就是为"指向 RuntimeEvent 账本里一段事件"设计的 |
| **maka**        | Local Memory（markdown 文档）；LTM 的 `MemoryItemSource { sessionId, runId, turnId, eventId }`                                                      | ✅ LTM 有等价溯源，但 LTM 只写不读（见层 5）                                                     |
| **claude-code** | 每条记忆是独立 `.md` 文件（带 frontmatter + mtime）                                                                                                 | ⚠️ 文件粒度，无事件区间指针                                                                      |

**pico 的证据基础是最好的**。`runtime-evidence-reader.ts:56-85` 已经是现成的"按 sequence 截事件组 EvidenceRef"模板（用于成功 run 的 memory 提取）。存储层 `runtime-event-store.ts:677-688` 有 `readSessionEntriesPage(sessionId, { afterSequence, limit })` 做区间读取。失败日记的层 3 几乎是免费搭车——只要把"截至 terminal"换成"截至失败时刻"，就能截出失败区间的证据包。

### 层 4：根因与补救

把 symptom（症状）/ root_cause（根因）/ repair（补救）/ lesson（教训）四者**结构化分离**。这是失败日记区别于"又一段自然语言笔记"的关键：没有结构，教训就退化成普通 fact，下次能不能被正确理解全凭运气。

| 项目            | 现状                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **pico**        | ❌ Fact 只有扁平的 `title / content / reason`，无结构化字段                                                              |
| **maka**        | ❌ MemoryItem 虽有多维（`statementType / temporalType / scopeType / keys`），但没有 symptom/rootCause/repair/lesson 四元 |
| **claude-code** | ❌ 记忆是 markdown，无结构化根因分析                                                                                     |

**三者都缺这层。** 这是失败日记最大的结构化负担，也是各项目都没做的部分。

### 层 5：召回触发器

说明下次**何时、在哪类任务**自动想起这条教训。结构化匹配键：`task_family / tool / mechanical_keys`。这层是失败日记的核心增值——它不靠模糊语义检索，靠**明确的匹配键**做精准召回，和机械态绑定纪律是同一思路。

| 项目                     | 检索方式                                              | 触发时机             | 是否精准                                |
| ------------------------ | ----------------------------------------------------- | -------------------- | --------------------------------------- |
| **pico**                 | 关键词匹配（token + path + cjkBigram 交集打分）       | 每轮被动注入         | ⚠️ 有盲区：query 不命中关键词就召不回   |
| **maka**（Local Memory） | 全量注入（markdown 全量拼接）                         | 每轮被动注入         | ❌ 无筛选                               |
| **maka**（LTM）          | `searchByKeys`（normalized_key 精确/前缀匹配）        | **零调用**——只写不读 | ❌ 未接通                               |
| **claude-code**          | **二级 LLM 检索**（Sonnet 当 selector 选 top-5）      | 每轮异步预取         | ✅ 语义级，注释明确说"关键词重叠会误判" |
| **mem0**（业界参照）     | 三路并行融合（语义 embedding + BM25 关键词 + 实体图） | 每轮检索注入         | ✅ 最强                                 |
| **Letta**（业界参照）    | archival memory 向量检索，**模型主动 call tool**      | 模型主动召回         | ✅ 按需精准                             |

**关键发现**：maka 的 LTM 体系（带 `keys / kind / keyType / keyOrigin` 的精致 `MemoryItem`）目前是**只写不读**——`searchByKeys` 检索能力和 SQL 排序逻辑都已实现并测过，但 runtime / runtime-host 层**没有任何代码调用它**。`memory-extraction-coordinator.ts:18-26` 的 `Pick` **显式不包含** `searchByKeys / readItem`；威胁模型文档明确把召回列为 v1 之外的未实现功能：

> **Auto-retrieve / Recall tool runtime** — out of scope for v1 contract.
>
> — `docs/archive/memory-threat-model-pr-memory-1.md:61`

maka 真正被注入的"记忆"是另一套东西：**Local Memory**（用户手写/审批的 MEMORY.md），全量拼进 system prompt（`local-memory.ts:277-300`），12K 字符截断。所以 **pico 的 context-builder 关键词召回其实已经比 maka 的 LTM 召回强**——因为 pico 至少有能工作的召回，maka 的 LTM 召回根本没接。

**检索方式是一条成熟度阶梯**：

```
全量注入 (maka Local Memory)
    ↓
关键词匹配 (pico context-builder)         ← pico 在这里
    ↓
二级 LLM 检索 (claude-code findRelevantMemories)
    ↓
三路融合检索 (mem0: 语义 + BM25 + 图)
```

pico 的关键词匹配在当前规模合理（候选池 500、注入上限 3 条），不必跳到 LLM 检索或 embedding。但关键词方案有固有盲区：对"跨租户 id 不能从摘要提取"这种教训，如果 query 没命中"租户/id/摘要"这些词，就召不回。失败日记的层 5（结构化 mechanical_keys）正是为了补这个盲区——把召回条件钉死成结构化匹配键，而不是依赖自由文本的关键词重叠。

### 层 6：留存与审查

draft → needs_review → approved → archived，**只有审查过的才进召回库**。这层是失败日记的质量闸门——未经审查的教训不应自动影响未来行为，否则失败蒸馏本身就是新的风险面（错误教训会让 Agent 在正常情况下也不敢动）。

| 项目            | 审查机制                                                                                                                   | 可复用度                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pico**        | `Proposal` 状态机（`pending / accepted / rejected / deleted`）+ `Fact.state`（`active / disabled / archived / forgotten`） | ✅ **天然可复用**——蒸馏产出 pending proposal，`resolveProposal(accepted)` 后才变 active Fact，context-builder 只查 `states:["active"]`，"审查过才召回"是零代码不变量 |
| **maka**        | Local Memory 有 `draft / review_required / active` 三态；LTM 有 `MemoryLifecycleState = active \| archived`                | ✅ Local Memory 有审查流                                                                                                                                             |
| **claude-code** | 记忆文件由模型写入 + 后台 fork agent 提取，无显式审查门（信任模型产出）                                                    | ⚠️ 无审查                                                                                                                                                            |

**pico 在这层有结构性优势**。`autoCommit` 默认放行干净 proposal（`proposal-engine.ts:290-305`），但可以通过排除特定 kind 关掉自动提交，让 lesson 强制走人工审查。`enqueueProposedNotification` 已经会发 pending 通知。层 6 几乎是 pico 现成的基础设施。

---

## 四、召回机制专题

业界不靠 kind 驱动精准召回，但靠 type 做预算/优先级。逐项核实：

- **mem0**：三路分数融合里**不含 kind**，但实体图谱会按"记忆间关系"boost。
- **claude-code**：动态召回的 LLM selector 知道 type，但只是**描述信息**给 LLM 判断，不是硬过滤。
- **Letta**：core memory 分 block（human/persona），block 有独立大小上限——这是**按类型分配预算**。
- **pico**：kind 驱动 priority 排序（`correction=0 > project_fact=1 > 其余=2`，`context-builder.ts:284-288`）+ isStrongCandidate（`correction + pinned`，`:245-247`）。

| 维度     | pico                      | maka             | claude-code                          | mem0                | Letta                     |
| -------- | ------------------------- | ---------------- | ------------------------------------ | ------------------- | ------------------------- |
| 检索方式 | 关键词                    | 全量（LTM 未接） | 二级 LLM                             | 三路融合            | 向量 + 主动               |
| 触发     | 每轮被动                  | 每轮被动         | 每轮异步预取                         | 每轮检索            | 模型主动 call tool        |
| 排序     | kind priority + relevance | 无               | mtime + LLM 选                       | 三路分数 + 时间衰减 | —                         |
| 预算     | 3 条 + 320 token          | 12K 字符         | 5 文件/turn、20KB/turn、60KB/session | top_k               | core memory 硬 token 上限 |
| 注入位置 | turn tail                 | system prompt    | turn tail system-reminder            | system prompt       | system prompt / 工具返回  |

**触发时机的两个流派**：

- **被动注入派**（pico / maka / claude-code / mem0）：系统每轮自动判断并塞进上下文，模型不操心。
- **主动召回派**（Letta）：core memory 自动注入，archival memory 要模型主动调用 `memory_search` 工具按需深挖。好处是精准，坏处是依赖模型自觉。

这两派都不完美。被动注入靠 relevance 碰运气（关键词盲区），主动召回靠模型自觉（可能想不起来查）。**claude-code 的折中值得借鉴**：MEMORY.md 索引每轮全量在上下文（让模型知道"存在哪些记忆"），具体内容按需召回——给模型一个"记忆目录"，同时控制 token。

---

## 五、架构反思：失败日记是否契合 pico 的事件溯源思想

### 5.1 契合部分：L2/L3 都在事件溯源范式内

pico 的立身思想是 **RuntimeEvent 事件溯源是 canonical，Memory 是派生投影**（确立于 `b483fcfa`）。失败日记的 L2/L3 恰好落在这个思想的两端：

- **L2 失败事实 = 投影的"源"**——它不存新东西，只是用 `EvidenceRef` 指向 RuntimeEvent 账本里失败区间的一段。事故原始记录本来就在 canonical 账本里，失败日记只是给它挂一个索引指针。
- **L3 教训 = 派生投影**——和现有 preference/correction fact 一样，是从事件蒸馏出的可召回卡片。

方案没有引入第二套 canonical 存储，没有违背"日志优先"。它甚至强化了证据链：现有 fact 的 `Source` 指向"用户说了什么"，lesson 的 `Source` 指向"哪里失败了"——溯源语义更完整。

### 5.2 新耦合：Memory 开始感知成败语义

这是真正的代价。层 1（失败边界钩子）和层 5（召回触发器）让 Memory 模块开始感知 Runtime 的成败语义：

- `runtime-run-executor.ts` 要在 terminal 时判断"这轮是 failed"，然后通知 memory 侧入队蒸馏。
- 这打破了现有的一条隐含纪律：**Memory 提取目前只在 completed 时发生，对成败无感**。

不过这个耦合是**单向且窄的**：runtime 只是"通知"memory 有个失败，memory 不反向控制 runtime。相比让 memory 理解 goal/task 调度（那才危险），这算轻的。

### 5.3 真正的风险：过度工程

对照 pico 自身的教训——**Evidence GC 因过度工程被删（`3104f7d2`，-1119 行）**。失败日记方案有相似的风险信号：

- 六层是教学提炼的完整形态，但 pico **当前没有对应的产品需求拉它**。
- Evidence GC 当初也是"架构上正确但没有现实拉力"，最后被砍。
- 业界调研（8 个 agent）也没有任何一家做完整的六层失败日记——maka 只开了个 `failure` kind 但召回没接，claude-code 完全没有失败语义。

**如果目的是让 pico 真的用上失败日记**（产品功能）：Phase 1 的最小闭环不算过度，且每层都有现实拉力。**如果目的是教学对照**（理解模式）：就不该写进 pico——写进去反而制造一个"为演示而存在"的模块，恰恰是 Evidence GC 的覆辙。

本文采取后者立场：**只做分析，不写代码**。

---

## 六、若要落地的阶段路线（仅供参考，不实施）

> ⚠️ 本节仅供架构参考。在出现真实产品拉力之前，不应实施——避免重蹈 Evidence GC 覆辙。

### Phase 1：最小闭环（失败 → 蒸馏 → 审查 → 召回）

**核心设计**：平行管线。新 job 类型 `lesson-extraction` 走自己的 scheduler/evidence/prompt/parser，与现有 `terminal-extraction` 零交叉，绕开三处 completed-only 门禁，不污染成功路径。

- **层 1**：`runtime-run-executor.ts` post-terminal 块后加平行分支，监听 `run.terminal status === "failed"`（hard 边界，最省事最有代表性）。
- **层 2/4**：`lesson` 作为新 MemoryKind；结构化字段（category / symptom / rootCause / repair / lesson / triggers）放 Fact.content 的 JSON 信封——避免 schema version 升级，且 relevanceScore 对 content 归一化时 keys 自动成为索引词。
- **层 3**：新 `failure-evidence-reader.ts`，以 `runtime-evidence-reader.ts:56-85` 为模板截取失败 run 事件区间。
- **层 6**：复用 Proposal→Fact——蒸馏产出 `Proposal(pending, kind=lesson)`，`autoCommitEligible` 排除 lesson 强制走人工审查，`resolveProposal(accepted)` 后才进召回库。
- **层 5**：`context-builder.ts` 的 `priority(lesson)=1`（与 project_fact 同级，**不**入 isStrongCandidate——lesson 靠触发器相关性入场，非常驻）；`formatFact` 对 lesson 解析信封渲染 `<lesson>`。

### Phase 2/3：扩展

- Phase 2：审查 CLI、goal stall subscribe 边界（因 stall 走 completed，需主动 subscribe `GoalManager`）、triggers.keys 加权、重复失败去重。
- Phase 3：gate/safety 边界（`approval.settled rejected` / 工具 `rejected`）、cancelled/interrupted、lesson 过期自动 archive、召回命中率度量。

---

## 七、结论

### 7.1 三项目失败记忆成熟度排序

```
maka  >  pico  =  claude-code
（有 failure kind，但召回未接）   （都无失败语义）
```

但若论**召回机制成熟度**（不只是失败记忆），排序反过来：

```
claude-code  >  pico  >  maka
（二级 LLM 检索）  （关键词）  （LTM 只写不读，Local Memory 全量）
```

### 7.2 pico 若要补齐的性价比排序

如果未来出现真实拉力，按性价比（改动小、价值高）排序：

1. **加 `lesson` kind + 提取 prompt 引导**（层 2）——最小改动，让系统能"承认失败是一类知识"。`domain.ts:4` 加枚举 + `worker.ts:400` prompt 改一行，下游全部自动兼容。
2. **复用 Proposal 做审查门**（层 6）——零新代码，`autoCommitEligible` 排除 lesson 即可。
3. **failed-terminal 钩子**（层 1）——平行管线，绕开 completed-only 门禁。
4. **召回优先级**（层 5）——`context-builder.ts` 的 priority 给 lesson 加权。
5. **结构化根因**（层 4）——JSON 信封，不加 Fact 字段。

前两项是几十行的改动，后三项是 Phase 1 的主体。**层 3（证据包）pico 基础最好，几乎免费搭车。**

### 7.3 一句话

失败日记的真正难点不在存储，在**触发**（谁在失败发生的瞬间去蒸馏）和**召回**（下次相似任务怎么精准想起）。三个项目里没有任何一个解决这两个难点——maka 开了载体但召回没接，pico 和 claude-code 连载体都没有。六层框架的价值是把这两个难点结构化成层 1 和层 5，让"什么时候记"和"什么时候用"都有明确的工程答案。
