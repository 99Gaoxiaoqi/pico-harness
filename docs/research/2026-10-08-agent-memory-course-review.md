# Agent 记忆课程对 Pico 的架构启发

Pico 已有会话历史、压缩检查点、任务状态和跨会话长期记忆。阅读《Agent 设计模式之美》的记忆模块后，最值得借鉴的是把这些能力连成可核验的链路：关键判断经过压缩仍能指导行动，召回结果能追到具体来源，任务完成依据真实执行证据，经过确认的失败经验能在下一次同类行动前出现。

建议先补真实召回追踪，再验证交接的语义保真，以及 Goal 验收的证据输入。失败学习分阶段试点；记忆有效期在出现真实过时案例后再设计。当前没有依据要求重建记忆层、立即引入向量数据库或继续扩大召回预算。

## 阅读范围与依据

调研日期为 2026 年 10 月 8 日。三个只读子代理分别完整阅读第 11–12、13、14–15 章 PDF，并核对关键图表；主代理复核当前工作区代码及重叠结论。以下课程页码均指 PDF 物理页码。

| 章节                    | 原文重点                                                    | 对 Pico 的启发                                                 |
| ----------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| [11 记忆模块导论][课11] | p3–4 交接漂移；p6–8 工作台及可验证判断；p13–15 Memory Trace | 保存影响下一步行动的依据和约束，区分记下、取回、注入及有效使用 |
| [12 分层保留][课12]     | p2–8 分层坐标及升层；p16–20 生命周期、加载和工作集          | 复用现有分层，明确来源与失效规则，不把内容类别当权威级别       |
| [13 检索增强][课13]     | p15–18 解析与检索选型；p18–22 证据契约和追踪                | 贯通来源、版本、范围和引用；先定位漏召回原因，再选检索技术     |
| [14 进度追踪][课14]     | p8–11 目标与账本；p12–16 验收和漂移；p19–23 恢复材料        | 加强现有 Goal、Plan 与 checkpoint 的证据输入，避免复制状态     |
| [15 失败日记][课15]     | p3–10 从失败事实到教训；p11–21 确认、触发召回及效果评估     | 先保留经过确认、有适用条件的经验，再尝试行动前召回             |

本报告用课程原文支撑模式理解，用当前代码支撑实现判断。现有学习模式卡仅作辅助。报告中的实施顺序、范围和验收方法是对 Pico 的适配建议，不是课程要求。部分旧 Goal/Todo guides 已标记过期，其中的 todo.json、PLAN.md 和 Session JSONL 路径没有作为当前架构事实。

本轮没有修改运行时代码，没有执行测试或真实模型。以下验收方法均为后续实施建议，不能视为已经通过的结果。

## Pico 已经具备的架构

课程把记忆同时看作状态持久化、知识检索和经验累积。Pico 当前在前两方面已有明确组件，经验累积尚未形成完整闭环。

| 职责           | Pico 当前承载                                     | 当前边界                                                     |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| 稳定规则       | 用户与项目 AGENTS 等提示配置                      | 由既有指令体系确定权威；记忆不能改写权限或规则               |
| 当前任务状态   | Todo、Goal、SessionTask、Plan                     | 持久状态按需投影到模型输入，完成状态需要按各自语义判断       |
| 执行事实       | 会话消息、工具结果、RuntimeEvent、Plan operations | 可以回看、重建和定位执行过程，不会全部进入模型窗口           |
| 压缩续接       | 结构化 checkpoint                                 | 保存原始历史，替换后续模型读取投影                           |
| 用户长期记忆   | 用户级 memory.sqlite 的 Memory Items              | global/workspace 范围；常规提取以原始用户证据为准            |
| 外部研究资料   | 文件与网页工具、DeepResearch source artifacts     | 与个人记忆分工，当前文件和精确状态仍适合直接查询             |
| 可复用工程经验 | 用户确认的 failure Items 等                       | 有内容类型及通用检索，尚无完整自动复盘、审查和行动前召回管道 |

[PromptComposer][提示组合]已有 Todo/Goal 注入，[Host][会话任务]另有 SessionTask；Todo 实际由 [SQLite TodoStore][Todo存储]保存。Plan 已有持久事件、幂等、CAS 和中断恢复。课程中的五层货架可以帮助说明这些职责，但不意味着需要五套数据库，也不能取代 Pico 自己的指令优先级。

长期 Item 的 kind 是内容分类，scope 是可见范围，两者都不是权威级别。[记忆契约][条目契约]已有版本、来源、事件时间、观察时间和 active/archived 状态。[低信任包装][低信任包装]规定记忆是参考数据，不能授予工具权限。提取会检查原始用户引文，再独立规范化最终内容；压缩摘要没有直接升为用户事实。

[当前读取预算][记忆预算]是自动最多 3 条、320 tokens；主动最多 10 条、5120 tokens，单项连同包装最多 480 tokens。这些限制作用于进入模型的工作集，不限制库的总条数。课程支持“小工作集、按需扩大读取”的方向，并不能单独证明这些数值最优。

## 先补真实召回追踪和引用身份

第 11 章的 Memory Trace 要区分未写入、未命中、取回未用和适用边界错误；第 13 章进一步要求可用证据具有来源、版本、作用域和引用。对 Pico 而言，这是当前最直接的增量。[第11章 p13–15][课11]，[第13章 p18–22][课13]。

现有 ContextBuilder 已返回 references、diagnostics、tokenCount 和 truncated。diagnostics 能解释 selected、duplicate、budget、item_limit，桌面预览也能显示它们。但[真实主动搜索][真实搜索]只返回 block，[自动注入][真实注入]也只使用 block；这两条接线没有保留同等完整的本次召回元数据。

[渲染结果][记忆渲染]中，主动搜索包含 itemId，自动块不包含；两者都没有投射 Item version、contentHash 和原始 source event refs。source="user-evidence" 只是来源类别。数据库虽然已有来源，不能因此说模型的引用链已经贯通。

最小实现可以分两步，不需要另建追踪数据库：

1. 在真实注入与搜索路径记录请求关联、模式、各路候选数、选中 Item ID/版本、现有 diagnostics、token 用量、截断和耗时。尽量复用当前 Host 观测通路，先记录元数据。
2. references 保留本次读取的版本、hash 和 source refs，通过短 citation handle 关联模型可见条目与 Host 引用快照。完整 provenance 放在追踪记录，模型只读紧凑身份，避免大幅挤占 320/5120 tokens。

同时区分空结果原因。当前主动搜索统一返回 No matching active memory；仅从该字符串无法区分完全没有命中与候选因预算无法进入 block。可把无命中、预算不足、策略关闭分别传达。策略关闭等原因由 Host 准入层提供，不让 Builder 推断它不知道的权限状态。

验收应覆盖三种不同情况：零匹配、匹配但预算无法容纳、候选超过条数限制。真实请求记录要能分别解释结果；后续更正 Item 时，旧引用仍应表示当时读取的版本，来源会话不可用时明确说明；查询及引用不能绕过工作区信任和可见范围。预算上限仍需成立。

这里还有两个证据边界。当前 reference range 指向 **Item 正文的 code-point 区间**，不是原始用户消息中的引文位置。写入虽核验引文同时存在于原始事件和实际可见输入，但[提交保存][引文提交]的是事件 refs，没有保存原始 quote span。最小实现先支持追到具体版本和原始消息，精确引文区间可作为后续独立需求。其次，追踪证明记忆进入某次请求，并不能单独证明模型正确理解或使用了它；答案包含 citation ID 也不是语义正确的证明。

## 用真实续接验证关键判断是否保留

第 11 章的 auth.py 案例值得转成 Pico 的验收场景：摘要留下了重构主题和下一步，却漏掉依赖路径、已排除方案和禁止动作，下一轮便改变了操作顺序。这里需要保留的是可验证的判断和行动边界。[第11章 p3–4、p7–8][课11]。

Pico 已有[结构化压缩模板][压缩模板]：Goal、Progress、Key Decisions、Next Steps、Critical Context；[摘要提示][压缩提示]要求保留约束、未完成工作和失败尝试。必需章节目前不包含 Key Decisions，格式检查也不能判断重要决策的语义是否完整。因此需要加强的是续接验收，不能把它描述成“没有结构化记忆”。

建议先构造一条真实模型场景：任务已经验证某种操作顺序会失败，记录失败证据，确定替代顺序，然后触发压缩并继续。检查模型是否保留原目标、决策依据、被排除方案、禁止动作和下一步顺序，且没有重复已验证的错误路线。原始事件必须继续可回读。

如果该场景稳定暴露遗漏，再对现有模板增加明确的“决定及原因、禁止动作、证据位置”要求，必要时升级必需章节合同。直接增加几个标题只能改善格式，不能代替上述语义验证。恢复投影还可复用 Goal、Plan 的当前阶段及最近关键事件，但不应把它们复制成第二套可写任务状态。

这一项成本较低，主要收益出现在长编码任务、多次压缩和中断续行中。它不需要保存原始思维链，也不需要另建通用 scratchpad 服务。

## 让 Goal 验收读取真实执行证据

第 14 章将验收闸门与任务复诵、漂移提醒分开：复诵帮助保留目标，验收判断当前阶段是否满足条件。两者不能互相代替。[第14章 p12–16、p19–23][课14]。

Pico 已有独立只读 Goal 验收、固定 condition、预算及无进展控制。[Goal evaluator][目标验收]提示要求清晰具体的完成证据，但输入会过滤工具消息、toolCallId 和带 tool calls 的消息，只取最近六条用户或助手文本，每条最多 500 字符。[Host 调用][验收接线]直接传入 Goal condition 和 messages。

这意味着验收器目前主要依赖对话叙述，不能直接核对真实工具结果。这是可构造验证的架构缺口，本轮没有复现“任务被错误标为完成”，不能将它当作已经发生的行为缺陷。

最小实现是在现有验收调用中增加有上限的证据包，来源限定为本 Run 的真实工具结果、执行状态和相关产物引用，附带事件身份与时间。工具正文按低信任数据处理，程序保留退出状态等机械事实。无需增加每轮模型调用，也无需建立另一套执行状态机。

建议验收用例同时提供“助手声称检查通过”和“工具实际失败”的冲突输入。集成检查先确认失败证据确实进入验收请求，随后用真实模型验证它不会仅凭助手陈述判定满足目标。补充成功主路径，并检查证据与当前 Run、目标范围对应，避免拿过时成功记录证明新任务完成。

Plan 的控制进度与 Goal 验收也应继续区分。[PlanStep][计划合同]当前没有独立 acceptance/evidence_refs；全部步骤进入 completed/skipped 等终态会结束 execution，其中 skipped 是[已有测试确认的有意语义][跳过语义]。结束控制流程不自动证明用户目标已经达成，不能把 skipped 当作这轮发现的 bug。只有实际任务需要分阶段验收时，才值得扩充 Plan 的公开合同。

## 分阶段建立经过确认的失败经验

第 15 章区分失败事实与可复用教训：前者保留症状和原始证据，后者应有短根因、修复、禁止动作和召回条件。修复当前问题不等于已经形成跨任务经验；偶发网络抖动也未必值得长期保留。[第15章 p3–10][课15]。

Pico 的 failure 目前是普通 Item 内容类别。[提取准入][用户证据]以原始用户证据为基础，不会因为工具失败就自动写下受信根因。自动召回查询来自 currentUserPrompt，尚无按即将使用的工具或任务族主动取回失败卡的入口。MemoryExtractionFailureClass 描述的是记忆提取管道的错误类别，也不是 Agent 任务的失败分类。

课程启发可以用一个范围明确的试点落地：

1. 选择一种已经出现、有复发价值的确定性工程问题。失败时从 RuntimeEvent、当时 Goal/Plan 和用户纠错生成草稿，保留症状、候选根因、已验证补救及证据。候选根因不能直接当事实。
2. 草稿经用户确认后，才通过既有准入保存为当前 workspace 的短 failure 经验，并生成明确任务/工具/环境检索 keys。未经确认的草稿不参与长期经验召回。
3. 先在一种能明确识别的任务规划入口取回最多一张短卡，再按效果决定是否扩到风险动作前。使用现有预算、低信任说明和工作区过滤。

卡片的适用条件至少能表达“什么任务、什么环境或工具条件下，曾验证什么错误做法，应先检查什么”。只按 bash 匹配过宽，容易使无关任务也收到提醒。历史经验应作为需要核对的风险提示，不自动升级为 AGENTS 指令，也不能授予权限。[第15章 p11–17、p19–21][课15]。

验收应证明：未经确认的草稿不召回，确认后来源可回看；同类任务在行动前能看到经验，无关任务和其他工作区不会收到；环境已变化时不会盲目套用旧补救。效果以同类场景的重复失败率为主，结合有效提醒、漏提醒和误提醒。单纯统计新增多少 failure Items 无法说明 Agent 学到了多少。

这一项涉及证据来源、保存合同及召回时机，风险高于追踪接线。先试点，再扩展；不建议直接放宽当前用户事实提取 gate，或者自动把失败送入训练和 Skill。

## 有真实过时案例后再增加失效治理

分层保留要求不同内容具有不同生命周期，旧内容可以失效或降权。Pico 已有用户更正、CAS、归档和恢复，但 Item 契约没有独立有效期、替代关系或自动降权规则。[第12章 p16–20][课12]，[条目契约][条目契约]。

这里必须分开事件时间和召回有效性。项目在某月处于某阶段，这条历史事实后来仍可用于回答“当时是什么状态”。eventEndedAt 表示事件区间结束，不能直接当成 TTL；updatedAt 也不能证明事实现在仍然适用。[现有真实模型日期场景][日期用例]明确要求新旧事实共同可见。

建议只有在稳定出现“临时配置或阶段偏好持续干扰当前任务”之后，才设计用户显式设置的失效条件。先使失效内容停止自动注入，保留主动历史搜索并说明状态；无期限稳定偏好不按年龄淘汰。不做模型自行猜 TTL 或自动物理删除。

验收要同时覆盖当前询问与历史询问：前者不被失效配置干扰，后者仍能取回对应日期事实。新增有效性字段属于持久化变更，需要数据库兼容、索引及删除/恢复行为一起设计。若再加入 supersedes 关系，还必须保留历史陈述，不能简单用最新一条覆盖全部旧记录。

## 检索技术由真实问题决定

第 13 章明确区分个人长期记忆、外部知识 RAG、当前文件搜索和结构化查询。Pico 当前的短原子 Item 主要属于个人与项目记忆；代码、配置和日志应继续直接读取，精确 ID 和状态优先从对应工具查询。[第13章 p16–18][课13]。

先建立一小组脱敏真实查询，标注期望 Item、来源、不得返回的范围和缺失原因。观察候选是否命中、是否进入预算、关键原文是否可读、最终任务是否正确。既有万条 marker benchmark 证明其测量范围内的容量和时延，不能替代同义改写、隐含关系或跨语言查询质量评估。

| 稳定发现的问题               | 对应改进方向                               |
| ---------------------------- | ------------------------------------------ |
| 本地正文扫描成为主要时延     | 评估全文索引等本地检索优化                 |
| 同义表达或跨语言持续漏召回   | 比较语义检索或混合检索                     |
| 候选正确但被无关项挤出       | 改善排序及查询信号                         |
| 候选正确但关键证据不在摘录中 | 调整摘录或增加按引用展开读取               |
| 来源或事实已失效             | 完善有效性和版本治理                       |
| 已注入正确证据但任务仍出错   | 检查证据解释、规划和执行，而非只扩大 top-K |

课程中的企业 RAG 权限域、owner、index manifest、蓝绿发布、复杂解析和多轮改写管道，只有在 Pico 承接长期重复查询的外部语料库后才有明确收益。届时从一个受限语料集和真实问题集开始，保持它与个人记忆存储的职责分工。

相邻模块里，DeepResearch 可以先借鉴局部引用。当前 source artifact 已有 locator 和 contentHash，派生报告要引用已有 source，但 hash 校验的是持久化 artifact body，并不自动等于原始 PDF 或网页的 hash。后续可在现有 source 路径补 PDF 页码/网页章节、捕获时间及程序计算的原始来源快照身份，用一份带表格 PDF 和一个变化网页验收，无需把外部文档全部写进 Memory Items。[第13章 p9、p15–16][课13]，[研究来源合同][研究来源]。

## 采用顺序与实施边界

| 顺序     | 建议                               | 最小交付                                         | 成本与主要风险                         |
| -------- | ---------------------------------- | ------------------------------------------------ | -------------------------------------- |
| 第一批   | 真实召回 trace、缺失原因与引用身份 | 能解释一次真实查询，定位当时 Item 版本和源事件   | 低至中；控制追踪数据和跨工作区回看权限 |
| 第一批   | 压缩交接的语义保真                 | 一条真实模型续接验收，再根据结果调整模板         | 低；避免只增加标题而没有行为收益       |
| 第一批   | Goal 的真实证据输入                | 有界证据包，验证“助手说成功、工具失败”的冲突场景 | 中；事件归属、长度、敏感信息和注入边界 |
| 第二批   | 经过确认的失败卡和一次提前召回     | 一个任务族、一个工作区、最多一张短经验卡         | 中；错误根因、过宽触发和未经确认的晋升 |
| 条件触发 | 独立失效条件                       | 当前自动召回过滤，历史仍可查询                   | 中至高；持久化兼容及时间语义           |
| 条件触发 | 检索或外部知识库升级               | 根据真实遗漏类型做小范围比较                     | 随问题变化；不让框架复杂度先于收益     |

这些建议可以沿用 Pico 的 Host 身份绑定、RuntimeEvent、已有任务状态机、记忆来源核验和统一 ContextBuilder。具体实施应逐项验证，以各项验收结果决定下一步。

暂不建议照搬五套存储 backend、课程示例 TTL/token 配额、自报 confidence 自动晋升、固定每几次调用就另调模型的漂移评分、完整业务 Saga，以及未经审查的自动训练。它们各自有适用场景，当前 Pico 尚缺少足够明确的需求和效果证据。

[课11]: /Users/anxuan/geektime-downloader/Agent设计模式之美/11｜记忆模块导论：从草稿纸到长期记忆，建立Agent的经验沉淀秩序.pdf
[课12]: /Users/anxuan/geektime-downloader/Agent设计模式之美/12｜分层保留：给Agent的记忆建一套货架.pdf
[课13]: /Users/anxuan/geektime-downloader/Agent设计模式之美/13｜检索增强：Agent的知识库和证据链.pdf
[课14]: /Users/anxuan/geektime-downloader/Agent设计模式之美/14｜进度追踪：长任务中别让Agent走丢.pdf
[课15]: /Users/anxuan/geektime-downloader/Agent设计模式之美/15｜失败日记：让Agent把摔过的跤变成本事.pdf
[提示组合]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/prompt-composer.ts:221
[会话任务]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/agent-runtime.ts:2623
[Todo存储]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/storage/src/todo-store.ts:111
[条目契约]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/core/src/atomic-memory-contracts.ts:75
[记忆预算]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/atomic-memory/context-builder.ts:10
[低信任包装]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/atomic-memory/context-builder.ts:20
[真实搜索]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/agent-runtime.ts:2522
[真实注入]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/agent-runtime.ts:2634
[记忆渲染]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/atomic-memory/context-builder.ts:318
[引文提交]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/atomic-memory/extraction-engine.ts:851
[压缩模板]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/history-compact-summary-validation.ts:47
[压缩提示]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/full-compactor.ts:46
[目标验收]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/goal-evaluator.ts:58
[验收接线]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/desktop-runtime-service.ts:2721
[计划合同]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/core/src/plan-contract.ts:20
[跳过语义]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/tests/integration/runtime/plan-mode-state-machine.test.ts:128
[用户证据]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/atomic-memory/extraction-engine.ts:850
[日期用例]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/tests/e2e/atomic-memory-search.real-llm.test.ts:156
[研究来源]: /Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/core/src/deep-research.ts:135
