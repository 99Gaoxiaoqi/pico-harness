# pico Goal 实现详解

> 本文以 pico-harness 的实际代码为基础，完整梳理 Goal 功能从创建到完成的全链路实现，包括停滞检测、延续协调器、LLM 评估器和预算管理。

## 一、设计定位

Goal 是 pico 的**长程目标追踪 + 预算控制 + 完成判定**机制。它位于三层架构的顶层：

```
Goal   ← 宏观目标 + 预算锚点（如"重构认证模块，最多 20 轮"）
Plan   ← 实现路径（PLAN.md）
Todo   ← 原子任务清单
```

核心设计选择：

| 维度 | pico | Claude Code | maka-agent |
|------|------|------------|-----------|
| 完成判定 | LLM 评估器（≥3 轮无进展时触发） | `/goal` 外部评估器 | 每轮外部评估器 |
| 停滞检测 | 工具调用指纹 + 阈值梯度 | Stop hook 8 次拦截 | `blockCap=8` |
| 延续协调器 | 分层续行（直接续行 / 评估器 / 终止） | `/goal` 续行 | 评估器驱动续行 |
| 预算维度 | 轮次 / token / 成本 / 墙钟 | — | 同 pico |
| 预算提醒 | 剩余 ≤20% 时显示 ⚠ | — | 续行提示显示进度 |

---

## 二、五层架构

```
┌─────────────────────────────────────────────────────────┐
│                    LLM（大模型）                          │
│         创建/更新目标、调用工具、生成产出                   │
├─────────────────────────────────────────────────────────┤
│              Goal 工具层（3 个工具）                      │
│    create_goal / get_goal / update_goal                  │
│    操作后返回含 budgetUsage 的完整快照                     │
├─────────────────────────────────────────────────────────┤
│              LLM 评估器（goal-evaluator.ts）              │
│    独立 LLM 调用判断 {met, impossible, progress}         │
│    30s 超时，失败 fail-open                               │
├─────────────────────────────────────────────────────────┤
│              延续协调器 + 停滞检测（loop.ts）              │
│    工具调用指纹追踪、续行决策树、软提醒注入                  │
├───────────────────────────────────────────────��─────────┤
│              GoalManager（状态机 + 预算）                  │
│    4 状态 FSM、4 维预算追踪、停滞计数器                     │
│    Session RuntimeEvent 持久化                            │
└─────────────────────────────────────────────────────────┘
```

---

## 三、数据结构

**文件**：`src/engine/goal-manager.ts`

```typescript
type GoalStatus = "active" | "paused" | "blocked" | "complete";

interface Goal {
  id: string;                        // "goal-1"（自增）
  title: string;                     // "重构认证模块"
  description: string;               // 详细描述
  status: GoalStatus;                // 状态机
  createdAt: number;                 // 创建时间戳
  budgetConfig?: BudgetConfig;       // 预算限制（可选）
  budgetUsage: GoalBudgetUsage;      // 已消耗
  progress?: string;                 // 模型写的进度文本
  blockedReason?: string;            // 阻塞原因
  consecutiveNoProgress?: number;    // 连续无进展轮次
  lastToolCallHash?: string;         // 上一轮的工具调用指纹
}

interface BudgetConfig {
  maxTurns?: number;       // 最多多少轮
  maxTokens?: number;      // 最多多少 token
  maxCostCNY?: number;     // 最多花多少钱
  maxWallClockMs?: number; // 最多运行多久
}

interface GoalBudgetUsage {
  turns: number;           // 已消耗轮次
  tokens: number;          // 已消耗 token
  costCNY: number;         // 已消耗成本（人民币）
  startedAt: number;       // 创建时间戳（墙钟基准，不暂停）
}
```

---

## 四、状态机

```
         create()
            ↓
      ┌─────────┐
      │ active  │ ←── 同时只能有一个 active goal
      └────┬────┘
     ┌─────┼─────┐
     ↓     ↓     ↓
┌────────┐ ┌────────┐ ┌──────────┐
│ paused │ │ blocked��� │ complete │
└───┬────┘ └───┬────┘ └──────────┘
    │          │
    └────┬─────┘
         ↓
      重新激活（但不能从 complete 激活）
```

**关键规则**：
- 同一时间最多一个 `active` goal
- 创建新 goal 时，旧的 active 自动降为 `paused`
- `complete` 的 goal 不能重新激活（必须先 `update` 状态）
- `consecutiveNoProgress >= 8` 时 `currentBudgetDecision` 返回 `allowed: false`

---

## 五、预算控制

### 四维预算检查

```typescript
currentBudgetDecision(now): BudgetDecision {
  // 1. 停滞硬终止（无预算配置时也生效）
  if (active.consecutiveNoProgress >= STALL_BLOCK_THRESHOLD) {
    return { allowed: false, reason: "Goal 疑似停滞（连续 N 轮无进展）" };
  }

  // 2. 墙钟时间（从创建开始，不暂停）
  if (config.maxWallClockMs && now - usage.startedAt > config.maxWallClockMs)
    return { allowed: false, reason: "已达墙钟时间上限" };

  // 3. Token 总量
  if (config.maxTokens && usage.tokens > config.maxTokens)
    return { allowed: false, reason: "已达 Token 预算" };

  // 4. 成本
  if (config.maxCostCNY && usage.costCNY > config.maxCostCNY)
    return { allowed: false, reason: "已达成本预算" };

  return { allowed: true };
}
```

### 每轮消耗

```typescript
// loop.ts — consumeResponseBudget
consumeResponseBudget(session, response, costBefore) {
  this.budget.consumeUsage(response.usage);           // IterationBudget
  this.goalManager?.consumeUsage(response.usage);     // GoalManager
  this.budget.consumeCost(costDelta);
  this.goalManager?.consumeCost(costDelta);
}
```

**子代理也共享父 goal 的预算**——子代理消耗的 token 和 cost 会算进 goal 预算。

### 预算软提醒

```typescript
formatRemainingBudget(goal: Goal): string | null {
  // 剩余 ≤20% 时显示 ⚠ 预警
  if (c.maxTurns !== undefined) {
    const r = c.maxTurns - u.turns;
    parts.push(`剩余 ${r} 轮${r <= Math.ceil(c.maxTurns * 0.2) ? " ⚠" : ""}`);
  }
  // ... maxTokens, maxCostCNY 同理
}
```

模型在 `buildGoalContext` 中看到的：

```markdown
## 🎯 当前 Goal(长程目标)
- 🟢 **重构认证模块** (id: goal-1)
  - 描述: 将旧版 session 认证迁移到 JWT
  - 预算约束: 10 轮 + 50000 tokens + ¥1.5
  - 已消耗: 8 轮 + 12345 tokens + ¥0.4200
  - 剩余 2 轮 ⚠ + 剩余 37655 tokens + 剩余 ¥1.0800
  - ⚠ 连续无进展: 3 轮
```

---

## 六、停滞检测

### 设计

用**工具调用指纹重复**作为停滞的近似信号，不引入外部评估器（成本高）。

### 阈值梯度

| 连续轮次 | 动作 | 成本 |
|---------|------|------|
| 0-2 | 不干预（模型可能在思考/规划） | 免费 |
| 3-4 | 触发 LLM 评估器判断是否真的完成 | ~$0.005/次 |
| 5-7 | 注入 `[SYSTEM REMINDER]` 强提醒 | 免费 |
| ≥8 | `currentBudgetDecision` 返回 `allowed: false` → Grace Call 终止 | 免费 |

### 指纹计算

```typescript
recordToolCallProgress(toolCalls: readonly ToolCall[]): void {
  const active = this.getActive();
  if (!active) return;

  if (toolCalls.length === 0) {
    // 无工具调用也视为无进展（模型偷懒）
    active.consecutiveNoProgress++;
    return;
  }

  // 对工具调用集排序后取 MD5 哈希
  const hash = createHash("md5")
    .update(toolCalls.map(tc => `${tc.name}:${tc.arguments}`).sort().join("|"))
    .digest("hex");

  if (hash === active.lastToolCallHash) {
    active.consecutiveNoProgress++;   // 相同指纹 → 递增
  } else {
    active.consecutiveNoProgress = 0; // 不同指纹 → 重置
  }
  active.lastToolCallHash = hash;
}
```

**关键**：指纹只看 `工�����:参数`，不看 `toolCall.id`。所以即使模型每轮生成不同的 `call-1`, `call-2`，只要工具和参数一样就算停滞。

### 什么情况重置计数器

```
模型换了工具  → 不同指纹 → 重置
模型换了参数  → 不同指纹 → 重置
模型调了多个工具（即使有一个相同）→ 整体指纹不同 → 重置
```

---

## 七、LLM 评估器

**文件**：`src/engine/goal-evaluator.ts`

### 触发时机

**不是每轮都调**。仅在 `consecutiveNoProgress >= 3` 且模型想退出时触发一次：

```
模型没调工具 + goal active + consecutiveNoProgress >= 3
  → 触发评估器
  → met=true  → 允许退出（模型完成了但没调 update_goal）
  → met=false → 注入评估理由 + 续行
  → 评估器失败 → fail-open（允许退出）
```

### 评估器设计

```typescript
// 用会话同款模型，purpose:"hook" 标记流量
const result = await provider.generate(messages, [], { signal, purpose: "hook" });
```

- **模型**：会话同款模型（不切换，保证判断一致性）
- **输入**：goal 描述 + 最近 6 条消息（每条截断 500 字符）≈ 900 token
- **输出**：JSON `{met, impossible, progress, reason}`
- **超时**：30s，超时后 fail-open
- **成本**：一个 20 轮的 goal 通常只触发 1-2 次评估器，成本 <1% 总 Agent 成本

### 评估器 prompt

```
你是一个严格的目标完成评估器。
判断工作模型的产出是否达成了给定目标。

判断规则：
- met=true 仅当有明确证据表明目标已完全达成
- impossible=true 当目标因技术原因无法达成
- progress=true 当最近一轮有实质进展
- 不确定时全部返回 false（保守判断）

只输出 JSON：{"met": boolean, "impossible": boolean, "progress": boolean, "reason": "简短原因"}
```

### fail-open 设计

```typescript
catch {
  // 超时或调用失败 → 不阻塞 Agent 退出
  return { met: false, impossible: false, progress: false, reason: "", evaluatorFailed: true };
}
```

评估器�����/失败时返回 `evaluatorFailed: true`，延续协调器看到这个标记直接允许退出（不阻塞）。

---

## 八、延续协调器

**文件**：`src/engine/loop.ts`

### 决策树

```
模型这轮结束（无论是否调了工具）+ goal active

  Step 1: 每轮结束后更新停滞计数器
    ├── 有工具调用且指纹变了 → consecutiveNoProgress = 0
    ├── 有工具调用且指纹相同 → consecutiveNoProgress++
    └── 无工具调用           → consecutiveNoProgress++

  Step 2: 模型无工具调用准备退出时
    ├── consecutiveNoProgress >= 8 → Grace Call 终止
    │
    ├── consecutiveNoProgress >= 3 → 触发 LLM 评估器
    │                                 met=true  → 允许退出
    │                                 met=false → 续行 + 注入评估理由
    │                                 评估器失败 → fail-open 允许退出
    │
    └── consecutiveNoProgress < 3  → 直接续行（给模型思考空间）
                                       注入 [Goal continuation] 指令
```

### 续行指令注入

```typescript
// noProgress < 3 → 直接续行
await session.commitMessages({
  role: "user",
  content: "[Goal continuation] 目标尚未完成，请继续推进。",
  providerData: { picoKind: "goal_continuation", picoHiddenFromTranscript: true },
});
continue;  // 继续循环
```

### 防无限循环

续行不检查预算——但**下一轮的 `startTurn()` 会自动检查**：

```typescript
const goalTurnBudget = this.goalManager?.startTurn();
if (!goalTurnBudget.allowed) {
  exhaustedReason = goalTurnBudget.reason;  // "Goal 已达到最大轮次 20"
  break;  // 退出 → Grace Call
}
```

所以即使 goal 一直 active，最多续行到预算耗尽就自动停。

---

## 九、提示词注入

### buildGoalContext

```typescript
buildGoalContext(): string {
  const active = this.getActive();
  if (!active) return "";  // 无 active goal 不注入

  const lines = [
    "## 🎯 当前 Goal(长程目标)",
    `- ${statusMark(active.status)} **${active.title}** (id: ${active.id})`,
    `  - 描述: ${active.description}`,
  ];
  if (active.progress) lines.push(`  - 进度: ${active.progress}`);
  if (active.blockedReason) lines.push(`  - 阻塞原因: ${active.blockedReason}`);

  // 预算信息
  if (budgetStr) {
    lines.push(`  - 预算约束: ${budgetStr}`);
    lines.push(`  - 已消耗: ${active.budgetUsage.turns} 轮 + ...`);
    lines.push(`  - ${this.formatRemainingBudget(active)}`);  // 剩余 + ⚠ 预警
  }

  // 停滞状态（≥3 轮才显示）
  if (active.consecutiveNoProgress >= STALL_EVALUATOR_THRESHOLD) {
    lines.push(`  - ⚠ 连续无进展: ${active.consecutiveNoProgress} 轮`);
  }

  return lines.join("\n");
}
```

### 注入位置

注入到 **turnTail**（和 TodoList 一样），每轮重建：

```
systemPrompt（冻结，缓存命中）
├── 核心身份
├── AGENTS.md
└── Skills

turnTail（每轮重建，追加到 user 消息）
├── <env> 环境信息
├── TodoList 状态
├── 🎯 Goal 状态（含预算消耗、剩余预警、停滞状态）  ← 这里
└── Memory recall
```

---

## 十、工具层

### 三个工具

**文件**：`src/tools/goal.ts`

| 工具 | 操作 | 返回值 |
|------|------|--------|
| `create_goal` | 创建并激活目标 | `🎯 已创建并激活目标 goal-1:\n` + formatGoal |
| `get_goal` | 查询目标 | `🎯 当前激活目标:\n` + formatGoal |
| `update_goal` | 更新目标字段 | `✅ 已更新目标 goal-1:\n` + formatGoal |

### formatGoal（含 budgetUsage + 停滞状态）

```typescript
function formatGoal(goal: Goal): string {
  const lines = [`- ${statusMark(goal.status)} **${goal.title}** (id: ${goal.id})`];
  lines.push(`  - 描述: ${goal.description}`);
  if (goal.progress) lines.push(`  - 进度: ${goal.progress}`);
  if (goal.budgetConfig) {
    // 预算配置
    lines.push(`  - 预算: ${parts.join(" + ")}`);
    // 已消耗
    lines.push(`  - 已消耗: ${goal.budgetUsage.turns} 轮 + ${goal.budgetUsage.tokens} tokens + ¥${goal.budgetUsage.costCNY.toFixed(4)}`);
  }
  // 停滞状态
  if (goal.consecutiveNoProgress >= 3) {
    lines.push(`  - ⚠ 连续无进展: ${goal.consecutiveNoProgress} 轮`);
  }
  return lines.join("\n");
}
```

---

## 十一、持久化

```
GoalManager（内存单例）
    ↓ emitChange()
Session.subscribe()
    ↓ updateRuntimeState({ goal })
RuntimeEventStore
    ↓ session.state.committed 事件
session.jsonl（持久账本）
```

重启时：
```
session.jsonl → projectRuntimeSessionState(events) → 恢复 goal 快照
    ↓ normalizeGoalManagerSnapshot()（严格校验）
session.bindGoalManager(goalManager) → manager.restore(persistedGoal)
```

校验内容包括 `consecutiveNoProgress`（可选非负整数）和 `lastToolCallHash`（可选字符串）。

---

## 十二、完整流程：一次多轮 Goal 对话

### 场景：用户说"帮我重构认证模块，最多 20 轮"

```
═══════════════════════════════════════════
Turn 1: 创建目标
═══════════════════════════════════════════

模型调 create_goal({title:"重构认证", budget:{maxTurns:20}})
  → GoalManager 创建 goal-1 (active)
  → emitChange → 持久化到 session.jsonl

系统注入 turnTail:
  🎯 重构认证 (goal-1)
  已消耗: 0 轮 + 0 tokens + ¥0
  剩余: 20 轮 + 无限制

模型开始工作：读文件、写代码

═══════════════════════════════════════════
Turn 2-5: 正常工作
═══════════════════════════════════════════

每轮工具调用指纹不同 → consecutiveNoProgress = 0
每轮消耗预算 → 已消耗递增

═══════════════════════════════════════════
Turn 6: 模型说"我做完了"但不调工具
═══════════════════════════════════════════

consecutiveNoProgress = 1 (< 3)
→ 直接续行："[Goal continuation] 目标尚未完成，请继续推进。"

═══════════════════════════════════════════
Turn 9: 连续 3 轮不干活
═══════════════════════════════════════════

consecutiveNoProgress = 3 (≥ 3)
→ 触发 LLM 评估器：
   评估器判断 met=false（还有测试没过）
→ 注入评估理由："[Goal continuation] 目标尚未完成。
    评估器判���：3 个测试仍失败。请继续推进。"

═══════════════════════════════════════════
Turn 15: 模型再次卡住
═══════════════════════════════════════════

consecutiveNoProgress = 5 (≥ 5)
→ 注入 [SYSTEM REMINDER] 强提醒：
   "目标 goal-1 已连续 5 轮无进展，疑似停滞。
    请换一种方案或缩小范围。"

同时 turnTail 显示：
  ⚠ 连续无进展: 5 轮
  剩余: 5 轮 ⚠ (75% 已消耗)

═══════════════════════════════════════════
Turn 18: 模型调 update_goal({status:"complete"})
═══════════════════════════════════════════

模型标记完成 → activeGoalId 清除
未来轮次无 active goal → 不再约束

═══════════════════════════════════════════
异常场景：连续 8 轮停滞
═══════════════════════════════════════════

consecutiveNoProgress = 8
→ currentBudgetDecision 返回 { allowed: false }
→ startTurn() 失败 → break → Grace Call
→ 模型做最后一次总结
```

---

## 十三、与 TodoList 的对比

| 维度 | Goal | TodoList |
|------|------|----------|
| **定位** | 宏观目标 + 预算锚点 + 完成判定 | 原子任务清单 |
| **状态机** | 4 状态 FSM，单 active 约束 | 每条独立 pending/in_progress/completed |
| **预算** | ✅ 轮次/token/成本/墙钟 + 停滞硬终止 | ❌ 没有 |
| **停滞检测** | ✅ 工具指纹 + 阈值梯度 | ❌ 没有 |
| **完成判定** | ✅ LLM 评估器（≥3 轮无进展时） | ❌ 模型自判 |
| **延续协调器** | ✅ 分层续行 | ❌ 没有 |
| **持久化** | Session RuntimeEvent 快照 | todo.json 文件 |
| **注入位置** | turnTail（每轮重建） | turnTail（每轮重建） |
| **工具数** | 3 个（create/get/update） | 1 个（todo，5 个 action） |
| **成本关联** | goalId 挂到 CostTracker | ❌ 没有 |
| **子代理共享** | ✅ 子代理消耗计入父 goal | ❌ 独立 |

---

## 十四、相关文件索引

| 文件 | 职责 |
|------|------|
| `src/engine/goal-manager.ts` | 状态机 + 预算追踪 + 停滞检测 + buildGoalContext |
| `src/engine/goal-evaluator.ts` | LLM 评估器（完成判定） |
| `src/tools/goal.ts` | 3 个工具（create/get/update）+ formatGoal |
| `src/engine/loop.ts` | 停滞触发 + 延续协调器 + 评估器触发 |
| `src/engine/session-runtime.ts` | goal 快照校验（含新字段） |
| `src/engine/budget.ts` | BudgetConfig / BudgetDecision 共享类型 |
| `tests/e2e/goal-stall-detection.real-llm.test.ts` | 停滞检测单元测试 |
| `tests/e2e/goal-e2e.real-llm.test.ts` | E2E 集成测试（4 个场景） |
