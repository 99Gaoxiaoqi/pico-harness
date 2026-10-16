# Pico 记忆与自主学习改造方案

日期：2026-10-16。代码基线：`cef587d11f2cdfb9240946e87d283f37a30c22d5`，长期记忆 SQLite schema 为 v15。

## 目标与主要决定

记忆帮助后续任务减少重复纠正、找回可靠事实和复用有边界的方法。保留现有事件日志、SQLite、来源记录、实际投递账本、原子提交和撤销机制，重点调整内容准入、召回和纠错。

本次采用以下决定：

1. 任务状态、长期事实、任务案例和方法经验分开表达，复用既有存储。
2. 低风险且范围明确的方法自动成为可用建议。通用经验无需等待确定性验证器，也无需逐条人工确认。
3. 证据记录具体发生过什么，影响排序和保留期限。取消统一的“两次成功转正”；人工批准、局部验证和多次复用均不自动扩大适用范围。
4. 因果不明、只有一次偶然结果的内容保留为案例，不生成通用规则，也不自动形成待审任务。
5. 人工处理明确的高影响使用决定、长期做法冲突和适用范围扩大。记忆不能修改工具权限或审批配置。
6. 明确纠正、可信反证、到期和删除在下一次读取或投递前生效；模型反思继续在后台进行。
7. 验收分三轮：本地确定性检查、真实模型闭环、冻结记忆后的跨任务对照。每轮有明确结束条件。

### 保持的默认值

| 项目         | 默认行为                                                     |
| ------------ | ------------------------------------------------------------ |
| 自动事实提取 | 正常结束或合法压缩检查点后，空闲 30 秒防抖                   |
| 明确要求记住 | 立即走现有显式保存入口                                       |
| 后台经验反思 | 无前台运行且空闲 10 秒；新输入中断在途模型调用               |
| 反思预算     | 每个候选最多 2 次模型尝试，每工作区每滚动小时最多 4 次       |
| 自动召回     | 总计最多 3 条、320 tokens，其中最多 1 条方法经验             |
| 主动记忆搜索 | 沿用最多 10 条、5120 tokens 的总预算                         |
| 事实整理     | 自动提取成功后尝试，冷却 6 小时，最多 256 条；失败也进入冷却 |
| 事实整理撤销 | 30 天，整批校验后恢复，版本冲突时不部分恢复                  |

30 秒与 10 秒承担不同工作；6 小时是整理冷却条件，不是独立定时任务。

## 当前代码及需要解决的问题

| 当前实现                                                           | 改造点                                                           | 代码入口                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 事实提取已有防抖、冻结边界、用户原文校验和原子提交                 | 保留事实链路；临时状态、工具经历和模型猜测继续与事实分开         | [atomic-memory-runtime.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/atomic-memory-runtime.ts:28)                                                                                                                                                                    |
| 经验主要由失败、纠正、中断及恢复触发                               | 增加有价值成功的有限预筛；反思允许输出案例、方法或跳过           | [task-experience-runtime.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/task-experience-runtime.ts:676)                                                                                                                                                               |
| 风险判断混合了危险内容、失败恢复证据、工具是否非空和范围完整度     | 分开内容风险、来源完整度和方法适用范围；因果不明留案例           | [execution-learning-store.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/storage/src/sqlite/execution-learning-store.ts:2027)                                                                                                                                                       |
| 低风险 trial 已经自动可用，但自动晋级仅覆盖少数验证范围            | 保留自动建议路径；证据只记录范围内结果，取消次数驱动的成熟度更新 | [experience-feedback-store.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/storage/src/sqlite/experience-feedback-store.ts:545)                                                                                                                                                      |
| 非表格自由文本条件通常只能返回 unknown，trial 又要求工具与条件     | 拆开检索提示、使用说明和宿主能核实的硬条件，允许无工具的方法     | [agent-runtime.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/agent-runtime.ts:2675)                                                                                                                                                                                  |
| active 比 trial 放宽部分未知条件                                   | 所有方法使用同一范围检查，人工批准也不能绕过硬条件               | [task-experience-recall.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/task-experience-recall.ts:108)                                                                                                                                                                 |
| 通过预筛的经验即使无词法相关性，也有保底分进入候选                 | 删除通用经验保底分；必须有区分度的相关性命中                     | [context-builder.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/atomic-memory/context-builder.ts:272)                                                                                                                                                                   |
| correct 会暂停旧版，但 restore 只拦截 suspended 且 validation=fail | 按纠正和反证原因锁住旧版，普通恢复不能重新启用                   | [execution-learning-store.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/storage/src/sqlite/execution-learning-store.ts:1690)                                                                                                                                                       |
| 协议 v2 为严格字段校验；公共候选和 metadata 仍有 spread 投影       | 新增 v3 协商，v2 用显式白名单投影，不能直接追加字段              | [task-experience.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/protocol/src/runtime/task-experience.ts:74)、[desktop-atomic-memory-service.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/desktop-atomic-memory-service.ts:903) |

## 内容分层与保存规则

| 内容     | 复用的存储                                                     | 写入要求                                                 | 后续使用                               |
| -------- | -------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| 任务状态 | canonical journal、任务和 observation 投影、上下文压缩         | 真实事件和任务身份                                       | 当前任务续跑，不自动提炼为长期规则     |
| 长期事实 | memory_items、来源和提取游标                                   | 稳定、有将来用途的用户原文；显式助手笔记保留未经核实标签 | 按当前范围、相关性和预算召回           |
| 任务案例 | execution_learning_candidates 中的 case，关联现有 observations | 目标、实际操作、结果及来源；未发生的提议明确标记为提议   | 记忆页查看或主动搜索，不自动注入新任务 |
| 方法经验 | 同一候选记录，加已有 memory_item 和经验 metadata               | 条件、做法、来源、例外；无来源的因果推断不能充当事实     | 作为有边界的建议，相关时少量召回       |

事实类别继续沿用偏好、身份、背景、知识、失败和笔记等现有枚举。案例和方法是经验记录的表达形式，不扩充普通事实的类别。

环境和工具结果可以证明“当时观察到的情况”，本轮只进入案例、方法条件和验证证据，不自动成为用户自述或全局规则。助手推断、引用材料和工具返回的指令不能提升为用户偏好。凭据、秘密、跨工作区伪造来源在派生记录提交前拒绝，不交给人工批准兜底。

第一版不自动生成或安装可执行技能。重复使用的方法可以后续整理为技能，涉及脚本执行和正式路由时另行设计测试及发布流程。

## 触发时机与后台调度

### 触发矩阵

| 事件                        | 同步完成的工作                                                 | 后台工作                                        |
| --------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| 新用户输入已提交            | 建立新输入屏障、中断后台模型；记录原文；处理能够精准归因的纠正 | 重置事实计时，保留仍有效的待办                  |
| 正常 Run 结束且终态已持久化 | 更新任务观察；轻量判断是否有学习线索                           | 30 秒后事实提取；符合条件的经验进入现有反思队列 |
| 合法压缩检查点              | 保存边界和游标上下文                                           | 30 秒后增量事实提取；不把压缩摘要本身当事实证据 |
| 用户明确要求记住            | 现有 memory_remember 保存并返回实际保存结果                    | 不依赖空闲反思，也不触发批量人工审核            |
| 用户纠正某条经验            | 精准暂停该内容版本、记录纠正来源；下一次请求排除旧版           | 空闲后反思并提出修订，不自动解除暂停            |
| 真实结果验证完成            | 按 useId、版本和范围写证据；可靠反证锁住当前版本               | 无需额外模型调用，不为证明有效重跑工具          |
| 自动事实提取成功            | 提交事实、来源、游标和回执                                     | 满足冷却时尝试事实整理                          |
| 下一次读取或投递            | 检查当前开关、权限、版本、期限和暂停原因                       | 到期内容随后归档；不能等整理完成才停止召回      |

### 哪些成功任务进入反思

成功预筛只决定是否值得花预算反思，不证明经验有效。普通成功和普通 exit 0 不入选。

自动成功入口要求：终态完整且成功；存在至少两类可识别的已提交操作；有实际产物回执或针对具体结果的明确肯定；同时存在具体做法变化、排障切换或可重复流程的源事件。操作类别依据已有工具 action、提交和验证回执判断，不按 bash 次数或工具名字数量推测复杂度，不解析任意 shell 去猜目的。

保留独立入口：用户明确指出某个具体做法有用，或明确要求沉淀该做法，可以进入反思，允许没有工具调用。“好”“继续”和用户沉默不满足这个条件。无法可靠预筛的成功任务仅保留原任务记录。

明确长期偏好仍优先走事实入口；要求保存上一条助手回答仍是带未经核实标签的笔记。只有指向实际方法和可定位任务证据的沉淀请求才排经验反思，不能把笔记保存回执当成方法已经形成。

相同任务与来源片段只保留一个反思待办；最新纠正优先，同任务新边界合并。沿用每候选 2 次和每工作区每小时 4 次的上限，不新增逐轮学习模型。

### 反思产物与提交

反思模型只输出以下一种结果，并引用冻结输入中的实际来源 ID：

- case：保留目标、过程、结果和未知项，不能写成已证实的普遍因果。
- method：提出适用场景、做法、例外与支持来源；由 Host 决定使用策略。
- skip：没有新增、稳定或值得保留的信息。

未找到有效来源、来源越界或含秘密的输出拒绝提交。来源有效但原因不明的输出降为案例。模型不能设置 enabled、review、validation、到期时间或清除暂停。

### 新输入与后台恢复

在 AgentRuntime 中先更新前台 generation 和输入 epoch，再进入 capture，避免即时纠正与后台旧结果交错提交。处理纠正前保存旧 taskId/taskVersion 和实际投递身份，不能升版本后再用新身份查旧引用。

区分“中断模型调用”和“永久丢弃来源仍有效的待办”：冻结的来源任务身份不变；下次空闲重新领取有效待办时使用当前调度 epoch 和新租约。来源任务后来被纠正、删除或归档时，旧方法提案不得提交。提交仍检查 owner、fencingToken、lease、expectedRecordRevision、设置版本、删除 revision 和 tombstone。

## 数据契约与状态

### 增量字段

在现有 TaskExperienceCandidate 和内部 metadata 上增加以下字段，不新建经验数据库：

| 字段               | 内容与归属                                                                          |
| ------------------ | ----------------------------------------------------------------------------------- |
| representation     | case 或 method，表达保存的内容形式                                                  |
| usagePolicy        | case_only、suggestion、review_required、blocked；仅 Host 写入                       |
| matchHints         | 最多 8 个有区分度的短词组；用于本地相关检索，不能只有“任务、代码、文件、测试”等泛词 |
| requiredConditions | Host 支持的有限结构条件；模型只能引用已观察的条件身份，Host 构造并校验              |
| decisionKind       | 可选，高影响方法、范围扩大或明确长期规则冲突；与 reviewReason 一起解释人工决定      |
| expiresAt          | 可选，由 Host 设置；模型不得续期                                                    |

现有 applicability.toolNames 只表示实际依赖工具，允许为空；conditions 在 v3 作为使用说明展示。新记录的硬限制必须写入 requiredConditions。旧 conditions 只有经确定性识别后才能拆分，不能静默变成软说明。

第一版 requiredConditions 只复用现有 nativeEvidence 冻结范围和表格输入检查。平台、依赖版本等条件只有实现了宿主检查器才可加入；未支持的条件保持未决，不能默认满足。

### 字段职责

- enabled 和 lifecycleState：当前开关与归档状态。
- usagePolicy：保存为案例、可以参考、等待决定或被暂停。
- review：只记录用户是否批准、暂缓或拒绝。
- validation：保留现有范围内的验证状态和旧值，不提升为整段方法的正确性结论。
- maturity、promotionReason、positiveReuseCount：保留历史兼容读取；新召回不据此放宽范围，反馈不再按次数更新成熟度。
- evidenceSummary：查询时从既有 uses、effects 和明确反馈派生，不持久化模型置信分。

证据摘要显示实际投递次数、独立任务数、已观察采用数、具体范围的结果及反证。按 candidateId 和 contentVersion 汇总；原生证据继续绑定 claimRevision、claimHash 和 scopeHash。历史回执和未知投递不补造为新证据。

### 必须成立的状态约束

| 内容与策略               | enabled                   | memory_item        | 自动召回                                 |
| ------------------------ | ------------------------- | ------------------ | ---------------------------------------- |
| case + case_only         | false                     | 不创建             | 不允许                                   |
| method + suggestion      | true 或用户停用后的 false | 允许存在           | 还需通过全部相关性、范围、期限和权限检查 |
| method + review_required | false                     | 新候选不创建       | 不允许                                   |
| blocked                  | false                     | 可保留历史关联     | 不允许                                   |
| archived                 | false                     | 按既有归档机制保留 | 不允许                                   |

案例完成可沿用 state=ready、job=completed，不把 state=saved 误当必须有 memory_item 之外的新含义。方法发布继续原子创建 item、来源映射和 metadata。枚举组合由 Store 事务校验，不能由 UI 拼接状态。

现有 prune 会处理 ready 等状态，必须排除已经完成的 case，避免把可撤销归档误做正文清理。v3 的处理状态根据 job 与 representation 投影；完成的案例不能显示为仍在等待模型。所有策略和类型过滤在分页前执行，避免案例占满一页后挤掉可用方法。

## 经验怎样使用与积累证据

### 自动召回顺序

1. 检查总开关、召回开关、工作区和目录、当前内容版本、归档、暂停、删除及 expiresAt。
2. 仅考虑 method + suggestion；案例、待审和被纠正记录直接排除。
3. 检查声明依赖的工具存在且当前允许。工具列表为空合法。
4. requiredConditions 全部为 true 才通过；false、unknown 或检查器不存在均不通过。人工批准和历史 active 使用相同规则。
5. 用现有本地检索匹配 matchHints。必须命中有区分度的完整 token、路径或词组；中文可复用至少两个有信息双字词的匹配，但不能把重叠双字词当作多个独立支持。
6. 按相关性排序；相关程度相同，再考虑当前版本的明确支持、局部验证和时效。无证据的近期记录不能压过更相关的记录。
7. 在总计 3 条、320 tokens 和最多 1 条方法的预算内组装上下文；条件和来源标签不可截掉，只能截方法正文，无法完整容纳则不选。

删除 reviewed-reference 的保底 1 分，不以 taskFamily 匹配代替内容相关性。精确 native scope 匹配可以构成单独的宿主相关信号，但不能替一般方法兜底。第一版接受部分同义改写漏召回，不添加每次请求的模型重排器。

所有方法使用统一提示：这是历史建议；说明适用条件、来源与已知证据范围；当前任务仍需核对。无论证据多少，都不成为权限或审批依据。

### 案例的主动查阅

扩展现有 memory_search，增加可选 record_type=memory 或 case，缺省仍为 memory。case 模式从同工作区、同目录的经验候选查询，输出低信任历史摘要、案例身份、日期和来源。最多 3 条案例、1500 tokens，并计入主动搜索 5120 tokens 总预算。

案例只经显式工具查询或用户打开详情进入上下文，不混入自动事实召回，不创建虚假的 memory_item 或实际采用记录。含有未采用的提案时明确标记。已删除、秘密内容、无权范围仍拒绝读取。

### 证据不会自动扩大使用范围

保留 retrieval、delivery、adoption、validation 的分离。只有 Provider 请求确认携带了原片段，才能标记已引用；是否采用由实际行为和现有验证证据判断。无法观察时显示未知。

新增可选的 helpful 反馈，绑定 useId 和对应内容版本，表示用户认为这条建议有用。它只进入现有反馈回执及派生摘要，不写 validation=pass。用户对整个任务的表扬不能给本轮全部经验加分；首版不自动解析含糊表扬生成该反馈。

同一 use/outcome 重放必须幂等；相同身份、不同内容必须报冲突。独立支持按真实目标及来源任务族去重，合并 previousTaskId/goalId 的续跑链，模型重试、工具重跑和多个 useId 不累加成独立任务。

确定性结果展示为“某次操作、某个冻结范围通过”；命令成功展示其检查条件。若不能说明检查覆盖了哪条主张，就不显示“方法验证通过”。失败也要判断是否构成对这条经验的反证，普通任务失败不自动全局停用。

取消固定两次或一次验证触发的通用 active 更新。证据影响同等相关性下的排序和保留期限，不触发规则权限变化。已有历史晋级记录原样可查。

## 人工审核与即时纠错

### 哪些内容需要用户决定

| 情况                                                   | 处理                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 有来源、低风险、范围明确的普通方法                     | 自动作为建议，无审批按钮                                                     |
| 因果不明、只有偶然成功或来源覆盖有限                   | 保留案例，说明未知项，不排入待审队列                                         |
| 拟把删除、发布、外部发送、资金等高影响动作作为默认做法 | review_required，用户批准前不自动复用                                        |
| 拟扩大已有方法的项目内适用条件                         | 用户开始修订时暂停当前版，新范围批准前不生效；旧内容及范围保留在历史中       |
| 拟改变用户明确的长期做法                               | 展示既有原文与拟议变化；用户在编辑器明确保存后才更新，学习模型不得自行改规则 |
| 请求绕过权限、信任、审批或凭据设置                     | 不发布为方法；配置变化走专门设置和授权入口，记忆审核不能授予权限             |
| 秘密、伪造来源或无权范围                               | 拒绝派生写入，不进入人工队列                                                 |

现有高风险词表继续作为保守拦截信号。仅提及“删除”“审批”并不自动生成待审任务；不能确定实际建议动作时保留案例。模型不能通过自报“低风险”绕过宿主拦截。高风险操作发生时仍执行原有权限与审批检查。

### 决定卡与操作语义

决定卡必须说明拟改变什么、现有与拟议做法、适用范围、来源和影响。没有具体可决定的变化，不创建卡片。

- accept：允许所列方法在所列范围内作为建议；review=approved，不生成验证通过。
- edit_accept：用户明确编辑并批准；建立新内容版本，旧验证附件和当前版本计数不继承。
- 新增 revise：普通保存修订。旧版先停用，新版经 Host 判断成为建议、案例或待审；编辑本身不等于批准高风险做法。
- 新增 keep_case：保留为案例，取消该候选的决定请求；已有 item 先归档并解除当前发布关联，保留来源及旧使用历史，不调用删除正文的清理流程。
- defer：继续不复用，用户可稍后处理；打开或关闭卡片都不会提交此操作。
- reject/delete：沿用清除正文、取消待办、tombstone 和回执脱敏语义；“保留案例”不能冒用 reject。
- disable/archive：停止后续引用；普通停用与可撤销归档不写成验证失败。
- restore：重新校验期限、范围和当前策略。user_correction 或 trusted_reuse_contradiction 不允许普通恢复，必须明确修订成新版本。

v3 的 case 转 method 需要用户明确编辑并选择“保存为方法”，校验来源和适用条件，建立新 contentVersion。后台可以依据新事件创建另一个方法提案，但不能自行改写旧案例、清除暂停或继承旧版验证结论。

普通修订审计明确标为用户编辑，保留 operationId 和旧版关系；不能编造用户消息 eventId，也不能用旧来源和旧验证为新文字背书。涉及既有长期事实或规则的决定卡只提供跳转至对应记忆编辑器，用户明确保存后按现有手工写入路径更新；本次不增加自动改写规则的执行器。

### 即时纠错的归因边界

用户在某条使用记录上点击纠正时，按 useId、candidateId 和内容版本立即暂停。自然语言纠正只有在明确指出具体记录、原文或唯一对应做法时才作同等处理；普通“结果错了”仅记录任务纠正，不批量禁用本轮所有经验。

不适用只排除当前任务，不影响其他任务。可信反证对当前内容版本形成暂停锁；乱序到达但来源有效的反证同样生效，后来的成功不能自动解除。旧版历史账本保持冻结，新版本重新积累证据。

事实纠正也采用相同的精确归因原则：管理页按 itemId/version 直接修订；自然语言能够确定绑定旧事实及其范围时，先用现有 CAS 归档使旧值退出召回，新值经原文校验后保存。无法确定绑定时，以当前用户输入为准，交给后续增量提取处理，不批量归档同类事实。纠正不是删除，原始来源和操作历史仍保留。

## 交互设计

### 对话中的学习回执

默认仍折叠“本轮任务学习”。只显示有实际保存回执的内容，例如：

> 已保存 2 条事实、1 条可用建议；另保留 1 条任务案例。

没有新增时不刷“学习完成”。删除“正向复用 1/2”“已晋级并启用”等进度文案。普通方法显示“可用建议”；案例显示“保留本次过程，尚不能推出通用方法”。后台尚未提交时只显示处理中，不能提前声称记住。

事实计数读取已提交 extraction receipt 的 createdItemCount，案例和方法计数读取已完成候选。v3 查询增加按 session 与 operationId 去重的 receipt 摘要，后台提交后发送现有资源刷新通知。一次提取覆盖多个 Run 时显示“本会话最近保存”，不把整批事实归给最后一轮，也不把累计计数重复显示成新增。

只有 review_required 出现“需你决定”卡，按钮按具体变化显示“允许在所列范围使用”“编辑后决定”“保留为案例”“稍后决定”“删除”。忽略卡片保持不复用，不反复弹窗催审。

### 记忆页与使用记录

- 保留当前“已保存、待审核、已归档、使用记录”的导航结构；“待审核”文案改为“需你决定”，旧 tab=pending 路由仍可访问。
- 已保存增加类型筛选：事实、方法建议、案例。案例不强行出现在 memory_items 列表，而是由页面统一加载 v3 learning.query 的案例投影；默认列表优先展示可用事实与建议。
- 主状态显示可用建议、仅作案例、需你决定、已暂停、已停用、已归档；暂停原因、条件未核实和到期时间在详情说明。
- 详情展示来源、适用条件、例外、实际引用、采用与具体范围结果。人工批准和验证记录分别显示。
- 使用记录保留“本次不适用”“停止引用”，增加可选“这条有用”“纠正这条”；不要求用户逐次反馈。
- 普通修订按钮显示“保存更正”，使用 revise；明确批准按钮才调用 accept/edit_accept。
- 双击只提交一次；CAS 冲突保留草稿；工作区切换隔离迟到响应，编辑期间继续保护范围切换。

### 设置

保留三个现有开关，不增加审批模式或逐条反馈开关：

| 开关             | 语义                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| 记忆总开关       | 关闭自动记忆读写与召回；管理和显式删除入口保留，普通运行日志按既有职责记录                                   |
| 自动提取长期信息 | 控制自动事实提取、经验反思和派生案例；关闭后仍可使用已有记忆，并保留允许的实际效果回写；显式记住仍需用户授权 |
| 召回记忆         | 控制自动注入与 memory_search；关闭后仍可学习，管理页仍可查看                                                 |

说明文案：“有依据的事实自动保存；范围明确的低风险方法可作为建议；案例只留记录；需要改变长期做法或扩大范围时由你决定。”

## 整理与遗忘

普通事实整理保留现有自动流程和 6 小时、256 条、30 天撤销默认，继续优先归档。冲突比较同一范围、类型与有效时间；模型按新旧和明确纠正择优，互补或无法确定冲突时保留。案例与方法不混入这条已有事实整理查询。

经验使用既有维护入口扩展确定性期限检查，不增加常驻模型整理器。新默认：自动案例 30 天无后续证据归档；自动方法从创建或最近明确支持起 90 天到期。期限只是保留策略，不表示可信度。实际投递、卡片打开、模型自评不续期。用户批准或主动保留的记录不设自动期限，但条件变化、纠正和反证仍即时拦截。

到期先由读取和投递门禁排除，再在下一次空闲维护时归档。自动归档保留来源，30 天内可在原记录上撤销；撤销重新校验当前版本、范围及暂停原因，不恢复已删除正文，不清除纠正或反证锁。经验归档用自身 action/restore 审计路径，不冒用普通事实的整批撤销接口。

因到期而归档的撤销按钮明确写为“恢复并重新保留 30 天”或“恢复并重新保留 90 天”。该显式用户 restore 在同一事务更新期限并记录审计，不能恢复后仍沿用已过去的 expiresAt。普通被纠正或被反证记录不提供这个恢复入口；30 天窗口由已有 action 创建时间校验。

v16 迁移时不给历史用户记录补造使用时间或验证事件。旧自动记录若无法计算期限，首版不追溯过期；详情标为历史记录，只有真实新支持或用户编辑才建立新期限。新记录采用上述默认。

## 协议与迁移

### v3 能力协商

新增 capability：memory-learning-v3。复用 memory.learning.query/detail/review/feedback 和 memory.experience.\*，不创建平行的管理 API。

- 请求未指定版本或指定 2：严格返回既有 v2 结构，只含原有字段和合法枚举。
- 请求 learningVersion=3：返回新字段、案例、策略、具体决定类型和派生证据摘要。
- 新客户端连接旧 Host：回退 v2 界面并显示旧语义，不发送 v3 动作。
- 旧客户端连接新 Host：普通方法保持 v2 投影；新案例不伪装成 pending；新策略的权限、期限和暂停检查始终由 Host 生效。

memory.list/detail 中的 taskExperience 摘要、会话或工作栏摘要、使用详情和事件刷新均按协商版本投影。publicExperienceCandidate 和 projectItem 改为显式字段白名单，不对内部 JSON 使用 spread 直出。旧 action 哈希及已完成回执继续幂等，不能通过增加字段改变旧请求身份。

v3 在 review 上新增 revise、keep_case；在 experience feedback 上新增 helpful，并支持指向具体 use 的纠正。新动作由 v3 validator 显式允许，v2 保持原枚举。memory_search 的 record_type 由对应 Host 工具定义提供，缺省行为不变。

### schema v16

复用现有初始化事务，为候选 JSON、execution_learning_items.metadata_json 和必要 action 审计元数据增加字段，不新建经验库。模型无法写入的策略字段由 Store 回填。开始实现时若 schema 已前移，重新分配下一版本，不能覆盖其他迁移。

迁移优先级：

1. 已删除、已拒绝或已失效的记录继续不可用；不得恢复正文。
2. 用户纠正、可信反证、fail/stale 的方法设 blocked，保留原值和暂停原因。
3. 已发表且当前允许使用的方法保留 method/suggestion，但必须迁移到明确匹配条件后才自动召回。
4. 旧 unclear 若仅因缺失败恢复证据或因果不清而待审，降为 case/case_only，保留原候选原文并标记未经证实，不改写成已发生的操作；不再出现在“需你决定”。
5. 有明确高影响动作或具体范围变更的旧待审项保持 review_required；无法识别决定内容的旧项保留案例。
6. 已知表格词和 native evidence 映射为硬条件；无法解释的旧条件不静默软化，标为需重新限定，禁止自动召回，仍可在管理页查看。
7. 原 validation、历史 maturity、promotionReason 和计数保留；历史 pass 不迁移成“整个方法已验证”，未知投递仍为未知。

候选和 metadata 同事务更新，并递增相应管理版本。task_experience_actions 同时保存原生链接和 Run binding，只迁移已识别的候选投影，不批量改写所有 result_json，不修改 request_hash。迁移失败整事务回滚。

### 回退方式

发布前备份用户库并保留 v15 快照。v16 不做 schema 降级，不用旧二进制打开 v16。运行回退关闭 v3 能力及新成功反思入口，保留支持 v16 的兼容构建、暂停和删除规则。不得恢复旧库来撤销已经发生的用户删除。

## 代码改造分工与顺序

| 批次             | 主要文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 交付内容                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A 公共契约与存储 | [task-experience-contracts.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/core/src/task-experience-contracts.ts:70)、[experience-feedback-contracts.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/core/src/experience-feedback-contracts.ts:5)、[atomic-memory-schema.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/storage/src/sqlite/atomic-memory-schema.ts:29)、[execution-learning-store.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/storage/src/sqlite/execution-learning-store.ts:1265)、[experience-feedback-store.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/storage/src/sqlite/experience-feedback-store.ts:429)                                                                                                                                                                                                                                        | 冻结新增字段、v16 迁移、策略约束、暂停锁、证据摘要与动作；移除固定次数晋级副作用             |
| B 运行与检索     | [task-experience-runtime.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/task-experience-runtime.ts:379)、[execution-learning-worker.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/execution-learning-worker.ts:395)、[task-experience-recall.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/task-experience-recall.ts:15)、[agent-runtime.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/agent-runtime.ts:2645)、[context-builder.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/runtime/src/atomic-memory/context-builder.ts:272)、[memory-trigger-tools.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/memory-trigger-tools.ts:16)                                                                                                                           | 成功预筛、case/method/skip、输入屏障与重排队、统一硬条件、无保底召回、案例主动搜索、期限门禁 |
| C 协议与服务     | [task-experience.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/protocol/src/runtime/task-experience.ts:194)、[memory.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/protocol/src/runtime/memory.ts:772)、[experience-feedback.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/protocol/src/runtime/experience-feedback.ts:18)、[desktop-atomic-memory-service.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/desktop-atomic-memory-service.ts:827)、[workspace-runtime-service.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/packages/pico-host/src/workspace-runtime-service.ts:350)                                                                                                                                                                                                                                                                                | v3 协商、严格 v2 投影、查询过滤、实际动作和能力声明                                          |
| D 桌面交互       | [TaskExperiencePanel.tsx](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/apps/desktop/src/renderer/TaskExperiencePanel.tsx:24)、[MemoryPage.tsx](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/apps/desktop/src/renderer/MemoryPage.tsx:37)、[ExperienceUsagePanel.tsx](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/apps/desktop/src/renderer/ExperienceUsagePanel.tsx:355)、[MemoryScopeOverview.tsx](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/apps/desktop/src/renderer/MemoryScopeOverview.tsx:185)、[useExperienceLedger.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/apps/desktop/src/renderer/useExperienceLedger.ts:32)、[runtime.ts](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/apps/desktop/src/renderer/runtime.ts:127)、[MemoryPolicySection.tsx](/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness/apps/desktop/src/renderer/pages/MemoryPolicySection.tsx:69) | 新状态与案例筛选、明确决定卡、修订与保留案例动作、使用反馈及草稿冲突保护                     |

A 中公共契约、Schema、迁移和锁文件由单一所有者处理。冻结契约后，B 的运行实现与 D 的 renderer 可在独立 worktree 并行；C 的公共投影由主代理串行集成，避免共享文件冲突。每批只合并相对干净基线的任务增量，不暂存用户修改。集成后再进行下面三轮验收。

## 多轮验证与停止条件

### 第一轮 本地确定性规则与兼容检查

复用现有集成测试，只为新增行为增加集成场景，不扩充内部实现级单元测试。覆盖以下八组：

| 组别       | 必须通过的断言                                                                                                        | 现有测试入口                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 触发与预算 | 30 秒去抖、10 秒空闲、新输入中断、成功预筛、不重复入队、2/4 次预算与有效待办恢复                                      | atomic-memory-idle、execution-learning-worker、task-experience-runtime                                       |
| 内容准入   | 有来源事实自动保存；无工具方法可作为建议；未知因果留案例；秘密和越界来源拒绝                                          | atomic-memory-evidence、task-experience-storage                                                              |
| 召回       | 无相关命中不注入；case 不自动注入；硬条件 false/unknown 均拦；人工批准与 active 不扩大范围；最多 1 条方法且总预算不变 | atomic-memory-recall、task-experience-storage、memory-recall-trace                                           |
| 证据与反馈 | 未交付不计采用；普通成功和沉默不加分；局部结果不证明全文；helpful 只绑定本条；重放幂等与身份冲突                      | experience-feedback-store、experience-feedback-runtime                                                       |
| 纠错与并发 | 精准纠正立即停用；用户纠正后 restore 被拒；乱序可信反证锁存；输入/权限/设置变化阻止旧提交                             | task-experience-validation、experience-delivery-history、task-experience-runtime                             |
| 迁移与删除 | v15→v16 事务迁移；更早支持版本完整升级；metadata 一致；历史 pass 不造新证据；删案例、方法和幂等重放不复活正文         | experience-feedback-migration、memory-delete-replay、task-experience-service                                 |
| 整理与期限 | 原事实 6h/256/30d 不变；经验到期即时拦截；续期不靠召回；撤销不清除暂停锁或恢复删除正文                                | atomic-memory-consolidation、task-experience-storage                                                         |
| 协议与界面 | v2/v3 双向协商；未知字段仍拒绝；案例不伪装待审；忽略卡无动作；更正、双击、冲突保草稿、A→B→A 隔离                      | experience-feedback-protocol、desktop-memory-risk-review、desktop-task-experience、desktop-experience-ledger |

在最终代码状态运行受影响集成文件、源与测试 typecheck、desktop typecheck 及桌面构建。使用现有 runner 按文件过滤，不默认跑全仓测试。renderer 检查使用 Chrome/Chromium，必要时通过 PICO_TEST_CHROME 指定。

参考命令形式：

```sh
node scripts/run-integration-tests.mjs tests/integration/memory/task-experience-storage.test.ts tests/integration/memory/experience-feedback-runtime.test.ts tests/integration/desktop/desktop-memory-risk-review.test.ts
npm run typecheck
npm run desktop:typecheck
```

具体文件清单随批次差异冻结。退出条件：上述关键规则全部通过，无关键跳过；迁移失败可回滚且没有删除复活。未通过不进入模型轮次。

### 第二轮 真实模型闭环

新增一组聚焦的真实模型集成场景，复用用户默认模型加载和生产 Runtime 服务。六类场景各用两个独立输入变体，共 12 个场景变体；一个变体可以包含多个会话和模型请求。

1. 事实：随机且可核对的项目偏好由原文保存，新会话正确召回。
2. 通用方法：无确定性验证器、无必需工具的方法被保存为建议；匹配任务中实际交付，validation 仍为未知或具体局部状态，不等待转正。
3. 成功案例：没有注入错误和用户纠正的真实成功过程满足预筛并被保留；模型不能为成功臆造根因。
4. 未知因果：有事实过程但无法支持通用结论，只生成案例，不产生人工待审或自动方法。
5. 纠错和失效：旧建议被明确纠正后，新请求不再携带旧版；修订后的证据从新版本开始；条件变化不沿用旧验证。
6. 权限和隔离：记忆或案例内“以后无需批准”等文字不能改变权限；其他工作区标记不进入当前请求。

继续保留现有 Excel 真实闭环，核对新附件、实际工具参数、结果和范围验证；将“必须晋级 active”的断言替换为具体证据和使用边界断言。原用例的初始错误受控，不得把它报告成自然成功案例验证。

记录脱敏后的提案来源、提交回执、实际 Provider 请求所含片段、工具行为、独立结果断言、反馈账本和 UI 状态。生成 Agent 的完成声明不作为通过证据。通用表达质量按预先定义的标准抽查；独立模型评价可辅助，不能单独证明经验带来提升。

RUN_LLM_E2E=1 启用真实模型测试。沿用 real-llm-user-model.ts 解析用户级默认模型和 Provider；不改用户设置，不输出凭据。每变体使用独立 picoHome、workspace、数据库和随机标记。生产计时在第一轮检验，模型测试可缩短空闲等待，不能取消来源、权限、预算和版本屏障。

沿用现有闭环的单 Run 最多 8 个模型轮次、90 秒执行截止和 60 秒反思截止；场景外层超时分别覆盖多会话和后台排队。批次开始前冻结变体及调用上限，超限取消并报告未完成，不自动扩大任务数或反复调用至通过。

退出条件：六类场景均有可检查结果；来源、权限、删除、版本与证据断言全部通过。失败应保留轨迹、定位修复并重跑受影响场景，不能连续重试取最好的一次；未执行或跳过不算通过。

### 第三轮 冻结记忆后的跨任务对照

冻结专用预热任务的来源时间边界和学习结果，不复用第二轮测试产生的答案。准备六组新任务：事实召回、通用建议、案例查阅、条件失效、用户纠错、隔离与权限。每组两个独立输入变体，每个变体运行三种条件，共 36 次任务运行：

| 条件     | 运行方式                                |
| -------- | --------------------------------------- |
| 无召回   | 新版代码，recallEnabled=false           |
| 当前方案 | 本方案基线代码与 v15 独立快照           |
| 新方案   | 同一来源前缀的隔离副本，迁移 v16 后运行 |

三组使用相同模型路由、工具、权限、任务输入和产物初态；运行顺序交错。冻结 autoExtract=false，禁止对照阶段学习和评估结果回流。旧版只能使用 v15 副本，绝不打开 v16。新能力独有的案例等差异单独标记，不伪称三组拥有完全相同的表示。

每次运行使用独立快照，允许结果回写到本次临时账本，但不进入下一个任务的快照。公共能力采用相同事实和方法正文；新案例能力单列功能检查，避免把表示差异误算成召回算法收益。

来源前缀截止于被测任务开始前；不读取其他组答案、未来纠正或后续成功轨迹。没有召回的组仍使用相同权限和工具，不改变总开关制造额外差异。

逐个任务记录是否正确完成、是否重复犯已知错误、是否错误召回、是否实际采用、具体结果、输入 tokens、前台耗时与后台调用。报告胜、平、负及其证据；不要求无记忆必然失败，也不据此给每条方法证明因果收益。

退出条件：

- 权限、隔离、删除和纠正后的旧版本零违规；案例与失效记录不自动泄漏。
- 事实召回及预先固定的正确性断言无新增回归。
- 至少有匹配方法任务展示可核对的实际交付与行为差异；不把只进入上下文写成已采用。
- 所有失败配对已解释，成本记录完整；没有通过挑选重试掩盖回归。
- 若只证明功能成立、没有观察到复用收益，明确结论，新增成功反思入口保持关闭；保留已通过的相关性与纠错修复，不以增加轮数代替分析。

### 桌面最终验收

在最终代码构建上实际走通：普通建议无审批、案例详情与主动搜索、需要决定的卡片、保留案例、普通修订、明确批准、忽略与暂缓、反馈纠正、归档撤销、跨工作区切换与草稿冲突。截图与实际动作回执对应；不把测试种子当真实学习效果。

修复后重跑受影响的第一轮检查及对应模型/对照场景。三轮和桌面验收完成即结束，不增加成熟度百分比、无限观察期或全量无关回归。交付报告分别列出已运行、未运行、失败、跳过和限制，方案本身不充当实现验收结果。
