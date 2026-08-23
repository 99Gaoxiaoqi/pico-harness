# pico-harness 前缀缓存：断点注入、冻结策略与命中可观测性

> 文档状态：待专项复核。缓存原理仍可参考，但 Provider 能力、阈值和代码行号可能已经漂移；
> 实施或调参前必须回查 `src/provider/`、`src/context/` 与相关集成测试。

> 本文梳理 pico-harness 如何利用大模型 Provider 的 Prompt Cache 能力降低延迟和成本。核心策略是**按稳定性分层**——把跨轮不变的内容放进缓存前缀，把每轮变化的内容隔离到断点之后。涉及内容分层、Claude 显式断点注入、OpenAI 隐式 cache key、Claude 预热、三层前缀稳定率诊断，以及压缩对缓存的影响。

---

## 一、为什么需要前缀缓存

主流 Provider（Anthropic、OpenAI）都支持 Prompt Cache：如果连续多次请求的前缀完全一致（token 序列逐字节相同），Provider 能复用已计算的 KV-cache，跳过前缀的 prefill 阶段。

| 维度 | 不命中（cold）      | 命中（cache read） |
| ---- | ------------------- | ------------------ |
| 计费 | 完整输入 token 单价 | 约 1/10 单价       |
| 延迟 | 完整 prefill 时间   | 跳过前缀 prefill   |

一个典型 Pico 请求的前缀（system prompt + tools schema + 10 轮历史）约 15K-30K token。如果每轮都能命中缓存，等于每轮省掉 90% 的前缀计算成本和对应的 TTFT（首 token 延迟）。

**缓存匹配是精确前缀匹配**——前缀中任何一个 token 变化，从变化点往后的缓存全部失效。因此缓存设计的核心问题就是：**哪些内容会变，哪些不变，怎么把它们分开**。

---

## 二、核心设计：按稳定性分层

Pico 把发送给模型的请求内容按变化频率分成三层，每层对应一个缓存断点：

```
[system prompt]          ← 跨 run 读，run 内冻结      断点①  可用 1h TTL
[tools schema]           ← run 内冻结 + 确定性排序     断点②  可用 1h TTL
[对话历史 user₁...userₙ₋₁] ← 逐轮增长，旧部分不变       断点③  强制 5m TTL
[userₙ + <turnTail>]     ← 每轮全新，不缓存           断点之后
```

缓存断点由 Provider 协议层自动注入（见第五节），模型不需要感知。关键约束是**断点之前的内容必须逐字节不变**——这是下面所有策略的出发点。

---

## 三、内容分层：systemPrompt vs turnTail

`PromptComposer.buildLayers()`（`src/context/composer.ts:91-195`）是分层的起点。它返回两个独立字符串：

```typescript
interface PromptLayers {
  readonly systemPrompt: string; // 跨轮稳定，进缓存前缀
  readonly turnTail: string; // 每轮重建，在断点之后
}
```

### 进 systemPrompt 的内容（跨轮稳定）

| 片段                | 来源                    | 变化时机                     |
| ------------------- | ----------------------- | ---------------------------- |
| 核心身份 + 5 条纪律 | 硬编码                  | 极少（代码变更）             |
| 无人值守完成契约    | 硬编码                  | 极少（仅 isolated headless） |
| 用户级指南          | `~/.pico/AGENTS.md`     | 用户手动编辑（低频）         |
| 项目级指南          | 工作区 `AGENTS.md`      | 用户手动编辑（低频）         |
| Plan Mode 约束      | 硬编码                  | 仅 Plan 模式                 |
| Skills catalog      | `skillLoader.loadAll()` | 用户增删 Skill 文件（低频）  |

共同特征：**全部是文件型静态内容**。文件改动是低频显式事件，Pico 接受"改文件 → 下个 run 破缓存"的代价。

### 进 turnTail 的内容（每轮重建）

| 片段               | 来源                                | 为什么不进 system |
| ------------------ | ----------------------------------- | ----------------- |
| 环境信息           | `date / cwd / platform`             | date 每轮变       |
| TodoList 状态      | `TodoStore.buildTodoContext()`      | 每轮可能变        |
| Goal 状态          | `GoalManager.buildGoalContext()`    | 每轮可能变        |
| **记忆块**         | `MemoryContextBuilder.build()`      | 每轮可能变        |
| Plan revision 请求 | `PlanCoordinator.project()`         | 仅 Plan 模式      |
| Schedule 意图引导  | `looksLikeScheduleCreationIntent()` | 仅匹配时          |

共同特征：**运行时动态状态**。即使某些项（如记忆）"相对稳定"，Pico 仍然把它们放进 turnTail——因为缓存匹配是逐字节的，任何一次变化都会让整个 system 前缀失效。

---

## 四、run 内冻结：代码保证

system prompt 不只是"设计上应该稳定"——有代码强制保证。

### 4.1 systemPrompt 在 run 开始时取一次，之后不重新赋值

`src/engine/loop.ts:1493-1554`：

```typescript
// run 开始时：调一次 buildPromptLayers，systemPrompt 赋值给 const
const initialPromptLayers = await this.buildPromptLayers(currentUserPrompt, signal);
const systemPrompt = initialPromptLayers.systemPrompt; // 不可变局部
let turnTail = initialPromptLayers.turnTail;

// 主循环每轮：
for (;;) {
  // ...
  if (turnCount > 1) {
    const fresh = await this.buildPromptLayers(currentUserPrompt, signal);
    turnTail = fresh.turnTail; // ← 只刷新 turnTail
    // systemPrompt 永不重新赋值
  }
  // ...
}
```

### 4.2 工具集也在 run 内冻结

工具 schema 是缓存前缀的一部分（断点②）。如果工具集在 run 中途变化，会破坏断点②。Pico 用 `runToolSnapshot`（`loop.ts:1515, 1591-1592`）在首轮冻结工具列表，后续轮直接复用。

### 4.3 工具 schema 确定性归一化

即使工具集不变，如果 schema 的 JSON 属性顺序变了，逐字节匹配也会 miss。`snapshotToolDefinitions`（`src/provider/prompt-cache.ts:35-42`）做两件事：

- 按 `name` 排序
- `stableJson` 递归按 key 字典序排列

这保证"同一组工具无论注册顺序如何，序列化结果完全一致"。

### 4.4 跨 run 不冻结

systemPrompt 的冻结是 **run 级**而非 session 级。每个新 run（新用户输入）会重新调用 `buildPromptLayers`，因此 `AGENTS.md` 改动、Skill 增减会在下一次 run 生效。

---

## 五、turnTail 追加策略

`appendTurnTail`（`src/engine/loop.ts:280-298`）把 turnTail 追加到**最后一条可见 user 消息**的尾部：

```typescript
function appendTurnTail(messages: Message[], turnTail: string): Message[] {
  const currentUserIndex = messages.findLastIndex(
    (m) =>
      m.role === "user" &&
      m.toolCallId === undefined &&
      m.providerData?.["picoHiddenFromTranscript"] !== true,
  );
  if (currentUserIndex < 0) return messages;
  requestMessages[currentUserIndex] = {
    ...currentUser,
    content: `${currentUser.content}\n\n<current-turn-context>\n${turnTail}\n</current-turn-context>`,
  };
  return requestMessages;
}
```

三个关键特性：

1. **追加到最后一条 user 消息尾部**——绝不插入历史中间
2. **只作用于请求副本**——不写回 session 历史，历史保持干净
3. **位于所有缓存断点之后**——turnTail 内容变化不影响已缓存的前缀

---

## 六、Provider 缓存断点注入

### 6.1 Claude：显式断点（`src/provider/anthropic-cache.ts`）

`applyAnthropicCacheControl`（`anthropic-cache.ts:75-153`）在翻译完的请求体上自动注入 `cache_control: { type: "ephemeral" }`，最多 4 个断点，Pico 用 3 个，预留 1 个余量：

| 断点      | 位置                                | TTL                        | 缓存内容                |
| --------- | ----------------------------------- | -------------------------- | ----------------------- |
| ① system  | systemPrompt 末尾 text block        | `stablePrefixTtl`（可 1h） | system prompt           |
| ② tools   | 最后一个 tool definition            | `stablePrefixTtl`（可 1h） | system + tools          |
| ③ history | `messages[length-2]` 最后一个 block | `historyTtl`（强制 5m）    | system + tools + 旧历史 |

断点③在**倒数第二条**而非最后一条消息——因为最后一条是本轮 user 输入（每轮都变）。

为什么 history 用 5m 而 system/tools 可用 1h？因为 history 会被压缩打断（见第八节），不值得用长 TTL。

**门控**（`claude.ts:430-438`）：profile 声明支持缓存 + 配置显式 true/false，或兼容端点必须是 `api.anthropic.com`。

### 6.2 OpenAI：隐式 cache key（`src/provider/prompt-cache.ts` + `openai.ts`）

OpenAI 不用显式断点，而是用 `prompt_cache_key` 标识缓存槽。`openAIPromptCacheKey`（`prompt-cache.ts:89-101`）生成 key：

```
pico:{routeIdentity}:{prefixHash}:{shard}
```

- `routeIdentity`：`promptCacheRouteIdentity`（`prompt-cache.ts:104-118`），刻意**剥离 query 参数和凭证**
- `prefixHash`：`hash(system + tools)`，**排除对话/用户内容**
- `shard`：高 RPM 场景可按 `keyShards` 配置分片（1-64），避免单 key 热点

GPT-5.6 支持显式断点（`prompt_cache_breakpoint`），Pico 在 `openai.ts:780-820` 支持。

**兼容端点容错**：非官方端点可能拒绝 `prompt_cache_key` 等字段（返回 400/422）。`rejectedPromptCacheFields`（`openai.ts:759-770`）按路由记忆被拒绝的字段，fail-open 重试去掉字段。

### 6.3 配置模型：`PromptCachePolicy`

定义在 `src/provider/model-capabilities.ts:38-46`，每条路由独立配置：

| 字段        | Claude               | OpenAI                               |
| ----------- | -------------------- | ------------------------------------ |
| `mode`      | `"explicit"`（必须） | `"implicit"` 或 `"explicit"`         |
| `ttl`       | `"5m"` 或 `"1h"`     | �� `"30m"`（需 explicitBreakpoints） |
| `keyShards` | 必须 `1`             | `1`-`64`                             |
| `prewarm`   | 可选 `true`          | 不支持                               |

---

## 七、Claude 预热机制

`src/provider/prompt-cache-prewarm.ts`——仅 Claude、`prewarm: true` 且官方端点。

预热的核心思路：在**首次真实请求之前**，先发一个只含 system + tools 的请求填充缓存，让真实请求直接命中。

```typescript
// 预热请求的形状
messages: [...stableSystem, { role: "user", content: "." }];
max_tokens: 0;
tool_choice: "none";
// 不含对话历史、不含 user 内容——只 warm system/tools
```

**去重**（`PromptCachePrewarmCoordinator`，`prompt-cache-prewarm.ts:42-95`）：同一 prefix 在 TTL 内不重复预热。**失败 fail-open**：预热失败不影响真实请求。**不兼容判定**：streaming / manual extended thinking / structured output / forced tool_choice 时禁用预热。

装配点在 `src/runtime/agent-runtime.ts:1173-1175`。

---

## 八、压缩对缓存的影响

上下文压缩（`runMidTurnCompaction`，`loop.ts:1044-1102`）把旧历史替换为摘要，带 `[上下文压缩 — 仅供参考]` marker（`compaction-markers.ts:2`）。

| 缓存层        | 压缩后是否命中 | 原因                             |
| ------------- | -------------- | -------------------------------- |
| 断点① system  | ✅ 仍命中      | 压缩只动历史，不动 system        |
| 断点② tools   | ✅ 仍命中      | 同上                             |
| 断点③ history | ❌ 失效        | 压缩把旧历史替换为摘要，内容变了 |

诊断系统专门识别压缩场景：`structuralChangeReason = "full_compaction_summary_added_or_revised"`（`provider-request-diagnostics.ts:137-141`），冷启动归因为 `full_compaction_or_history_rewrite`（`cache-effectiveness.ts:262-264`）。

这就是 history 断点用 5m TTL 的原因——它反正会被压缩打断，不值得用长 TTL。

---

## 九、缓存可观测性

Pico 有一套比"看命中率"更完整的诊断系统，分布在两个文件。

### 9.1 请求指纹捕获（`src/observability/provider-request-diagnostics.ts`）

每次请求在协议翻译完、序列化前，通过 `onRequestPrepared` 回调被捕获。`capturePreparedProviderRequest`（`:98-114`）把请求切成 segments：

| segment kind    | 内容         |
| --------------- | ------------ |
| `tool_schema`   | 工具定义     |
| `system_prompt` | system 消息  |
| `message`       | 每条对话消息 |

每个 segment 记 hash + bytes（**不存明文**）。诊断顺序固定为 **tools → system → messages**，对齐 Anthropic 的真实缓存顺序。

`diagnosePreparedProviderRequest`（`:117-152`）与同 session 的上一份指纹比较，输出：

- `changeReason`：`stable` / `request_changed` / `cacheable_prefix_changed`
- `firstChangedCacheableSegment`：首个变化的可缓存段
- `cacheBreakpointComparisons`：逐断点对比

### 9.2 效果聚合（`src/observability/cache-effectiveness.ts`）

`summarizeCacheEffectiveness`（`:75-218`）基于 `provider_calls` 聚合：

**命中率指标**：

- `requestHitRate`：cache read 次数占比
- `promptTokenReuseRate`：cacheRead / 总 prompt token
- `cacheReadToWriteRatio`

**三层前缀稳定率**（`prefixStability`）：

| 层           | 含义                          | 计算方式                    |
| ------------ | ----------------------------- | --------------------------- |
| tools        | 工具 schema 是否变了          | stable / (stable + changed) |
| tools+system | 工具 + system prompt 是否变了 | 同上                        |
| history      | 对话历史是否变了              | 同上                        |

**冷启动归因**（`coldStarts.byReason`，`:253-296`）：

| 原因                                 | 含义                              |
| ------------------------------------ | --------------------------------- |
| `initial_cold_request`               | 首次请求                          |
| `tool_disclosure_or_schema_revision` | 首变段是 tool_schema              |
| `prompt_revision`                    | 首变段是 system_prompt            |
| `full_compaction_or_history_rewrite` | history removed 或 bytes 大幅缩小 |
| `model_switch`                       | provider/model/route 变化         |
| `ttl_or_route_expiry_suspected`      | 前缀没变但 cacheRead=0            |

**运营告警**（`operationalAlerts`，`:309-400`，标注 "Advisory only"）：

- `cache_write_dominates`：连续 N 次写入 > 读取
- `route_zero_hits`：路由持续零命中
- `prefix_stability_declining`：某层稳定率 < 0.8

### 9.3 各模型缓存最小 token 阈值

缓存有最小 token 门槛，低于门槛不生效。Pico 按模型族识别（`cache-effectiveness.ts:455-473`）：

| 模型族        | 最小门槛 |
| ------------- | -------- |
| Claude opus   | 1024     |
| Claude sonnet | 1024     |
| Claude haiku  | 2048     |

���于门槛的请求会被标记 `prompt_below_minimum_threshold` 诊断。

---

## 十、什么破坏缓存 / 什么不破坏

### 破坏缓存（cacheable_prefix_changed）

| 操作                                   | 影响层                       | 生效时机                                 |
| -------------------------------------- | ---------------------------- | ---------------------------------------- |
| 编辑 `AGENTS.md` / `~/.pico/AGENTS.md` | tools+system                 | 下个 run                                 |
| 增删 Skill 文件                        | tools+system                 | 下个 run                                 |
| 工具集变化（渐进披露）                 | tools                        | run 内不破坏（冻结+排序），下个 run 破坏 |
| Plan Mode 进出                         | tools+system                 | 下个 run                                 |
| 上下文压缩                             | history（system/tools 保留） | 压缩发生时                               |
| 切换模型/provider/route                | 全部                         | 立即                                     |

### 不破坏缓存

| 操作                                  | 原因                           |
| ------------------------------------- | ------------------------------ |
| 每轮 TodoList / Goal 变化             | 在 turnTail，断点③之后         |
| 每轮记忆 recall / fresh update        | 在 turnTail                    |
| Today's date 变化                     | 在 turnTail                    |
| 新增一轮对话（追加新 user/assistant） | 断点③在倒数第二条，新增在 tail |
| 凭证轮换（多 key）                    | key 不进 cache identity        |

---

## 十一、与 Maka 策略的对比

| 维度                | Maka                                       | Pico                                   |
| ------------------- | ------------------------------------------ | -------------------------------------- |
| active/稳定记忆放哪 | system prompt                              | turnTail                               |
| fresh update 放哪   | turn tail                                  | turnTail（一致）                       |
| system prompt 内容  | 含动态记忆                                 | 严格只含文件型静态内容                 |
| 设计取舍            | 用"破缓存风险"换"记忆在 system 的强注意力" | 用"记忆位置靠后"换"记忆变化永不破缓存" |
| 缓存诊断            | `systemPromptHash` 变化检测                | 三层稳定率 + 冷启动归因 + 运营告警     |
| 预热机制            | 无                                         | 有（Claude 专属）                      |

Pico 更激进地保守——把一切可能变化的运行状态（Todo/Goal/env/date/memory）都赶出 system prompt。代价是模型看到的动态状态位于 user 消息尾部 `<current-turn-context>`，注意力权重弱于 system prompt 顶部。

---

## 关键代码索引

| 功能                              | 文件:行                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| 缓存策略配置模型                  | `src/provider/model-capabilities.ts:38-46`                  |
| 策略解析与校验                    | `src/provider/model-capabilities.ts:129-220`                |
| Claude 断点注入                   | `src/provider/anthropic-cache.ts:75-153`                    |
| Claude 断点应用                   | `src/provider/claude.ts:402-415`                            |
| OpenAI cache_key 生成             | `src/provider/prompt-cache.ts:89-101`                       |
| 工具 schema 归一化                | `src/provider/prompt-cache.ts:35-42`                        |
| prefix hash 计算                  | `src/provider/prompt-cache.ts:69-86`                        |
| Claude 预热协调器                 | `src/provider/prompt-cache-prewarm.ts:42-116`               |
| PromptLayers 接口                 | `src/context/composer.ts:22-25`                             |
| 内容分层 buildLayers              | `src/context/composer.ts:91-195`                            |
| systemPrompt 冻结 / turnTail 刷新 | `src/engine/loop.ts:1493-1554`                              |
| appendTurnTail                    | `src/engine/loop.ts:280-298`                                |
| 工具 run 内冻结                   | `src/engine/loop.ts:1515, 1591-1592`                        |
| 请求指纹捕获                      | `src/observability/provider-request-diagnostics.ts:98-114`  |
| 增量诊断对比                      | `src/observability/provider-request-diagnostics.ts:117-152` |
| 缓存效果聚合                      | `src/observability/cache-effectiveness.ts:75-218`           |
| 冷启动归因                        | `src/observability/cache-effectiveness.ts:253-296`          |
| 运营告警                          | `src/observability/cache-effectiveness.ts:309-400`          |
