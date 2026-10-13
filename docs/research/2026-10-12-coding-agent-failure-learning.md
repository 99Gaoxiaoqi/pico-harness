# Coding Agent 失败经验沉淀机制与工程成熟度调研

围绕失败经验沉淀，优先深入研究 Letta Code 的整体架构、Augment Cosmos 的代码审查学习，以及 Devin 的经验生命周期。Letta Code 将记忆、后台整理、技能生成和评测连接起来；Augment 在审查场景中明确区分反馈强弱，并按仓库和修改路径复用经验；Devin 对来源、并发写入和陈旧内容维护的设计描述较完整。Claude Code 和 Codex 则提供了值得借鉴的失败信号、运行控制和观测接口。

这些判断评价的是截至 2026 年 10 月 12 日公开可核实的机制及可维护性。它们不构成多产品在同一任务、模型和权限下的效果排名。尤其 Devin Memory and Dreaming 在 10 月 5 日才发布，设计完整度不能直接代表长期生产稳定性。[Devin 发布说明](https://devin.ai/blog/memory-and-dreaming)

## 判断标准

失败恢复、经验记忆和技能晋升有不同验收目标：失败恢复让当前任务继续；经验记忆让下一次相似任务改变行动；技能晋升把经过验证、可重复的流程变成正式能力。存下错误日志、恢复聊天记录或运行成功一次，都不能单独证明后两项成立。

| 工程维度   | 应当回答的问题                                                   |
| ---------- | ---------------------------------------------------------------- |
| 失败信号   | 来自工具退出码、测试断言、验收拒绝、用户纠正，还是模型自己的判断 |
| 经验提炼   | 是否形成具体行为建议，能否限定根因和适用条件                     |
| 来源与范围 | 能否回到原始证据，能否区分个人、仓库、组织与任务状态             |
| 准入与验证 | 谁确认教训，未经确认的候选能否影响后续任务                       |
| 召回       | 在会话开始、规划或相关工具调用前出现，还是依赖模型偶然搜索       |
| 写入可靠性 | 如何处理重复提交、并发修改、版本冲突和中断                       |
| 修订与退出 | 能否更正、恢复、去重、处理反例及过时经验                         |
| 效果验证   | 是否证明经验被采用并改善结果，而不只是记录写入或读取成功         |

本文以“产品原生机制”“需要配置的扩展接口”“人工维护流程”区分能力。表中的未定义事项表示公开资料不足，不等于产品内部一定没有实现。

## 产品对照

| 产品或项目       | 已确认的主要机制                                                 | 工程判断及适用边界                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Letta Code       | 持久记忆、后台 dreaming、Git 版本、经验转技能、学习实验          | 整体经验架构最值得深挖，验证晋升仍需额外流程。[Memory](https://docs.letta.com/configuration/memory)、[Skill Learning](https://www.letta.com/blog/skill-learning/)                       |
| Augment Cosmos   | 审查反馈采集、强弱信号提炼、原始证据与指导分层、按仓库及路径加载 | 审查学习场景的闭环较具体，不能外推到所有编码行为。[Code Review Memory](https://docs.augmentcode.com/cosmos/experts-code-review-memory)                                                  |
| Devin            | 自动经验笔记、来源会话、独立 checkout、陈旧写入拒绝、每日整理    | 通用经验生命周期设计完整，功能发布较新。[Memory](https://docs.devin.ai/product-guides/memory)                                                                                           |
| Claude Code      | 自动反馈记忆、项目规则、持久子代理记忆、失败 Hooks               | 反馈复用和执行接入可控，主会话记忆不自动保存所有调试修复。[Memory](https://code.claude.com/docs/en/memory)、[Hooks](https://code.claude.com/docs/en/hooks)                              |
| Codex            | 后台提取与整理、跨会话召回、候选与配额控制、记忆观测             | 记忆运行管理较完整，官方资料未定义专门的失败教训晋升流水线。[OpenAI Docs](https://learn.chatgpt.com/docs/customization/memories)                                                        |
| Cursor           | Git 项目规则、团队规则、Projects 共享知识文件                    | 人工规则治理清楚，Projects 的失败专用学习协议未定义。[Rules](https://cursor.com/docs/rules)、[Projects](https://cursor.com/docs/agent/projects)                                         |
| Windsurf Cascade | 本地工作区自动记忆、按相关性召回、分域规则                       | 个人便利记忆，团队可靠复用主要依赖规则。[现行官方入口](https://docs.windsurf.com/windsurf/cascade/memories)                                                                             |
| OpenHands SDK    | 可选用户与项目记忆、索引注入、模型维护文件                       | 适合学习简化接入，文件维护主要由提示驱动。[Persistent Memory](https://docs.openhands.dev/sdk/guides/persistent-memory)                                                                  |
| Cline            | Memory Bank 文档方法、规则驱动读取和更新                         | 可保存项目经验，但不是独立的自动失败学习服务。[Memory Bank](https://docs.cline.bot/best-practices/memory-bank)                                                                          |
| Roo Code         | 全局与模式规则、命令结果反馈、本轮完成门禁                       | 执行反馈和规则组织有实现，长期经验主要靠文件扩展。[执行工具](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/tools/ExecuteCommandTool.ts) |
| Aider            | 编辑后 lint、测试失败反馈、当前任务修复                          | 外部验证明确，跨任务教训沉淀需另建流程。[Linting and testing](https://aider.chat/docs/usage/lint-test.html)                                                                             |

## Letta Code 的整体经验架构

Letta Code 围绕长期存在的 Agent 组织工作。2025 年 12 月的产品说明已将用户反馈、代码理解和命令执行结果列为学习材料；当前记忆文档提供自动更新、显式 `/remember`、后台 dreaming 和记忆整理入口。[产品说明](https://www.letta.com/blog/letta-code/)、[当前记忆文档](https://docs.letta.com/configuration/memory)

它的存储层 MemFS 是 Agent 所有的 Git 仓库。根目录材料常驻上下文，子目录通过索引按需读取；每次编辑提交形成历史，后台记忆代理用 worktree 并发工作。云端备份与纯本地保存有不同同步、备份责任。默认 MemFS 不含向量索引，常规文件搜索也是正式读取路径。[MemFS](https://docs.letta.com/concepts/memfs)

Dreaming 可在指定完成步数或上下文压缩时触发。可选择第二个后台对话审阅、修订候选更新，但该选择属于 Agent 审阅，不是人工批准。大的重组会先备份记忆仓库。[Memory and dreaming](https://docs.letta.com/configuration/memory)

技能是独立的程序性经验载体。当前支持项目、机器和 Agent 作用域；Agent 自有技能随 MemFS 保存、迁移。经验转技能已有产品入口，但应以当前文档为准：当前文档引导通过内置 skill creator 创建，不能把旧研究中的 `/skill` 命令当作稳定的现行接口。[Skills](https://docs.letta.com/configuration/skills)

其优势是从保存到复用、维护、评估的接口能连起来；不足是 Git 提交与模型二次审阅都不能证明教训正确。公开资料没有说明每条新教训或技能默认必须通过独立重跑才会生效。更适合借鉴它的职责分工和版本机制，同时为高风险经验增加明确验证条件。

当前 README 还有两个部署边界：原生 Windows 的客户端自动反思默认关闭；旧 AgentFile 导入导出已移除。旧博客描述的 `.af` 评测接入不能直接作为当前操作步骤。[当前代码仓库](https://github.com/letta-ai/letta-code)

## Augment Cosmos 的审查反馈学习

Code Review Memory Manager 在变更合并后采集人类评论、对 Agent 发现的反应、已落实修改请求与变更结果，滤掉流程噪音。明确人类反馈权重大于反应和推断结果：强反馈可直接沉淀，弱信号需重复；后续审查按仓库和修改路径加载指导。这种设计特别适合降低重复误报和学习团队反模式。[审查记忆文档](https://docs.augmentcode.com/cosmos/experts-code-review-memory)

通用 Expert Memory 进一步区分明确反馈直接保存与弱信号先积累证据两种准入；加载后如果当前事实与旧经验冲突，应指出差异。后台审查学习没有公开逐条人工批准、反例计数或自动撤销规则的完整算法。[Expert Memory](https://docs.augmentcode.com/cosmos/experts-memory)

文件层保留写入 Agent、不可变版本和删除标记，支持恢复；历史版本逐步抽稀。它解决的是文件可靠性，不能等同于根据经验实际效果淘汰内容。组织 VFS 对组织成员共享，因此按仓库命名或召回不等于继承仓库访问权限。[Files](https://docs.augmentcode.com/cosmos/understanding-files)、[GitHub 连接范围](https://docs.augmentcode.com/cosmos/connectors/config-github)

Augment IDE 的 Memory Review 是另一套准入交互：Agent 提交候选，用户可批准、编辑或丢弃。不能把这条交互的逐条批准推导到 Cosmos 后台审查学习。[Memory Review](https://www.augmentcode.com/blog/how-we-built-memory-review)

工程博客至少在 2026 年 5 月 6 日已公开描述审查学习，当时 Cosmos 为 public preview。博客中的生产改进涉及整个审查流程，没有将记忆组件单独开关比较。合并本身也只是弱结果信号，不应被解释成每一条审查意见都正确。[Cosmos 工程博客](https://www.augmentcode.com/blog/solving-code-review-with-cosmos)

最值得 Pico 借鉴的是原始证据与简短教训分层、根据反馈强弱决定准入，以及把经验绑定到下一次具体工作入口。

## Devin 的经验生命周期

Devin 自动保存纠正后的规则、环境坑点和可复用经验，每条链接来源会话。个人记忆限制在用户所在组织内，不与同事共享；自动化启动的会话不读写个人记忆。每个会话先读索引，其余按需查询。[Memory](https://docs.devin.ai/product-guides/memory)

各会话使用独立 Git checkout，提交时合并其他会话更新，并以 revision check 拒绝陈旧写入。约每日运行的 Dreaming 去重、删除临时或未使用的陈旧材料、补录遗漏教训。这里的未使用是维护线索，不能直接代表经验已被证明无效。[发布说明](https://devin.ai/blog/memory-and-dreaming)

可复用流程通过 Skills 另行沉淀。Devin 可以在测试或了解环境后提出技能更新，展示内容并让用户创建 PR。这条可审查路径不代表所有自动 Memory 都经过同样审核。[Skills](https://docs.devin.ai/product-guides/skills)

CLI 提供工具结果成功标志和错误输出，可接失败采集与验证。但插件 Hooks 当前限于 CLI 和 Desktop，文档明确它们为 best effort 并可能 fail open；高风险底线仍需宿主确定性校验。[Lifecycle Hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)、[Plugin 限制](https://docs.devin.ai/cli/extensibility/plugins/overview)

公开 Agent Memory Repo 是格式规范与配套 skill，不是 Devin 原生并发、后台整理引擎。配套 skill 不安装定时任务或自动启动 Hook；脏仓库或无法快进拉取时会停止。采用其 Markdown 格式不能自动获得原生产品的写入协议。[规范固定版本](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/SPEC.md)、[配套 skill 固定版本](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/skills/agent-memory-repo/SKILL.md)

最值得借鉴的是简短经验与来源绑定、读取索引后按需展开，以及有明确陈旧写入检测的后台维护。这个功能刚上线一周，仍需要长期效果数据。

## Claude Code 与 Codex 的可控接入

Claude Code 主会话 auto memory 明确保存 feedback，包括用户纠正与确认的方法；也明确跳过能从代码重新推导的调试修复。它是本地仓库记忆，同仓库 worktree 共享，索引启动加载、主题按需读取。公开文档没有定义共享目录的完整冲突合并协议。[Auto memory](https://code.claude.com/docs/en/memory)

可配置子代理另有持久记忆范围，可记录 recurring issues 和 debugging insights。因此要分别判断主会话的默认取舍与子代理可配置能力。[子代理持久记忆](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory)

`PostToolUseFailure` 提供工具、输入与错误，但验证拒绝、权限拒绝不都经过该事件。可用 Hooks 采集候选和接入验证，使用 PreToolUse 做执行门禁；单纯写入 `CLAUDE.md` 或自动记忆仍属于模型上下文。[Hooks](https://code.claude.com/docs/en/hooks)、[Hooks Guide](https://code.claude.com/docs/en/hooks-guide)

Claude 的工具观测记录成功、耗时和错误，有助于构建失败率基线，却不会自动完成跨会话经验收益归因。[Monitoring](https://code.claude.com/docs/en/monitoring-usage)

Codex 开启本地 Memories 后，从符合条件的旧会话后台生成、整理记忆，跳过活跃或短暂会话，生成内容做秘密脱敏。官方要求必需团队规则仍放在 `AGENTS.md` 或版本库文档中。[OpenAI Docs Memories](https://learn.chatgpt.com/docs/customization/memories)

配置区分生成与读取，限制候选数量、历史年龄、闲置时间和配额，还能排除含外部工具上下文的会话。未使用天数控制整理资格，不宜直接表述成已证明无效的经验自动删除。[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

`turn.memory` 可观察读取准入、功能开关和引用使用。引用出现仍不能证明经验被正确采用。公开资料未定义失败分类、独立根因验证及经验晋升的专用协议。[观测配置](https://learn.chatgpt.com/docs/config-file/config-advanced)

这两类产品对 Pico 的启发是让采集、生成、读取分别可控，给失败和召回保留可观察身份，再由确定性工具校验承担必须执行的约束。

## 其他 IDE 与开源路线

### Cursor

现行 Rules 建议在重复犯错时增加具体规则，支持 Git 项目规则、管理员 Team Rules，以及常驻、相关性、路径匹配和手动加载。这是一条容易审查、共享、修订的人工经验路径。[Rules](https://cursor.com/docs/rules)

Projects 在 2026 年 9 月 10 日以 beta 发布，可在云端和本地 Agent 间同步所学知识文件。它证明共享长期知识，但现行文档没有定义失败候选、证据和反例治理协议。[发布记录](https://cursor.com/changelog/projects)、[Projects](https://cursor.com/docs/agent/projects)

旧 Memories 在 2025 年 1.2 版本曾增加后台生成后的用户批准；当前旧文档地址重定向到 Rules，后续官方支持回复对移除范围表述也不一致。不能用旧 GA 记录证明当前完整保留同一功能。[历史 1.2](https://cursor.com/changelog/1-2)、[2025 年支持回复](https://forum.cursor.com/t/memories-not-showing/143820/2)、[2026 年支持讨论](https://forum.cursor.com/t/memory-tool-dissapeared/148405)

### Windsurf Cascade

当前 Windsurf 官方入口重定向 Devin Desktop。Cascade 自动记忆是当前机器与工作区的本地内容，由模型判断相关性后召回；团队可靠复用主要依赖规则和 `AGENTS.md`。这条便利记忆未公开失败专用标签、来源协议或效用淘汰机制。[当前 Cascade 文档](https://docs.devin.ai/desktop/cascade/memories)

### OpenHands SDK

SDK 现行 Persistent Memory 默认为关闭，开启后从用户与项目两层读取索引，并提示 Agent 记录根因、环境问题等长期材料。只自动注入小索引，详细日记按需读；内容标记为未经验证、低信任，并受整体字符预算约束。[Persistent Memory](https://docs.openhands.dev/sdk/guides/persistent-memory)

它适合学习简单透明的文件接入，但模型被提示维护文件与程序保证经验学习成立，是两件事。失败专用证据抽取、确认状态和行为收益回写仍需补齐。

在 SDK 固定版本中，loader 实现读取、预算与整行截断，MemorySection 提示模型记录经验、去重和清理。后者不是独立的失败事件处理程序或写入事务。另一个 `agent-memory` skill 会逐项请求确认并写入 `AGENTS.md`，还明确排除 issue 特定错误及修复；不能将它与 SDK Persistent Memory 混成一套自动失败学习服务。[固定版本 loader](https://github.com/OpenHands/software-agent-sdk/blob/3934349da2db0433238621542173a00a8af7439c/openhands-sdk/openhands/sdk/context/memory.py)、[固定版本提示](https://github.com/OpenHands/software-agent-sdk/blob/3934349da2db0433238621542173a00a8af7439c/openhands-sdk/openhands/sdk/context/prompts/sections/static.py)、[独立 agent-memory skill](https://github.com/OpenHands/extensions/blob/main/skills/agent-memory/SKILL.md)

旧 OpenHands 的 trajectory replay 依次重放旧动作，甚至绕过 `agent.step()`；它与提炼教训、在新任务中选择性复用经验不同。[旧版 ReplayManager](https://github.com/OpenHands/legacy/blob/0.39.0/openhands/controller/replay.py)

### Cline

官方 Memory Bank 是结构化项目文档方法：将自定义指令加入 Rules，让 Agent 读取并更新项目背景、模式、当前工作和进度等 Markdown 文件。它能保留学到的经验，但不是独立的失败提炼、审查和生命周期服务。[Memory Bank](https://docs.cline.bot/best-practices/memory-bank)

VS Code 的规则接入已有全局和项目发现、启用开关及按文件路径激活。新版 SDK 也有配置发现、规则注册，但其已核对渲染入口与 VS Code 条件评估不同，不能直接推导两者所有端到端行为相同。它们验证的是规则装载，不是经验真伪。[VS Code 条件评估](https://github.com/cline/cline/blob/c3a40572765b76873c597247941118c1778d02c8/apps/vscode/src/core/context/instructions/user-instructions/rule-conditionals.ts)、[SDK 规则渲染](https://github.com/cline/cline/blob/c3a40572765b76873c597247941118c1778d02c8/sdk/packages/core/src/runtime/safety/rules.ts)

### Roo Code

源码按全局、模式、AGENTS 和项目来源组织指令，并可选加载子目录规则。命令执行保留实际退出状态；状态未知时明确报告未知，completion 对本轮工具失败有门禁。这些是规则组织和当前执行约束，尚不能证明经验被提炼并通过晋升验收。[规则入口](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/prompts/sections/custom-instructions.ts)、[执行工具](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/tools/ExecuteCommandTool.ts)、[完成工具](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/tools/AttemptCompletionTool.ts)

### Aider

Aider 的工程价值是把 lint、编译或测试的非零退出码直接反馈给当前修复过程。它解决本次改动的外部验收；跨会话失败经验库不是这条流程的组成部分。[Linting and testing](https://aider.chat/docs/usage/lint-test.html)

源码中的 reflection 在每个新用户消息时重置，默认上限为三轮，传入的是失败输出。跨会话约定通过用户维护的只读 conventions 文件装载，不应把该修复循环称为长期教训蒸馏。[固定版本修复循环](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py)、[Conventions](https://aider.chat/docs/usage/conventions.html)

## 学习效果的证据

Letta 的 2025 年 Skill Learning 实验使用 Sonnet 4.5 和 Terminal Bench 2.0 的 89 项任务。文章报告：仅轨迹学习提高 9 个百分点；加入 verifier logs 后共提高 15.7 个百分点，相对基线提高 36.8%。百分比与百分点不能混用。[实验原文](https://www.letta.com/blog/skill-learning/)

按文章描述，技能来自基线任务轨迹，然后在同一任务集合评估。这个结果支持重复任务中轨迹和外部反馈有用，不能证明对未见任务普遍泛化，也不能用来排名其他 Coding Agent。实验有测试反馈，也不代表产品中的每个新技能默认经过同样验收。

Recovery Bench 则提醒：把失败后的环境和历史直接交给后续 Agent，可能降低恢复表现。其特定任务、模型设置下，完整动作历史效果最差；这支持保留可回查证据并提炼必要经验，不能推出所有错误上下文都应删除。[Recovery Bench](https://www.letta.com/blog/recovery-bench/)

2026 年的 Context Bench V2 将记忆生成拆为泛化和维护，将使用拆为检索和遵循。它基于生产记忆结构构造任务，但属于私有基准，并使用模型裁判；不能视为独立公开的跨产品长期稳定性证据。[Production Agent Memory Evaluation](https://www.letta.com/blog/evaluating-memory-in-production-agents/)

当前 Letta Evals 仓库提供数据集、CLI target、提取器、确定性或模型 grader、reward 和结果持久化；支持多轮、重复运行与记忆工作区配置。这是可借鉴的评测工具，仍需为具体经验设计合适任务。[当前 Evals 仓库](https://github.com/letta-ai/letta-evals)

## 学习触发时机和主流程延迟

当前任务的失败恢复要及时影响下一步行动，长期经验整理可以延后。已核实的实现同时存在主循环记笔记、任务后后台反思和单独训练三种方式；`async` 函数、后台任务名称或文档标题本身都不能证明调用者不用等待。

| 对象                            | 触发与调度                                                                       | 主任务是否等待                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex 本地记忆                  | 启用后筛选空闲历史会话，后台提取和全局整理，跳过活跃或短会话；低配额时可跳过     | 记忆生成不放在当前回答必经路径。[OpenAI Docs](https://learn.chatgpt.com/docs/customization/memories)                                                                                                                                                                                                               |
| Letta Code dreaming             | 完成指定步数或上下文压缩后启动后台子代理；可增加第二个后台会话复核               | dreaming 不等待主任务；普通显式记忆编辑仍是另一条路径。[Memory and dreaming](https://docs.letta.com/configuration/memory)                                                                                                                                                                                          |
| Devin                           | 工作中自主保存短笔记；约每日后台 dreaming 补录、去重和整理                       | dreaming 后台运行；普通记笔记不应被外推为全程零等待。[Memory](https://docs.devin.ai/product-guides/memory)                                                                                                                                                                                                         |
| Augment Cosmos 审查学习         | PR/MR 合并后，由后台 Memory Manager 采集审查反馈并整理；未来审查按仓库和路径加载 | 发生在已完成变更之后。[Code Review Memory](https://docs.augmentcode.com/cosmos/experts-code-review-memory)                                                                                                                                                                                                         |
| Claude Code auto memory         | 主 Agent 在会话中判断哪些用户反馈、偏好和外部事实值得保存，读写普通文件          | 官方没有承诺这条写入异步；不会每次工具失败都触发，并跳过可从代码恢复的 debugging fixes。[Auto memory](https://code.claude.com/docs/en/memory#auto-memory)                                                                                                                                                          |
| OpenHands SDK Persistent Memory | 默认关闭；启用后装载索引，提示主 Agent 在任务接近结束时维护记忆                  | 通过主 Agent 的文件工具更新，没有专用后台失败学习队列。[Persistent Memory](https://docs.openhands.dev/sdk/guides/persistent-memory)、[维护提示](https://github.com/OpenHands/software-agent-sdk/blob/e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7/openhands-sdk/openhands/sdk/context/prompts/sections/static.py#L115) |
| AutoGen Teachability            | 主模型生成前 await 检索、提取用户建议并入库                                      | 增加本次回答等待；这是用户教学入口。[update_context](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-ext/src/autogen_ext/experimental/task_centric_memory/utils/teachability.py#L55)                                                                    |
| AutoGen Task-Centric Memory     | 显式调用训练入口，试做失败后生成建议，反复试做成功才保存                         | 参考示例 await 完整训练后才测试，后台调度需应用另行提供。[训练示例](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/samples/task_centric_memory/eval_self_teaching.py#L60)                                                                                               |
| Reflexion 编程参考实现          | 内部测试失败后生成反思，再生成代码并重试                                         | 反思串行进入当前修复循环；该路径每个数据集任务重建反思列表。[run_reflexion](https://github.com/noahshinn/reflexion/blob/218cf0ef1df84b05ce379dd4a8e47f17766733a0/programming_runs/reflexion.py#L26)                                                                                                                |
| LangMem ReflectionExecutor      | 应用 submit 会话快照，按 thread 延迟执行；后续输入可替换未开始的任务             | submit 返回 Future；若主路径等待该 Future，仍会等待反思。[延迟处理](https://langchain-ai.github.io/langmem/guides/delayed_processing/)                                                                                                                                                                             |

### 后台处理的可靠性边界

Codex 官方配置将候选筛选与预算分开：默认最少空闲 6 小时、每次启动最多处理 16 个会话候选，剩余额度门槛默认为 25%。这些是延迟、批量与配额控制，不是“学习已完成”的保证；Pico 不应直接照搬小时级参数。[Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)

Letta 的记忆子代理使用 Git worktree 隔离编辑，提交形成版本边界。Devin 的独立 checkout、revision check 与合并解决并发保存；用户还能看到 Updated memory 卡和 dreaming 的修改记录。这些机制处理写入与可见性，不证明经验因果正确。[MemFS](https://docs.letta.com/concepts/memfs)、[Devin 发布说明](https://devin.ai/blog/memory-and-dreaming)

Letta Code 的反思入口读取尚未处理的轨迹范围并保存 payload；结算函数只有在 success 为真时才推进已处理消息与步数。这个提交后推进的边界适合 Pico 复用，不能在仅启动后台工作时就视为已经学习。[快照入口](https://github.com/letta-ai/letta-code/blob/7a6c0ea2f8db6f00b4640611bbcb33864d958d1e/src/cli/helpers/reflection-transcript.ts#L1644)、[成功后推进](https://github.com/letta-ai/letta-code/blob/7a6c0ea2f8db6f00b4640611bbcb33864d958d1e/src/cli/helpers/reflection-transcript.ts#L1870)

LangMem 的延迟处理支持防抖，生产环境需要持久 Store。官方 Background Quickstart 的基础例子仍在返回回答前 `await memory_manager.ainvoke(...)`；要解除这段等待，必须采用真正的 executor 调度，而不是仅给函数加 async。Serverless 生命周期短，官方建议使用远程 executor；存储持久化也不能替代任务调度持久化。[Background Quickstart](https://langchain-ai.github.io/langmem/background_quickstart/)、[延迟处理](https://langchain-ai.github.io/langmem/guides/delayed_processing/)

固定源码中，本地 executor 的队列在进程内，旧任务取消标记只在调用 reflector 前检查；提交方须提供稳定的完整快照，不能假设 executor 自动积累历史或中止已开始的写入。远程 submit 的 Future 只代表 `runs.create` 请求返回，不代表反思或存储成功；确认完成需要远程运行状态。它提供调度组件，经验准入、轨迹级幂等及版本提交协议仍由应用定义。[本地与远程 executor](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/reflection.py)

Hooks 是触发接口，尚不是经验学习服务。Claude 的 command hook 配置 `async:true` 后可以继续主任务，完成结果通常在下一轮交付；`-p` 退出清理可能终止未完成进程。Codex 也提供后台 command hooks，但 SessionEnd 始终同步，且会话结束会取消未完成后台 hooks。可靠沉淀需要先登记可恢复任务，不能只把长反思挂到退出钩子。[Claude async hooks](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)、[OpenAI Hooks](https://learn.chatgpt.com/docs/hooks)

### 验证次数不能统一解释

AutoGen TCM 的 `max_test_trials=3` 表示带建议重复尝试任务，任一次失败会结束本轮检查；当前参考 Grader 通过模型抽取答案并对比已知 expected_answer。它既不是三条 Bash 退出码，也不是多数投票。检索中的 `validate_insight` 则只判断建议是否可能有帮助，提示词要求不实际解题。[训练与试做](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-ext/src/autogen_ext/experimental/task_centric_memory/memory_controller.py#L315)、[Grader](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-ext/src/autogen_ext/experimental/task_centric_memory/utils/grader.py#L121)、[相关性筛选](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-ext/src/autogen_ext/experimental/task_centric_memory/_prompter.py#L228)

Augment 按反馈强弱分层：明确人类反馈可直接形成经验，弱反应及推断结果需要重复证据。由此可借鉴的准入设计是：用户明确纠正沿用用户证据路径；执行推导的经验要求可回查失败、修复和外部验收；泛化、因果不明或高风险经验保持候选并继续收集证据。同命令三次成功能检查执行稳定性，不能替代因果或跨任务泛化验收。[反馈分层](https://docs.augmentcode.com/cosmos/experts-code-review-memory)

## 对 Pico 的适配

Pico 已接入独立的 `memory_learn`：主 Agent 提出候选，Host 核验提案后的三次独立原生 Bash 成功并原子保存，随后由现有召回链路复用。候选与正式记忆隔离，工具调用同步且独占步骤；失败后没有强制反思触发，也没有后台失败学习 worker。常规用户证据提取仍坚持独立边界，工具观察和助手断言不能借此成为用户事实。[执行经验工具](../../packages/pico-host/src/execution-lesson-tool.ts)、[当前记忆架构](../architecture/14-workspace-memory.md)、[提取证据](../../packages/runtime/src/atomic-memory/extraction-evidence.ts)

下一步适合把供未来任务使用的反思移出主循环，并保留当前任务必要的诊断与修复。可以按以下职责组合各产品的经验：

| 职责         | 借鉴对象                                    | Pico 的实现取舍                                                        |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| 保存失败事实 | Augment 的原始证据层                        | 引用已有工具结果、测试输出与会话事件，避免复制一份执行状态             |
| 提炼候选     | Letta 的反思与技能生成                      | 明确症状、已核实原因、行为建议、适用条件，助手总结保持候选身份         |
| 确认经验     | Augment 的反馈强弱和候选交互                | 一次合并或一个赞不能当因果证明；高风险经验要求人工确认或可重复外部验收 |
| 并发与修订   | Devin 的 revision check 及 Letta 的版本边界 | 复用 Pico 版本与事务机制，记录更新来源，拒绝覆盖新的用户更正           |
| 入口召回     | Augment 的仓库及路径加载                    | 从具体工作区、任务族、工具和失败签名匹配，控制提醒预算                 |
| 效果评估     | Letta 的轨迹加反馈实验和 Evals              | 在固定模型、权限和验收下比较无记忆、原始失败历史、确认教训三种条件     |

Git-backed Markdown 有审查和可迁移优势，但没有证据要求 Pico 把现有 SQLite 记忆库改成 Git。更重要的是来源、版本、权限和提交边界；稳定流程需要团队共享时，再输出可审查的 Rules 或 Skill。

### Pico 的后台学习调度取舍

1. 原生命令完成后只登记事件身份和学习线索；由主 Agent 完成本任务必要的修复，前台不增加专门的长期反思模型轮次。
2. 正常 completed、安全 checkpoint 或空闲边界冻结事件范围和准入策略，登记持久任务；连续回合防抖合并，显式用户记住仍可同步处理。
3. 后台 worker 读取固定范围，提炼窄范围候选，核对已有外部验证；没有足够证据就保持候选，不自动重放命令或为了凑票制造执行。
4. 按工作区、Session、范围与策略代次固定幂等身份；通过事务与版本检查保存，失败可以恢复，用户更正、删除及关闭设置能阻止旧任务提交。
5. 保存后发布明确学习状态；未来任务记录召回、行动及结果，出现反例时标记待复核，避免仅统计“写入成功”。

这需要调整当前实现，不能简单去掉 await：`memory_learn` 的写入门禁绑定当前 live Run 和 Session 所有权，验证又要求派发与结果晚于候选提案。后台任务必须获得冻结范围的独立执行身份，且不能将提案前的旧检查冒充当前规则认可的验证。现有 `AtomicMemoryRuntime.completed/checkpoint` 已有后台提取、快照及恢复机制，可复用调度思路；进程内 session lane 并不持久化，失败经验的语义准入仍需单独实现。[当前同步门禁](../../packages/pico-host/src/execution-lesson-tool.ts)、[后台提取入口](../../packages/pico-host/src/atomic-memory-runtime.ts)、[进程内队列](../../packages/runtime/src/atomic-memory/session-lane.ts)

### 一条经验应该表达的信息

| 信息     | 示例含义                                               |
| -------- | ------------------------------------------------------ |
| 失败事实 | 某项目测试因错误工作目录没有加载所需配置               |
| 证据     | 失败命令、实际目录、错误输出，以及正确目录下的重跑结果 |
| 教训     | 该测试入口必须从指定项目目录运行                       |
| 适用条件 | 当前工作区、对应测试脚本及配置版本                     |
| 确认依据 | 可重复执行结果或用户明确纠正                           |
| 召回入口 | 计划运行该测试命令之前                                 |
| 修订条件 | 测试脚本或目录结构改变后重新确认                       |

该示例是验收设计，不是已经发生的 Pico 故障。不要把“调整了目录后测试通过”直接泛化为所有项目的运行规则。

### 最小验收

1. 新会话执行同类任务，在相关动作之前命中已确认经验，并按建议改变行动；以外部结果确认没有重犯。
2. 换到相邻但不同的工作区、工具或版本时，不错误套用该教训。
3. 用户更正或验证反例出现后，旧经验不再被当作有效建议；保留版本与证据以便检查原因。
4. 并发生成同一经验不会覆盖新更正或重复提交；中断后可区分候选、已保存与未保存。
5. 记忆不能授予权限或取消验证；能确定性阻止的失败应进入回归测试或工具检查。
6. 记录召回、实际采用、最终结果、重复失败及额外成本。少量样本适合确认链路，稳定收益需要更多任务族和多次重复。

## 课程对应

第 15 讲形成可信、可召回的失败教训，第 29 讲观察教训在复用中的真实作用，第 28 讲进一步将稳定、可执行、可验证的流程整理成技能。产品中的 memory、dreaming 和 skill creation 分别覆盖这条路线的部分职责，不能仅凭名称判断完整实现。[失败日记原文](/Users/anxuan/geektime-downloader/Agent设计模式之美/15｜失败日记：让Agent把摔过的跤变成本事.pdf)、[经验回放原文](/Users/anxuan/geektime-downloader/Agent设计模式之美/29｜经验回放：让经验在复用中持续校准.pdf)、[技能包原文](/Users/anxuan/geektime-downloader/Agent设计模式之美/28｜技能包：从成功轨迹到可验证能力.pdf)

## 时间与源码基准

| 对象                      | 可核实的时间或固定源码版本                 | 解释边界                                       |
| ------------------------- | ------------------------------------------ | ---------------------------------------------- |
| Letta Skill Learning      | 2025 年 12 月 2 日研究文章                 | 公开学习实验，不是现行命令参考                 |
| Letta Code                | 2025 年 12 月 16 日产品文章                | 当前操作以现行文档和 README 为准               |
| Augment Cosmos            | 2026 年 5 月 6 日工程博客，6 月 18 日更新  | 当时为 public preview，不能推导精确 GA 日期    |
| Cursor Projects           | 2026 年 9 月 10 日 beta 发布               | 较新功能，不能外推长期稳定性                   |
| Devin Memory and Dreaming | 2026 年 10 月 5 日发布                     | 截至调研日仅一周                               |
| OpenHands SDK             | `3934349da2db0433238621542173a00a8af7439c` | 核对记忆读取、提示和接入入口                   |
| Cline                     | `c3a40572765b76873c597247941118c1778d02c8` | 核对文档、VS Code 条件规则与 SDK 规则入口      |
| Roo Code                  | `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16` | 核对规则、执行与完成工具                       |
| Aider                     | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | 核对失败修复循环                               |
| Agent Memory Repo         | `8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e` | 开源规范与配套 skill，不是 Devin 内部引擎      |
| AutoGen 本轮调度核对      | `027ecf0a379bcc1d09956d46d12d44a3ad9cee14` | Teachability 的回答前等待及 TCM 的显式训练     |
| Reflexion 本轮调度核对    | `218cf0ef1df84b05ce379dd4a8e47f17766733a0` | 编程测试失败后的串行反思循环                   |
| OpenHands 本轮调度核对    | `e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7` | 持久记忆维护提示与 condenser 等待链            |
| LangMem 本轮调度核对      | `48e3c11f5bb527282c7d5339c6a87a0b35abccfc` | 本地与远程 ReflectionExecutor 的等待及生命周期 |
| Letta Code 本轮调度核对   | `7a6c0ea2f8db6f00b4640611bbcb33864d958d1e` | 轨迹范围冻结及成功后推进已处理位置             |

现行在线文档没有标明版本时，以 2026 年 10 月 12 日访问内容为基准。源码结论限于上述入口，不将一次局部检索当作对所有扩展的不存在证明。
