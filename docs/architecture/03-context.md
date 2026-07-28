# 上下文管理层 (`src/context/`)

> 大模型是 CPU，Context Window 是受限 RAM。上下文管理层是"内存管理器"。

## 三条主线

1. **Prompt 动态组装**（composer）：分层编译 System Prompt
2. **完整历史 + token 水位整理**（ToolResult 投影 + FullCompactor）：防 OOM
3. **状态外部化存储**（todo/plan/skill/Evidence CAS）：记忆从易失 RAM 搬到物理文件

---

## 1. System Prompt 动态组装 (`composer.ts`)

### 分层加载策略

System Prompt 被视为“操作系统内核”，按需组装以下层，每层失败均降级而不阻断主流程：

| 层          | 内容                                                          | 触发条件           |
| ----------- | ------------------------------------------------------------- | ------------------ |
| 极简内核    | 硬编码身份认知 + 核心纪律                                     | 永远注入           |
| Plan Mode   | 状态外部化规范（嗅探 PLAN.md/TODO.md）                        | `planMode=true`    |
| AGENTS.md   | 工作区项目专属规范                                            | 文件存在           |
| Skills 清单 | 项目与用户 Pico Skill Catalog 元数据（仅 name + description） | 至少一个技能       |
| TodoList    | 当前任务清单 Markdown                                         | TodoStore 非空     |
| Goal Mode   | 当前激活目标 + budget 约束                                    | goalManager 已注入 |

### 渐进式暴露

Skills 层只注入元数据清单（name + 触发条件），完整执行指南由模型通过 `skill_view` 工具按需读取。

### 降级容错

每一层 try/catch，失败时 `logger.warn` 跳过，绝不让 Plan/Todo/Goal 嗅探阻断主流程。

---

## 2. 请求投影与 ToolResult 微压缩 (`compactor.ts`)

`Session.getModelContext()` 返回完整历史副本。Engine 使用统一预算：

```text
inputBudgetTokens = contextWindowTokens - maxOutputTokens - 1,024
autoWatermark     = inputBudgetTokens × 85%
```

输入估算包含 System Prompt、历史消息和工具 Schema。低于 85% 时，除协议修复外不删除历史；超过水位后，`compactOldToolResults()` 只缩短安全尾部之前的旧 ToolResult，近期完整工作段保持原文。

canonical ToolResult 在进入 Session 投影前已经确定性生成有界内容；大输出的原文按 SHA-256
写入 Evidence CAS，模型通过 `pico://evidence/...` 和 `read_evidence` 显式分页回读。微压缩只处理
旧请求投影，不改 canonical fact、Evidence 引用或近期安全尾部。

### 工具协议投影

`sanitizeToolPairs()` 按每个 assistant 工具批次局部配对，允许 provider 在不同批次复用 ToolCall ID。投影会丢弃孤儿/重复结果，并为历史异常缺失结果补 stub；这些修复不写回 Session。

---

## 3. token 驱动模型摘要 (`full-compactor.ts`)

ToolResult 投影后仍超过 85% 水位时，FullCompactor 将旧前缀浓缩成结构化摘要。持久化 Session 不改写历史：Runtime 追加 `context.checkpoint.recorded`，记录覆盖事件数、事件 ID 摘要、边界事件和摘要；读模型验证这些字段后，才用摘要替换模型投影中的旧前缀。Provider 实际返回 `ContextOverflowError` 时，使用更紧的尾部 token 目标紧急压缩一次，不再缩成 14/10/6 条消息重试。

### 安全切分

`findSafeCompactionCut()` 保证：

- 保留段不以 ToolResult 开头；
- 不切在普通 user 请求之后；
- assistant 的整批 toolCalls 与全部连续 results 位于边界同侧；
- 尾部工具交换未完成时禁止持久化压缩。

### 13-section 结构化摘要

结合 hermes 13-section + kimi-code 指令格式，要求模型按 13 个 section 输出：
历史任务快照 / 当前目标 / 约束 / 已完成动作 / 活跃状态 / 阻塞项 / 关键决策 / 已解决问题 / 待办请求 / 相关文件 / 剩余工作 / 关键上下文。

### REFERENCE-ONLY 设计

摘要带明确警告"这是历史提要，不要回答摘要里的内容"，防止弱模型把摘要正文当新输入执行。

### Provider 选择

优先 `auxProvider`（辅助廉价模型，AUX*LLM*\* 环境变量配置）省成本。

---

## 4. 两级压缩协作矩阵

| 维度         | 第一级：ToolResult 投影                       | 第二级：FullCompactor                            |
| ------------ | --------------------------------------------- | ------------------------------------------------ |
| **触发**     | 输入估算超过 85% 水位                         | 投影后仍超过水位，或 Provider overflow           |
| **作用对象** | 临时 Context（发给 API 的副本）               | Runtime 模型读投影；无持久化模式才改内存 Session |
| **持久化**   | canonical projection 已随 ToolResult 事实保存 | 追加 checkpoint，不改写已有 RuntimeEvent         |
| **手段**     | 缩短旧 ToolResult，保护安全尾部               | LLM 浓缩成 13-section 结构化摘要                 |
| **边界**     | 不改 ToolResult body / Evidence               | 完整并发工具批次必须在边界同侧                   |
| **失败兜底** | 继续尝试 FullCompactor                        | 一次紧急重试后才允许硬重置                       |

---

## 5. 状态外部化存储

### TodoStore (`todo-store.ts`)

- 路径：`$PICO_HOME/workspaces/<workspace-id>/todo.json`
- 内存缓存 + 即时落盘，IO 失败只 warn 不抛
- `buildTodoContext()`：渲染 Markdown，状态标记 `[ ]`/`[~]`/`[x]`
- `reload()`：强制重读盘（跨进程兜底）
- **单例注入**：host 创建唯一实例，registry(TodoTool) + Composer 共享

### PlanStore (`plan-store.ts`)

- 路径：`<workDir>/PLAN.md` + `<workDir>/TODO.md`
- `buildPlanContext()`：嗅探文件 —— 均不存在 → 引导建文件；存在 → 注入当前进度
- Plan Mode 下用 ExitPlanModeTool 走审批流

### EvidenceArchive (`evidence-archive.ts`)

- ToolResult 原文和长子代理报告写入 workspace Evidence SHA-256 CAS
- Session/hash/manifest/blob 全链路校验，模型只持有 `pico://evidence/...`
- `read_evidence` 按 UTF-8 字节分页回读，不暴露任意文件路径

### SkillLoader (`skill.ts`)

- 统一扫描 `<workDir>/.pico/skills/` 与 `$PICO_HOME/skills/`；兼容来源只读且优先级更低
- mtime+size 缓存避免全量扫描
- `SkillViewTool`：按名称读取完整正文

---

## 6. 开发期硬切边界

当前版本不再创建或读取 Summary sidecar，也不迁移旧 `memory/summaries.json`。摘要只有 Runtime checkpoint 一种持久化身份；fork、rewind 和恢复都从 RuntimeEvent 投影重建。旧会话数据不在兼容范围，遇到旧 schema 时明确拒绝。

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
  ├─ PromptComposer ──┬─ SkillLoader ── .pico/skills + $PICO_HOME/skills
  │                    ├─ PlanStore ── PLAN.md / TODO.md
  │                    ├─ TodoStore ── $PICO_HOME/workspaces/<id>/todo.json
  │                    └─ GoalManager ── (import type 防循环依赖)
  ├─ Compactor ─────── token-counter + context-budget + Session.toolResultMeta
  └─ FullCompactor ─── LLMProvider(auxProvider 优先)
                         ├─ durable: Runtime checkpoint
                         └─ persistence:false: Session.applyInMemoryCompaction
```
