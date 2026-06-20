# pico-harness vs Hermes Agent — 架构差距与借鉴分析

> 生成时间:2026-06-20
> 对比对象:
> - **pico-harness**(本项目):TypeScript 极简 Agent Harness,22 讲课程实现,~3K 行 TS
> - **Hermes Agent**(NousResearch/hermes-agent):Python 生产级多租户 Agentic OS,~150K+ 行,198K stars

---

## 一、定位差距:一句话概括

| 维度 | pico-harness | Hermes Agent |
|------|--------------|--------------|
| 定位 | **教学型**极简引擎,验证"驾驭工程"哲学 | **生产型**多租户 Agentic OS |
| 规模 | ~3K 行 TS,162 个单测 | ~150K+ 行 Python,无独立测试套件 |
| 用户模型 | 单用户、单进程、CLI/飞书/HTTP | 多用户、单 Gateway 服务 12+ 平台 |
| 主循环 | Two-Stage ReAct(显式 Thinking 阶段) | Provider 原生 tool-calling,无 Thought 文本解析 |
| 工具数 | 4 原语(read/write/edit/bash)+ subagent | 100+ 工具,87 个工具文件 |

**核心结论**:pico-harness 是"Harness 的骨架",Hermes 是"Harness 的肉身"。两者哲学一致(模型=CPU,上下文=内存,工具=外设),但 Hermes 把每个器官都长到了工业级。

---

## 二、逐模块差距与可借鉴点

### 1. 主循环 (Main Loop)

**pico-harness** (`src/engine/loop.ts`):
- 显式 Two-Stage ReAct:先空 tools 纯文本规划,再带工具执行
- 单一 `maxTurns` 兜底(默认 50)
- 依赖 Session 外部状态

**Hermes** (`agent/conversation_loop.py:563`):
- Provider 原生 function-calling,无 `Thought:`/`Action:` 正则解析
- **双预算**:`max_iterations`(默认 90)+ `IterationBudget`(token/成本感知)
- `_budget_grace_call` 逃生舱:预算耗尽后允许最后一次收尾
- 每轮 `_checkpoint_mgr.new_turn()` 快照
- `/steer` 注入:用户可在工具执行中途打断并注入新指令
- preflight 消息消毒:role 交替修复、surrogate 字符剥离、Anthropic 缓存断点

**可借鉴点**:
1. ⭐ **IterationBudget(成本/Token 预算)**:pico 现在只有轮次兜底,可加一个 token 预算,与 CostTracker 联动,耗尽即停。这是防止"烧穿 API 账单"的硬防线。
2. ⭐ **Grace Call**:预算耗尽后给一次"收尾调用",让模型写 PLAN.md 续传,而非硬截断丢上下文。
3. **/steer 注入**:飞书场景下用户能在 Agent 执行中途纠偏,避免干完一整轮才发现跑偏。

### 2. 工具系统 (Tool System)

**pico-harness** (`src/tools/`):
- 4 原语:read_file / write_file / edit_file / bash
- Fork-Join 只读并行(第 08 讲)
- edit_file 多级模糊匹配容错

**Hermes** (`tools/registry.py`, `agent/tool_executor.py`):
- 100+ 工具,自注册模式:`registry.register(name, toolset, schema, handler, check_fn, emoji, max_result_size_chars)`
- **两层中间件**:request middleware(可改写参数)+ execution middleware(`next_call` 链)
- `ThreadPoolExecutor` 并行(8 worker),按原序回收结果
- **Progressive Disclosure(渐进披露)**:大工具目录折叠成 `tool_search`/`tool_describe`/`tool_call` 三个桥工具,按需展开 schema
- `check_fn` 带 30s TTL 缓存(环境前置检查)
- 工具结果按 turn 预算持久化(`tool_result_storage.py`)

**可借鉴点**:
1. ⭐⭐ **Progressive Disclosure(工具搜索桥)**:pico 未来工具超过 10 个时,把工具表折叠成 `tool_search` 桥工具,避免 system prompt 爆炸。这是 Claude Code 同款技巧。
2. ⭐ **两层中间件**:pico 现在只有命令拦截(approval/manager.ts),可抽象成 `request → execute → response` 三段中间件链,让审批、日志、限流都插进去。
3. **`max_result_size_chars` 字段**:工具注册时声明最大返回,超长自动截断。pico 现在靠 Compactor 兜底,可在工具层前置防御。

### 3. 上下文管理 (Context / Compaction)

**pico-harness** (`src/context/compactor.ts`):
- 字符级双重降级:远期 ToolResult 全量掩码 + 保护区掐头去尾(前 500 + 后 500)
- 可选 LLM summarizer(第 12 讲前沿升级)
- 永不触碰 `msg.toolCalls`(保意图连贯)

**Hermes** (`agent/context_compressor.py:2151`):
- **Token 预算**(非条数)保护尾部(~20K tokens)
- **迭代式摘要更新**:重复压缩时基于 `_previous_summary` 增量更新,而非从零重摘要
- `focus_topic`:Claude-Code 风格 `/compact` 引导式压缩
- 反抖动守卫:`_ineffective_compression_count`,避免无效压缩循环
- 头部保护:system + 首轮对话
- 离线 `trajectory_compressor.py`:训练数据压缩(非运行时)

**可借鉴点**:
1. ⭐⭐ **迭代式摘要**:pico 的 summarizer 每次从零摘要,长会话会越摘要越失真。改为"基于上次摘要 + 新消息增量更新",成本低且保连贯。
2. ⭐ **Token 预算而非条数**:pico 用 `retainLastMsgs`(条数),一条 1MB 日志就能击穿。改为按 token 预算掐尾,更精确。
3. **反抖动守卫**:连续压缩没效果就停,避免压缩死循环。
4. **`focus_topic`**:Plan Mode 下可让用户指定"保留关于 X 的内容",压缩质量更高。

### 4. Skills 系统

**pico-harness** (`src/context/skill.ts`):
- 第 10 讲:外挂 Skills 加载机制(读取 SKILL.md)

**Hermes** (`skills/`, `tools/skill_manager_tool.py`):
- Skills 是 **Markdown + YAML frontmatter**(name/description/version/platforms/prerequisites/tags)
- **Progressive Disclosure**:先 `skills_list` 看清单,再 `skill_view` 按需加载全文
- **自主创作**:`skill_manage` 工具让 Agent 自己 create/edit/archive skills
- **Curator 后台进程**:`agent/curator.py` 定期归档陈旧 skill、合并冗余
- **Skills Hub**:browse/search/install 社区 skill(agentskills.io 标准)
- 平台/环境门控:frontmatter 声明 `platforms: [linux, macos]`

**可借鉴点**:
1. ⭐⭐ **Progressive Disclosure 加载**:pico 现在一次加载所有 skill 到 system prompt,会爆。改为"先清单后全文"两阶段。
2. ⭐⭐ **自主 Skill 创作**:让 Agent 完成复杂任务后,自动把成功 SOP 沉淀成 SKILL.md。这是 Hermes 的招牌"learning loop"。
3. ⭐ **YAML frontmatter 元数据**:pico 的 skill 格式待补,加 platforms/prerequisites 做环境门控。
4. **Curator 自动维护**:避免 skill 库膨胀腐烂。

### 5. Provider 抽象

**pico-harness** (`src/provider/`):
- 双实现:OpenAI 兼容 + Claude 原生
- factory + fallback(第 04 讲)

**Hermes** (`providers/`, `plugins/model-providers/`):
- 29 个 ProviderProfile 插件(anthropic/bedrock/gemini/openrouter/kimi/xai/copilot/ollama...)
- **5 种 wire 格式**:`chat_completions` / `anthropic_messages` / `bedrock_converse` / `codex_responses` / `copilot_acp`
- **Anthropic Prompt Cache 断点**:`apply_anthropic_cache_control`,~75% 输入成本降低
- reasoning_content 跨 provider 透传(Moonshot/OpenRouter/Codex)
- OAuth/device-code/aws-sdk 多种鉴权
- provider 消息消毒(role 修复、surrogate 剥离)
- 在线模型目录拉取

**可借鉴点**:
1. ⭐⭐ **Anthropic Prompt Cache**:pico 若支持 Claude,加 `cache_control` 断点(system prompt + 稳定历史),成本立省 75%。这是工程性价比最高的一招。
2. ⭐ **ProviderProfile 声明式描述**:把 provider 的 quirk(vision 支持、固定温度、fallback 模型)抽成数据,而非散落在 if-else。
3. **reasoning_content 透传**:GLM/Kimi 等国产模型的思考链字段,provider 层统一翻译。

### 6. Subagent / 委派

**pico-harness** (`src/tools/subagent.ts`):
- `spawn_subagent`,隔离上下文,只读限制(第 17 讲)

**Hermes** (`tools/delegate_tool.py:2065`):
- **Orchestrator vs Leaf 角色**:leaf(默认,无 delegate 工具)vs orchestrator(保留委派,深度限制默认 2)
- **深度递归边界**:`_delegate_depth` + `max_spawn_depth`
- **批量 + 异步**:`tasks[]` 批量 fan-out,`background=true` 返回 handle 异步执行
- **每子代理独立凭据池**:delegation 可用更便宜的模型
- MCP 工具集继承控制
- **操作员 kill 开关**:`set_spawn_paused` 一键冻结所有 fan-out
- 子代理审批默认 auto-deny

**可借鉴点**:
1. ⭐⭐ **深度边界 + 角色**:pico 的 subagent 没有深度限制,理论上可无限套娃。加 `maxSpawnDepth`(默认 2)+ orchestrator/leaf 角色。
2. ⭐ **批量委派**:一次 spawn 多个并行子代理,Hermes 用 `_get_max_concurrent_children()` 限流。
3. ⭐ **操作员暂停开关**:飞书场景下,管理员一键冻结所有子代理生成,防止失控。
4. **子代理用更便宜模型**:delegation 时指定 `provider:model`,脏活用小模型。

### 7. 安全 / 审批 / 中间件

**pico-harness** (`src/approval/manager.ts`):
- 高危命令拦截(rm/sudo)
- 飞书交互卡片人工 approve/reject(第 16 讲)

**Hermes** (`tools/approval.py`, `agent/tool_guardrails.py`):
- **五层防御**:
  1. 命令模式检测(`detect_dangerous_command` / `detect_hardline_command` / sudo-stdin)
  2. 人工审批(每会话 key + 永久 allowlist + YOLO 旁路)
  3. `next_call` 中间件链(request/execution/api 三层)
  4. **每轮 Guardrail 控制器**:阻断"重复同参失败"和"幂等无进展"循环
  5. Gateway 异步审批(Telegram/Discord inline button)
- tirith_security + threat_patterns 深度分析
- path_security / url_safety / file_safety 多维度

**可借鉴点**:
1. ⭐⭐ **Guardrail 防循环**:pico 有 ReminderInjector(第 15 讲)防死循环,但 Hermes 的更通用——不仅防"同参失败",还防"幂等工具返回相同结果"(如反复 read 同一文件)。可增强 reminder 逻辑。
2. ⭐ **永久 allowlist + YOLO 模式**:pico 每次高危都要审批,可加"永久放行此命令"和"YOLO 全放行"开关,降低人工负担。
3. **三层中间件**:request(改参数)→ execution(包裹执行)→ api(改请求),比 pico 的单点拦截更灵活。

### 8. 可观测性 (Observability)

**pico-harness** (`src/observability/`):
- CostTracker(装饰器模式,第 18 讲)
- Tracer(决策树 JSON,第 19 讲)
- pino logger

**Hermes** (`agent/usage_pricing.py`, `agent/insights.py`):
- **BillingRoute 抽象**:provider + base_url + model → PricingEntry(官方文档/OpenRouter/live catalog)
- Credits 余额追踪(读 response header)
- 免费模型检测
- **InsightsEngine**:token/cost/tool 统计 → 柱状图报告
- `CreditsState` + `AgentNotice`:余额不足时主动告警

**可借鉴点**:
1. ⭐ **BillingRoute 定价表**:pico 的 CostTracker 只记 token 数,可加一张 model→price 的定价表,直接算 USD。这是让成本可感知的关键。
2. ⭐ **余额告警**:读 provider 的 rate-limit/credit header,余额低时注入 `[SYSTEM REMINDER]` 提醒用户。
3. **Insights 报告**:飞书场景下,每日推送 token/cost 柱状图,AgentOps 更完整。

### 9. Session / 多平台

**pico-harness** (`src/engine/session.ts`, `src/feishu/bot.ts`):
- Session 物理隔离(第 11 讲)
- 飞书 WSClient 长连接
- HTTP / CLI 入口

**Hermes** (`gateway/`, `gateway/platforms/`):
- **12+ 平台适配器**:Telegram/Discord/Slack/WhatsApp/Signal/Matrix/Feishu/WeCom/Weixin/DingTalk/QQ/Yuanbao/Email/SMS
- 统一 `session_key`(platform + chat_id + thread_id 哈希)→ SessionEntry → AIAgent
- `GatewayEventDispatcher` + `GatewayStreamConsumer` 流式回推
- 17K 行 gateway 编排 + 11K 行 TUI gateway(WebSocket)
- relay 连接器(联邦)

**可借鉴点**:
1. ⭐ **统一 Platform 抽象**:pico 的飞书入口是硬编码,可抽一个 `Platform` 接口(send/receive/sessionKey),未来接钉钉/企微只需新适配器。
2. **流式回推**:pico 现在是整轮回推,可改为流式(streaming delta),体验更好。

### 10. MCP 集成

**pico-harness**:无

**Hermes** (`mcp_serve.py`, `tools/mcp_tool.py`):
- **双向 MCP**:既是 server(暴露对话工具给外部 MCP client)又是 client(消费外部 MCP server)
- `EventBridge` 轮询 SQLite 替代 WebSocket
- `SamplingHandler`(MCP server 可请求 LLM 采样)+ `ElicitationHandler`(请求用户输入)
- 远程 URL 白名单 + OAuth
- MCP 工具集继承进 subagent

**可借鉴点**:
1. ⭐ **MCP client 支持**:pico 可加一个 MCP client,挂载外部 MCP server(如 filesystem/git/playwright),工具生态瞬间扩大,不用自己写工具。
2. **MCP server 暴露**:反向地,把 pico 的对话能力暴露成 MCP server,供其他 Agent 调用。

### 11. 记忆 / 学习闭环

**pico-harness**:无跨会话记忆

**Hermes** (`agent/memory_manager.py`, `plugins/memory/`):
- **8 个可插拔 MemoryProvider**:honcho/mem0/holographic/supermemory/byterover/openviking/retaindb/hindsight
- 外部记忆**只在 API 调用时注入 user message,不持久化**(保 prompt-cache prefix)
- **FTS5 全文搜索** SQLite 会话库(`session_search`)
- Honcho 辩证用户建模:peer cards / 语义搜索 / 结论
- 本地文件 MemoryStore(零依赖兜底,带写审批门)

**可借鉴点**:
1. ⭐⭐ **FTS5 会话搜索**:pico 的 Session 持久化后,加一个 SQLite FTS5 索引,让 Agent 能 `session_search` 搜历史对话。这是低成本高价值的"长期记忆"。
2. ⭐ **MemoryProvider 抽象**:定义 ABC,先实现本地文件版,未来可接 mem0/honcho。
3. **瞬时注入策略**:记忆只注入 user message 不持久化,保 prompt cache,这个工程细节很关键。

### 12. Cron / 调度

**pico-harness**:无

**Hermes** (`cron/scheduler.py:2130`):
- `tick()` 每 60s 一次,`fcntl` 跨进程锁(至多一次)
- 执行前先 `advance_next_run`(at-most-once)
- 可配并行/串行 ThreadPoolExecutor
- 结果**投递到聊天平台**(`_deliver_result`)
- `CronPromptInjectionBlocked` 防 cron 定义中的 prompt 注入
- 每作业独立 toolset 范围
- 蓝图/建议目录(预置 cron job)

**可借鉴点**:
1. ⭐ **Cron 子系统**:飞书 AgentOps 场景下,加一个 cron,让 Agent 定时跑日志分析/备份/巡检,结果推飞书。这是 Hermes 的招牌自治能力。
2. **at-most-once + 文件锁**:多实例部署时防重复执行,工程细节值得学。
3. **Prompt 注入防护**:cron 定义是用户可控文本,需防注入。

---

## 三、借鉴优先级矩阵

按"性价比 = 价值 / 实现成本"排序,推荐 pico-harness 下一步借鉴的 Top 10:

| 优先级 | 借鉴点 | 来源模块 | 预估工作量 | 价值 |
|--------|--------|----------|------------|------|
| P0 | **Anthropic Prompt Cache 断点** | Provider | 0.5 天 | 成本直降 75% |
| P0 | **迭代式摘要 + Token 预算** | Compactor | 1 天 | 长会话质量飞跃 |
| P0 | **BillingRoute 定价表** | Observability | 0.5 天 | 成本可感知 |
| P1 | **Guardrail 防幂等无进展** | Reminder | 0.5 天 | 防循环增强 |
| P1 | **IterationBudget + Grace Call** | Loop | 1 天 | 防烧穿 + 优雅收尾 |
| P1 | **Skill Progressive Disclosure** | Skill | 1 天 | system prompt 防爆 |
| P1 | **Subagent 深度边界 + 角色** | Subagent | 0.5 天 | 防失控套娃 |
| P2 | **FTS5 会话搜索** | Session | 2 天 | 长期记忆 |
| P2 | **工具搜索桥(Progressive Disclosure)** | Tools | 2 天 | 工具扩展性 |
| P2 | **Cron 子系统** | 新模块 | 3 天 | 自治能力 |

---

## 四、哲学反思:pico 不该照搬什么

Hermes 是 150K 行的生产怪兽,pico 的价值在于**可读、可教、可演进**。借鉴时需克制:

1. **不要堆工具数量**:pico 的 4 原语是哲学声明,工具搜索桥比堆 100 个工具更符合极简主义。
2. **不要拆 12 个平台适配器**:pico 的飞书入口够用,平台抽象做到"可扩展"即可,不必先实现。
3. **不要上 8 个 MemoryProvider**:先做 FTS5 + 本地文件,接口预留即可。
4. **保留 Two-Stage ReAct**:这是 pico 的教学特色,Hermes 的原生 tool-calling 反而不适合教学。

**一句话**:借 Hermes 的**工程技巧**(prompt cache、迭代摘要、guardrail、深度边界),不借它的**规模膨胀**。pico 的每行代码都该能被一个学员在 10 分钟内读懂。

---

## 五、附录:Hermes 仓库关键文件清单

克隆位置:`/tmp/hermes-agent`(已拉取,depth=1,172MB)

| 模块 | 关键文件 | 行数 |
|------|----------|------|
| 主循环 | `agent/conversation_loop.py` | 4,486 |
| 工具注册 | `tools/registry.py` | 589 |
| 工具执行 | `agent/tool_executor.py` | 1,442 |
| 上下文压缩 | `agent/context_compressor.py` | 2,426 |
| Skill 管理 | `tools/skill_manager_tool.py` | 1,233 |
| Provider 基类 | `providers/base.py` | 217 |
| 委派 | `tools/delegate_tool.py` | 3,127 |
| 审批 | `tools/approval.py` | 1,943 |
| Guardrail | `agent/tool_guardrails.py` | 475 |
| 成本定价 | `agent/usage_pricing.py` | 908 |
| Gateway | `gateway/run.py` | 17,620 |
| Cron | `cron/scheduler.py` | 2,336 |
| MCP | `tools/mcp_tool.py` | 4,716 |
| 记忆 | `agent/memory_manager.py` | 949 |
