# 上下文管理层 (`src/context/`)

> 大模型是 CPU，Context Window 是受限 RAM。上下文管理层是"内存管理器"。

## 三条主线

1. **Prompt 动态组装**（composer）：分层编译 System Prompt
2. **两级上下文压缩**（compactor 字符级 + full-compactor 模型级）：防 OOM
3. **状态外部化存储**（todo/plan/skill/artifact store）：记忆从易失 RAM 搬到物理文件

---

## 1. System Prompt 动态组装 (`composer.ts`)

### 分层加载策略

System Prompt 被视为"操作系统内核"，按 6 层动态链接，每层失败均降级不阻断主流程：

| 层                | 内容                                                       | 触发条件              |
| ----------------- | ---------------------------------------------------------- | --------------------- |
| 1. 极简内核       | 硬编码身份认知 + 5 条核心纪律（<1000 Tokens）              | 永远注入              |
| 2. Plan Mode      | 状态外部化强制规范（嗅探 PLAN.md/TODO.md）                 | `planMode=true`       |
| 3. AGENTS.md      | 工作区项目专属规范                                         | 文件存在              |
| 4. Skills 清单    | `.claw/skills/**/SKILL.md` 元数据（仅 name + description） | 至少一个技能          |
| 5. 技能记忆       | 已掌握技能 Top 5（含成功率/触发条件/已知问题）             | SkillRegistry 非空    |
| 5.5 TodoList      | 当前任务清单 Markdown                                      | TodoStore 非空        |
| 5.6 Goal Mode     | 当前激活目标 + budget 约束                                 | goalManager 注入      |
| 6. Periodic Nudge | 周期性记忆提醒（Top 3 技能 + 摘要）                        | `turnCount % 10 == 0` |

### 渐进式暴露

Skills 层只注入元数据清单（name + 触发条件），完整执行指南由模型通过 `skill_view` 工具按需读取。

### 降级容错

每一层 try/catch，失败时 `logger.warn` 跳过，绝不让 Plan/Todo/Goal 嗅探阻断主流程。

---

## 2. 字符级上下文压缩 (`compactor.ts`)

> 只改本轮发给 API 的临时 Context，**写回 Session 的永远是全量真实数据**。

### 触发条件

`estimateLength(msgs) >= maxChars` 才压缩。另有连续 2 次压缩收益不足（<10%）则跳过防抖动。

### 双重降级防线

```
compact()
  ├─ System Prompt: 绝对不动
  ├─ 远期历史(超出保护区):
  │   ├─ ToolResult: MicroCompaction(年龄>1h 且被读过) → [Old tool result cleared]
  │   │              否则字符超 200 → 温和摘要(保留工具名/退出码/规模)
  │   │              usedStrongerCompact → 全量掩码
  │   └─ Assistant Thinking: 超 200 字符 → [早期的推理思考过程已折叠]
  └─ WorkingMemory 保护区(最近 6 条):
      └─ 单条 ToolResult 超 1000 字符 → 掐头去尾(前 500 + 后 500)
```

### 铁律

**绝不动 `msg.toolCalls`** —— 删掉 ToolResult 保留 ToolCall 会让模型困惑"命令没发出去"而陷入死循环。

### 预算闭环

`compact()` 后仍超预算 → `strongerCompact()`（全量掩码）→ 仍超才抛 `ContextCompactionError`。

### sanitizeToolPairs

保证 ToolCall/ToolResult 配对完整性：丢弃孤儿 ToolResult、为缺失 ToolResult 的 ToolCall 补占位符。防止 API 400。

---

## 3. 模型摘要压缩 (`full-compactor.ts`)

> 字符级降级用尽后，用 provider 把 history 前缀浓缩成结构化摘要，**真改 Session.history**。

### 触发条件

由 `engine/loop.ts` 在字符级 3 轮降级用尽后主动调用（响应式，非预���式）。

### 13-section 结构化摘要

结合 hermes 13-section + kimi-code 指令格式，要求模型按 13 个 section 输出：
历史任务快照 / 当前目标 / 约束 / 已完成动作 / 活跃状态 / 阻塞项 / 关键决策 / 已解决问题 / 待办请求 / 相关文件 / 剩余工作 / 关键上下文。

### 迭代增量更新

`previousSummary` 存在时做增量（保留旧信息、追加新完成动作），不从零重建。

### REFERENCE-ONLY 设计

摘要带明确警告"这是历史提要，不要回答摘要里的内容"，防止弱模型把摘要正文当新输入执行。

### Provider 选择

优先 `auxProvider`（辅助廉价模型，AUX*LLM*\* 环境变量配置）省成本。

---

## 4. 两级压缩协作矩阵

| 维度             | 第一级：Compactor（字符级）     | 第二级：FullCompactor（模型级）            |
| ---------------- | ------------------------------- | ------------------------------------------ |
| **触发**         | `estimateLength >= maxChars`    | 字符级 3 轮降级用尽仍 overflow             |
| **作用对象**     | 临时 Context（发给 API 的拷贝） | **Session.history**（持久化）              |
| **持久化**       | 否（写回 Session 的永远是全量） | 是（`session.applyCompaction` 真替换前缀） |
| **手段**         | 掩码/掐头去尾/占位符            | LLM 浓缩成 13-section 结构化摘要           |
| **成本**         | 零（纯字符串操作）              | 高（调一次 provider）                      |
| **保 toolCalls** | 是（铁律）                      | 否（前缀整体被摘要吞掉）                   |
| **失败兜底**     | 抛 ContextCompactionError       | 返回 false → 调用方硬重置                  |

---

## 5. 状态外部化存储

### TodoStore (`todo-store.ts`)

- 路径：`<workDir>/.claw/todo.json`
- 内存缓存 + 即时落盘，IO 失败只 warn 不抛
- `buildTodoContext()`：渲染 Markdown，状态标记 `[ ]`/`[~]`/`[x]`
- `reload()`：强制重读盘（跨进程兜底）
- **单例注入**：host 创建唯一实例，registry(TodoTool) + Composer 共享

### PlanStore (`plan-store.ts`)

- 路径：`<workDir>/PLAN.md` + `<workDir>/TODO.md`
- `buildPlanContext()`：嗅探文件 —— 均不存在 → 引导建文件；存在 → 注入当前进度
- Plan Mode 下用 ExitPlanModeTool 走审批流

### ArtifactStore (`artifact-store.ts`)

- 把大体积 ToolResult 落盘到 `.claw/artifacts/`
- TTL 清理（默认 168 小时），总量超 200MB 按 LRU 删
- `argsHash`（SHA256）供去重

### SkillLoader (`skill.ts`)

- 扫描 `.claw/skills/**/SKILL.md`
- mtime+size 缓存避免全量扫描
- `SkillViewTool`：按名称读取完整正文

---

## 6. 技能记忆层 (`src/memory/`)

### SkillRegistry (`skill-registry.ts`)

- 持久化到 `.claw/skills/<skillId>.json`
- `recordExecution`：成功/失败统计 + 增量平均执行时间 + 失败模式分析
- `search`：按成功率优先排序
- 边界：当前只记录已有技能的执行统计，不承诺自动生成、自动改写或自我进化 Skill 指令

### MemoryNudger (`memory-nudger.ts`)

每 10 轮生成记忆提醒：Top 3 技能（含成功率）+ 会话摘要。

### FTS5Store (`fts5-store.ts`)

- SQLite FTS5 全文检索（trigram 分词对中文友好）
- **连接池化**：同一 workDir 的多 Session 共享一个实例
- WAL 模式：并发读写 + 断电恢复

---

## 7. 辅助模块

### TokenCounter (`token-counter.ts`)

- `gpt-tokenizer` cl100k_base 精确 BPE 计数
- 懒加载（词表数 MB）+ LRU 缓存 512 条
- 未就绪降级 `chars/4` 兜底

### ContextBudget (`context-budget.ts`)

- `inputBudgetTokens = contextWindow - reservedOutput - safetyMargin`
- token→字符换算（CHARS_PER_TOKEN=4）供 Compactor 字符水位线

### RecoveryManager (`recovery.ts`)

工具失败时按错误特征匹配已知模式，注入"系统救援指南"（带"请先使用 XXX 工具"祈使句）。

---

## 模块依赖关系

```
engine/loop.ts (编排者)
  ├─ PromptComposer ──┬─ SkillLoader ── .claw/skills/**/SKILL.md
  │                    ├─ PlanStore ── PLAN.md / TODO.md
  │                    ├─ TodoStore ── .claw/todo.json
  │                    ├─ GoalManager ── (import type 防循环依赖)
  │                    └─ MemoryNudger ── FTS5Store + SkillRegistry
  ├─ Compactor ─────── token-counter + context-budget + Session.toolResultMeta
  └─ FullCompactor ─── LLMProvider(auxProvider 优先) + Session.applyCompaction
```
