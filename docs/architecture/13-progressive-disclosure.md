# pico-harness 渐进式披露：让上下文窗口只装此刻需要的东西

> **[历史文档]** 工具披露部分已于 2026-08-18 被重构取代（surface 组级激活 +
> durable 重播 + TF-IDF），现状与动机见 `23-decision-tool-disclosure-surface.md`。
> 本文其余披露机制（Skill 二段式 / ToolResult 预览与 Evidence 回取 / Repo Map
> 渐进索引 / explore_repo 侦察）的描述仍然有效。

> 本文梳理 pico-harness 里所有"渐进式披露"(progressive disclosure)机制的统一设计与协作。核心不是"分了几套披露",而是同一个设计哲学的五种落地：**先给轻量摘要或入口,确有需要时再按需支付成本回取完整内容。**

---

## 一、为什么 Agent Harness 必须做渐进披露

大模型的上下文窗口是稀缺资源。一个 Agent 会话可能用到几十个工具、几十个 Skill、几百次工具调用,如果把它们的完整 schema、完整正文、完整输出全部预先塞进上下文,会出现三个问题:

1. **挤压有效工作区**——工具 schema 和历史 ToolResult 占满了 token,留给实际推理的空间所剩无几。
2. **注意力被稀释**——模型在海量无关工具和冗长输出里���找正确选项,命中率下降。
3. **成本浪费**——绝大多数工具、Skill、完整输出在本会话里根本用不到,预加载它们是纯开销。

pico 的应对是贯穿性的：**默认只暴露有界的摘要层,完整层按需获取,且摘要层永不丢失信息(回取成本是可接受的边际成本)。** 这套哲学落在五个地方,看起来各不相同,但骨架完全同构。

---

## 二、全景：五套渐进披露机制

| # | 机制 | 摘要层(默认暴露) | 完整层(按需获取) | 触发方式 |
|---|------|-----------------|-----------------|---------|
| 1 | 工具分层披露 | CORE_TOOLS 的 10 个 schema | 扩展工具 schema | 模型调 `search_tools` |
| 2 | Skill 二段式 | name + description(注入 prompt) | body 正文 | 模型调 `skill_view` |
| 3 | Tool Result 预览 | head-tail 摘要(≤1600 字符) | 完整原文(Evidence CAS) | 模型调 `read_evidence` |
| 4 | Repo Map 渐进索引 | 首批符号(按字母序) | 全仓符号 | 查询驱动续扫 |
| 5 | explore_repo 一次性侦察 | top-N 文件结构片段 | (本身即摘要,无完整层) | `max_files` 上限 |

下面逐个展开。每套机制都有一个共同结构：**摘要/入口工具 + 完整回取工具成对出现,中间靠一个"引用"连接。**

---

## 三、工具分层披露：核心组始终在场,扩展组按需激活

这是最直接的一套：控制模型每轮看到的工具 schema 集合。实现散在三个文件,各司其职。

### 分层判定

`tool-tiers.ts` 用一个 `Set` 查表把工具分成两组：

```text
CORE_TOOLS = { read_file, write_file, edit_file, bash,
               glob, grep, todo, ask_user,
               delegate_task, schedule_task }   ← 10 个,每轮始终暴露
其余一切 = 扩展组（MCP 动态工具、代码智能、网络等也归扩展）
```

判定函数 `getTier(name)`：在集合里是 `"core"`,否则 `"extended"`。

为什么这 10 个进核心组,文件注释给了理由：
- `todo` —— 状态外部化的核心,prompt 已注入 todo 状态,模型频繁同步
- `delegate_task` —— 主 Agent 的一级编排入口,藏在检索后面会导致多子代理请求不稳定
- 其余是基础文件/搜索/交互能力,移除任一都会让基本功能受损

### 状态机

`tool-disclosure.ts` 的 `ToolDisclosure` 维护一个内存集合 `disclosed: Set<string>`,唯一决策点是 `pickForLLM`：

```text
pickForLLM(allTools) = allTools.filter(
  t => getTier(t.name) === "core"     ← 核心组无条件通过
    || this.disclosed.has(t.name)     ← 或已被披露的扩展
)
```

配套方法：`disclose(names)` 把命中的扩展工具加入集合(核心工具会被自动忽略);`reset()` 新会话清空。

**关键安全网**：披露状态**完全不干预 `registry.execute` 的路由**。即使某扩展工具没披露,模型若误调,registry 仍按全集路由执行——只是该工具的 schema 没喂给模型而已。这是"软引导"而非"硬限制"。

### 元工具 search_tools

`search-tools.ts` 是模型激活扩展工具的唯一入口：
- 模型用关键词检索,`findMatchingTools` 对 `name + description` 做小写 `includes` 匹配
- 命中后调 `disclosure.disclose(...)`,**下一轮生效**
- 自动排除 `search_tools` 自身(它也是 extended,防自激活)
- 只读、不触碰资源(返回 `none()`),与一切工具不冲突
- 工具源是**实时数据源** `() => registry.getAvailableTools()`,所以 host 后续动态注册的委派/MCP 工具也立即可检索

### Loop 集成

`engine/loop.ts` 喂给 LLM 的最终公式：

```text
availableTools = pickForLLM(allTools) ∪ searchToolSchema(allTools)
                 ↑ 核心组 ∪ 已披露扩展     ↑ search_tools 自身始终附带
```

`searchToolSchema()` 专门保证：**只要启用了 disclosure,`search_tools` 元工具一定出现在每轮工具列表里**,否则模型无从激活扩展工具。

---

## 四、Skill 二段式：元数据进 prompt,正文按需读取

这是 Anthropic Agent Skills 规范(agentskills.io)的标准范式。`context/skill.ts` 文件头明确写着"渐进式暴露"。

### 启动时只加载元数据

每个 Skill 是一个 `SKILL.md`,以 YAML frontmatter 开头。`SkillLoader` 扫描时只解析 frontmatter 的 `name` 和 `description`,正文 `body` 不进上下文。元数据长度有上限(name 64、description 1024 字符),超长截断,"避免撑爆渐进式暴露清单"。

### 摘要注入 system prompt

`SkillLoader.loadAll()`(`context/composer.ts` 调用)只把摘要喂给 prompt：

```text
### 可用专业技能 (Agent Skills)
需要完整执行指南时,请调用 skill_view 工具按名称读取。

#### 技能名称: deploy
**触发条件**: <description 全文>
```

注意：**body 正文不进 system prompt**,只有 name + description。模型从这里判断"要不要用这个 Skill"。

### 按需读取正文

模型决定用某 Skill 时,调 `skill_view(name)` 才返回完整 body。`viewBody(name)` 是这条回取路径。代价是模型主动调一次工具,换来的是正文 token 只在真正需要时才支付。

---

## 五、Tool Result 预览与 Evidence 回读

这是对上下文体积影响最大的一套——工具输出往往是 Agent 上下文的最大贡献者。

### 触发阈值

`tool-result-observation.ts` 的核心判定：

```text
threshold = 2048 token
若 countTokens(modelOutput) <= 2048:
    shouldArchive = false
    投影 = { mode: "full", 原文直传 }
否则:
    shouldArchive = true
    完整原文写入 Evidence CAS(SHA-256 寻址)
    投影 = { mode: "preview", head-tail 摘要 }
```

也就是说,**超过 2048 token 的工具输出原文不进模型上下文**,而是落盘到 Evidence CAS,模型只收到一份有界预览 + 一个 `pico://evidence/<sha>` 引用。

### head-tail 摘要

`result-summarizer.ts` 的预览策略(默认 1600 字符)：
- 头部一半：保留开头(import、配置、命令开始)
- 尾部一半：保留结尾(exit code、错误摘要、测试结果)
- 中间：`...[omitted N chars]...`

文件头注释把设计意图说得很清楚：

> 预览不需要按工具类型做智能提取——head-tail 足够让模型了解大致内容,精确细节通过 read_evidence 按需获取。原文永不丢失(CAS 兜底 + 写失败时 inline 保留),所以"预览不够精确"的代价只是模型多一次 read_evidence 调用,是按需支付的边际成本。

### read_evidence 分页回读

模型需要完整或精确细节时,调 `read_evidence(ref, offsetBytes, limitBytes)` 按字节分页回读。它自带校验：manifest、内容哈希、blob 完整性三重验证,返回带 `truncated` 和 `nextOffsetBytes` 的分页指针。`read_evidence` 本身被特殊标记为 `BOUNDED_READBACK_TOOLS`,其输出走 bounded-readback 模式,不再二次归档,避免循环。

### 与工具披露的协同

`read_evidence` 是扩展组工具,默认不暴露。但当某次工具结果被归档为 Evidence 时,`engine/loop.ts:2798` 会**自动 disclose `read_evidence`**：

```text
// Evidence 预览会明确要求下一轮调用 read_evidence；同步披露其 schema，
// 避免渐进式工具列表让模型只能看到引用却无法执行回读。
this.toolDisclosure?.disclose(["read_evidence"]);
```

这是两套机制协同的关键点——预览给了引用,但回读工具是扩展组,不自动披露的话模型会看到引用却没工具执行回读。

---

## 六、Repo Map 渐进式索引

`code-intelligence/repo-map.ts` 的 `RepoMapService` 是一个**有状态的、跨调用累积的全仓库符号索引**。文件注释："无 LSP 时的确定性静态后端：按需分批索引,不在 TUI 启动时全仓扫描。"

### 纯内存,无持久化

三个核心字段都在内存里,不写文件、不写 JSONL、不写 SQLite：

```text
discoveredFiles: string[]        ← 全仓文件路径列表(惰性发现一次)
nextFileIndex: number            ← 字母序游标,跨调用保留
indexedFiles: Map<path, IndexedFile>  ← 索引主体,单调增长
```

`close()` 就是把三者清空。进程退出即归零。

### 越用越全的机制

索引不是预先全扫,而是**查询驱动、分批补建**,游标跨调用保留：

```text
discoveredFiles 排序后:[a.ts, b.ts, ... z.ts]   (假设 1500 个)
nextFileIndex = 0  ← 初始

第 1 次 scanNext(200):
  读取 [0..200],解析符号存入 indexedFiles
  nextFileIndex = 200
第 2 次 scanNext(200):
  从 [200] 续读到 [400]   ← 不重扫已索引文件
  nextFileIndex = 400
  ...
直到 nextFileIndex >= discoveredFiles.length → complete=true
```

不同查询方法触发不同补建策略：

| 查询方法 | 补建策略 | 停止条件 |
|---------|---------|---------|
| `definitions(word)` | `scanUntil(找到名为 word 的符号)` | 找到即停 |
| `symbols(query)` | `scanUntil(已收集够 limit 个)` | 够了即停 |
| `references(word)` | `scanNext(固定一批)` | 扫一批就在已索引文件里 grep |
| `repo_map` 工具 | `scanNext(max_files)` | 扫指定批次,返回 `complete` 进度 |

`repo_map` 工具输出明确告诉模型进度：`indexed=200/1500 complete=false limitReason=max_files`——模型看到 `complete=false` 知道还没扫完,可再调一次续建。

### 对外工具

Repo Map 服务背后挂了 6 个模型工具(`code-intelligence.ts`)：`repo_map`、`code_definition`、`code_references`、`code_symbols`、`code_diagnostics`、`code_call_hierarchy`。它们共享同一个累积索引,但每个有独立 schema 和查询语义。这 6 个都是扩展组工具,需经 `search_tools` 激活;Plan 模式白名单 `PLAN_PROVIDER_TOOL_NAMES` 包含它们(允许规划阶段只读调查)。

---

## 七、explore_repo 一次性侦察

`tools/explore-repo.ts` 是一个**无状态的、一次性的仓库侦察工具**,2026-08-06 新增,替代了被删除的重量级 Discovery 状态机(5700+ 行 → ~350 行)。

### 与 Repo Map 的关键区别

| 维度 | Repo Map | explore_repo |
|------|----------|--------------|
| 状态 | 有状态,索引跨调用累积 | 无状态,每次从头来 |
| 遍历 | 文件名字母序 | DFS 深度优先 |
| 输出 | 结构化符号/位置(JSON) | 人类可读报告(候选+证据锚点+片段) |
| 用途 | 精确查询("这个符号定义在哪") | 模糊探索("从哪开始理解这个仓库") |

explore_repo 复用 Repo Map 的 `parseSymbols()` 函数解析符号,但**不复用其索引**——它自己做 DFS 遍历(`collectFiles`),叠加项目结构启发式打分(`scoreStructure`:manifest +12、文档 +10、入口 +8、测试 +6),再做行级内容匹配,一次返回带证据锚点的阅读路径报告。

它本身就是个有界摘要工具：`max_files` 上限(默认 30,最大 80)、`MAX_TOTAL_BYTES = 2MB`、snippet 截断,不返回完整文件内容。预算控制让它在大型仓库上保持可预测的开销。

---

## 八、贯穿性的设计模式

把五套机制放一起,有一个统一的抽象：

```text
              ┌─ 摘要层(默认,轻量有界) ────┐   ┌─ 完整层(按需,付费) ──────┐
工具          │ CORE_TOOLS schema            │   │ 扩展工具 schema          │  search_tools
Skill         │ name + description           │   │ body 正文                │  skill_view
Tool Result   │ head-tail 预览 ≤1600 字符    │   │ 完整原文                 │  read_evidence
Repo Map      │ 首批符号(字母序游标)         │   │ 全仓符号                 │  查询驱动 scanUntil
explore_repo  │ top-N 文件结构片段           │   │ (本身即摘要,无完整层)    │  max_files=30
```

### 三条核心原则

**1. 摘要层永不丢失信息。** 每套机制都保证"摘要不全"不等于"信息丢失"：
- 工具有 registry 全集路由兜底(未披露也能执行)
- Evidence 有 CAS 兜底(原文落盘,SHA-256 寻址)
- Skill 正文在磁盘上(随时可 view)
- Repo Map 索引可续建(游标保留)

**2. 按需支付的边际成本。** 不预先把所有可能用到的信息塞进上下文,而是让模型在确有需要时主动回取。上下文窗口是稀缺资源,渐进披露是它的主要守护机制。"预览不够精确"的代价只是多一次工具调用,是可接受的。

**3. 轻量入口 + 完整回取的二段式。** 每套机制都有一个摘要/入口工具和一个完整回取工具成对出现,中间靠一个"引用"连接：工具靠 `search_tools`→扩展 schema、Skill 靠 catalog→`skill_view`、ToolResult 靠 summarizer→`read_evidence`、Repo Map 靠游标→`scanUntil`。

### 自动旁路披露

除了模型主动激活,代码里还有两处自动 disclose,处理"渐进列表会造成能力断裂"的场景：
- **Evidence 归档时**自动 disclose `read_evidence`(`loop.ts:2798`)——预览给了引用,必须让回读工具可见
- **Plan 执行态**自动 disclose `update_plan`/`cancel_plan`(`agent-runtime.ts:1378`)——进入执行态需要这两个工具

### 会话态白名单优先级最高

Plan Mode、explore-synthesis-only、required-first-delegation 这几种会话态会用更窄的白名单**覆盖**渐进披露的 `availableTools`。其中 Plan Mode 的处理最关键(`loop.ts:1610`):**渐进披露不得把 `submit_plan` 和 `ask_user` 隐藏**,否则模型看到 Plan Prompt 却没完成协议所需的工具。这体现了"渐进披露要让位于协议正确性"——能力完整性优先于上下文精简。

---

## 九、可观测性

渐进披露本身是隐式的(模型感知不到"被隐藏了什么"),所以观测很重要：
- `loop.ts:1714` 在 Action span 里记录 `availableToolCount` vs `totalToolCount`,可算出被隐藏的工具数
- `repo_map` 工具输出 `indexed/total/cursor/complete/limitReason`,索引进度对模型可见
- Tool Result 投影带 `mode: full|preview`、`strategy`、`truncated` 标志,模型知道看到的是摘要还是原文

---

## 十、适用边界

渐进披露不是万能的。它假设"摘要足够让模型判断是否需要完整层",这对结构化数据(工具 schema、Skill 元数据、符号表)成立,但对**语义需要全文才能判断**的场景(如一段模糊的自然语言错误日志)可能失误——模型可能因预览不够而错过关键线索。pico 的缓解是：head-tail 保留输出头尾(错误信息常在尾部),且 `read_evidence` 回取成本低。

另一边界是**持久化缺失**。Repo Map 索引纯内存,进程重启归零;Skill catalog 每次会话重新扫描。这对单会话内反复查询是合理的,但跨会话的频繁冷启动会有重复扫描开销。pico 的取舍是：现场探索保证新鲜度,不维护第二份可能过时的知识副本。

---

## 十一、小结

pico-harness 的渐进披露不是某一个开关,而是贯穿工具、技能、工具结果、代码索引、仓库侦察五个层面的同构设计。模型默认只看到一个有界的、低成本的摘要世界;每需要越界,就用一次显式调用换回完整内容;摘要永不丢信息,回取是边际成本。这把上下文窗口从"装下一切可能的工具和输出"解放为"只装此刻正在推进的那条路径"——在工具数量、技能数量和仓库规模都不可控的真实工程里,这是让 Agent 保持可扩展性的关键约束。

## 代码索引

- 工具分层：`src/tools/tool-tiers.ts`
- 工具披露状态机：`src/tools/tool-disclosure.ts`
- 检索元工具：`src/tools/search-tools.ts`
- Skill Catalog 与二段式：`src/context/skill.ts`、`src/context/composer.ts`
- Tool Result 预览与 Evidence 回读：`src/tools/result-summarizer.ts`、`src/tools/tool-result-observation.ts`、`src/tools/evidence-read.ts`
- Repo Map 渐进索引：`src/code-intelligence/repo-map.ts`、`src/tools/code-intelligence.ts`
- explore_repo 侦察：`src/tools/explore-repo.ts`
- Loop 集成与旁路披露：`src/engine/loop.ts`

## 来源与范围

本文依据 pico-harness 当前实现(`9783d7a6` 之后的代码状态)与代码注释整理。各机制的阈值(2048 token、1600/3000 字符、200 文件/批、30 默认侦察文件)均描述本文写作时的实现,不应外推为固定参数;它们随实现演进可能调整。
