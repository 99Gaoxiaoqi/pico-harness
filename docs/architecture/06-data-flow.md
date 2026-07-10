# 数据流：核心流程时序

> 以具体场景串联整个架构，展示数据在各模块间的流转。

---

## 1. 一轮 ReAct 循环的完整时序

```
用户输入 "读一下 README.md 并总结"
    │
    ▼
┌─ cli/run-agent.ts ─────────────────────────────────────────────┐
│ session.append({role:"user", content:"读一下 README.md..."})    │
│ engine.run(session)                                             │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ engine/loop.ts: run() ────────────────────────────────────────┐
│                                                                  │
│ ┌─ Turn 1 ────────────────────────────────────────────────────┐ │
│ │                                                              │ │
│ │ ① 组装上下文                                                 │ │
│ │   systemPrompt = PromptComposer.build()                      │ │
│ │     ├─ 极简内核(身份+纪律)                                    │ │
│ │     ├─ AGENTS.md(项目规范)                                    │ │
│ │     ├─ Skills 清单(.claw/skills/)                            │ │
│ │     ├─ TodoList(.claw/todo.json)                             │ │
│ │     └─ Goal(如有 active goal)                                │ │
│ │   availableTools = registry.getAvailableTools()              │ │
│ │     └─ toolDisclosure.pickForLLM(渐进披露:7 核心+search_tools) │ │
│ │   workingMemory = session.getWorkingMemory(20)               │ │
│ │     └─ 丢弃孤儿 ToolResult                                    │ │
│ │   contextHistory = [system, ...workingMemory]                │ │
│ │                                                              │ │
│ │ ② 压缩                                                       │ │
│ │   compactedContext = compactor.compactToBudget(contextHistory)│ │
│ │     └─ 超 maxChars 才压缩(掩码/掐头去尾/占位符)                │ │
│ │     └─ 绝不动 toolCalls                                       │ │
│ │                                                              │ │
│ │ ③ Phase 1 慢思考(enableThinking)                              │ │
│ │   reporter.onThinking() → spinner 启动                        │ │
│ │   thinkResp = provider.generate(compactedContext, tools=[])  │ │
│ │     └─ 传空 tools[],模型被迫纯文本规划                          │ │
│ │   session.append(thinkResp)                                  │ │
│ │   compactedContext.push(thinkResp)                           │ │
│ │                                                              │ │
│ │ ④ Phase 2 行动                                               │ │
│ │   responseMsg = provider.generate(compactedContext, tools)   │ │
│ │     ├─ 流式: generateStream → onDelta → reporter.onTextDelta │ │
│ │     └─ CostTracker 包装: 计时/计费/session.recordUsage       │ │
│ │   responseMsg.toolCalls = [{name:"read_file", args:"{...}"}] │ │
│ │   session.append(responseMsg)                                │ │
│ │                                                              │ │
│ │ ⑤ 工具执行(资源冲突图调度)                                    │ │
│ │   scheduler = new ToolScheduler({maxConcurrency:8})          │ │
│ │   registry.execute({name:"read_file", args})                 │ │
│ │     ├─ RequestMiddleware(审批:read_file 安全,放行)             │ │
│ │     ├─ PreToolUse Hook(fail-open)                             │ │
│ │     ├─ preWriteHook(文件历史备份:read 不写,跳过)               │ │
│ │     ├─ tool.execute(args) → 文件内容                          │ │
│ │     ├─ truncateToolOutput(截断 8000 字符)                     │ │
│ │     └─ PostToolUse Hook(fire-and-forget)                     │ │
│ │   session.append(toolResult)                                 │ │
│ │                                                              │ │
│ │ ⑥ 文件历史快照(每轮 finally)                                  │ │
│ │   fileHistoryMakeSnapshot(session.fileHistory, messageId)    │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─ Turn 2 ────────────────────────────────────────────────────┐ │
│ │ ①-④ 同上,模型看到 read_file 结果                              │ │
│ │ ⑤ toolCalls.length === 0 → 任务完成                           │ │
│ │   reporter.onFinish() → spinner 停止                          │ │
│ │   break                                                      │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ return session.getHistory().slice(beforeLen)                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 上下文溢出时的压缩协作

```
provider.generate() → API 返回 400/413 (ContextOverflowError)
    │
    ▼
generateWithOverflowRetry 外层捕获
    │
    ├─ attempt 0: 用当前 context(已压缩)
    │   → 仍 overflow
    │
    ├─ attempt 1: WorkingMemory × 0.7, maxChars × 0.6
    │   → compactor.compactToBudget(更小窗口+更小预算)
    │   → 仍 overflow
    │
    ├─ attempt 2: WorkingMemory × 0.5, maxChars × 0.4
    │   → compactor.compactToBudget()
    │   → 仍 overflow
    │
    ├─ attempt 3: 最后兜底 —— 模型摘要压缩(仅 1 次)
    │   ├─ fullCompactor.compact(session, retainLastN)
    │   │   ├─ provider 浓缩前 N 条为 13-section 摘要
    │   │   ├─ session.applyCompaction(summary, compactedCount)
    │   │   └─ 真替换 Session.history 前 N 条 ← 注意:真改持久化!
    │   ├─ 成功 → 重新组装 context 从默认预算重试
    │   └─ 失败 → 抛 ContextOverflowError
    │
    └─ run() 硬重置兜底:
        session.truncateTo(beforeLen - 1)
        清空历史只保留本轮用户输入
        continue 下一轮
```

---

## 3. 429 限流时的凭证轮换链路

```
provider.generate() → API 返回 429
    │
    ▼
generateWithRetry 内层捕获
    │
    ├─ 错误是 429 且注入了 onRateLimited 回调?
    │   │
    │   ├─ YES: 调 onRateLimited()
    │   │   │
    │   │   ▼
    │   │   run-agent.ts 的 rebuildProvider 回调:
    │   │   ├─ credentialPool.markRateLimited(currentKey)
    │   │   │   └─ 标记限流,60s 冷却
    │   │   ├─ nextKey = credentialPool.getNext()
    │   │   │   └─ round-robin 找未限流 key
    │   │   ├─ nextKey === currentKey? (全限流)
    │   │   │   ├─ YES → 返回 undefined → retry 回退同 key 退避
    │   │   │   └─ NO → 重建 provider 链(new CostTracker(new provider))
    │   │   └─ 返回新 provider
    │   │   │
    │   │   ▼
    │   │   retry 层拿到新 provider → 跳过退避 → 立即重试
    │   │
    │   └─ NO(单 key): 指数退避(300ms~5s)重试
    │
    └─ 达 maxAttempts(3) → 抛错
```

---

## 4. 文件历史三轴 rewind 流程

```
用户在 TUI 输入: /rewind turn-3 both

TUI rewind command/dialog 解析:
  ├─ messageId = "turn-3"
  ├─ messageIndex = 从快照 manifest 查 turn-3 对应的 session.length
  └─ mode = "both"

session.rewindBoth(messageId, messageIndex):
  │
  ├─ ① fileHistoryRewind(state, "turn-3")
  │   ├─ 找到 messageId="turn-3" 的快照
  │   ├─ 遍历快照的 trackedFileBackups:
  │   │   ├─ backupFileName=null → unlink(删除 Agent 新建的文件)
  │   │   └─ 有备份 → copyFile 恢复原始内容
  │   ├─ 遍历 trackedFiles: 不在快照里的(快照后新建)→ unlink
  │   └─ snapshots = slice(0, targetIdx+1)
  │
  └─ ② rewindTo(messageIndex)
      ├─ history = slice(0, messageIndex)  // 截断对话
      ├─ pruneToolResultMeta
      ├─ conversationId = 新 fork ID
      ├─ store.bumpEpoch()  // 持久化会话世代变更
      └─ persistRewindTo(messageIndex)  // 落盘 truncate 事件

结果: 代码回到 turn-3 开头 + 对话回到 turn-3 之前
```

---

## 5. 子代理委派流程

```
主 Agent: "搜索所有 TODO 注释并总结"
    │
    ▼
delegate_task({task_prompt:"搜索TODO", mode:"explore"})
    │
    ▼
AgentEngine.runSub():
  ├─ 创建全新 contextHistory(不依赖主 Session)
  ├─ 构建只读 registry:
  │   ├─ read_file / glob / grep / skill_view
  │   ├─ bash(强制 readOnly=true)
  │   └─ fetch_url / web_search
  ├─ 专属 System Prompt(严厉警告必须用工具)
  ├─ maxSubTurns=10, 关闭慢思考
  │
  │  ┌─ 子 Agent Turn 1-N ──────────────────┐
  │  │  grep "TODO" → 找到 15 个文件           │
  │  │  read_file 逐个读取                     │
  │  │  ...                                    │
  │  │  toolCalls=0 → 生成 summary             │
  │  └───────────────────────────────────────┘
  │
  ├─ summary < 200 字? → 追加一轮强制扩写
  └─ return {summary, artifacts[]}
      └─ artifacts: 大输出落盘 .claw/artifacts/

主 Agent 收到浓缩 summary(几百字) + artifacts 路径
  └─ contextHistory 不被几百个文件内容污染
```

---

## 6. TUI 渲染流程

```
用户打字 "你好" → InputBox useInput 累积字符
    │
    ▼ Enter 按下
InputBox.onSubmit("你好")
    │
    ▼
ReplApp.handleSubmit:
  ├─ guard.tryStart() → generation=1 (并发防护)
  ├─ reporter.pushUserMessage("你好") → entries.push({kind:"user"}) → emit
  │   └─ onUpdate([...entries]) → setEntries → App 重渲染
  └─ runAgentFromCli({prompt:"你好", reporter})  // TUI 内部装配，非公开 CLI
      │
      ▼ engine 事件流
      ├─ onStart → spinnerMode="requesting" → emit → App 重渲染
      ├─ onTurnStart → resetTurnBuffer
      ├─ onThinking → push thinking → spinnerMode="thinking" → emit
      ├─ onTextDelta("你") → streamingText+="你" → push assistant → emit
      │   └─ App: MessageRow(非 isStatic) → StreamingText(逐行增量)
      ├─ onTextDelta("好") → assistant.content+="好" → emit
      │   └─ StreamingText: stable 行 memo,只重渲染 unstable 行
      ├─ ... 更多 delta ...
      ├─ onMessage("你好！...") → 用权威版替换流式条目 → emit
      └─ onFinish → spinnerMode="idle" → emit
          └─ App: 输入框恢复,可继续输入
```

---

## 7. 渐进披露交互流程

```
轮次 N:
  loop.ts: availableTools = toolDisclosure.pickForLLM(allTools)
    → [7 核心工具] + [search_tools]  (还没 disclose 过)
  provider.generate(msgs, availableTools)  // 模型只看到 8 个工具

  模型: 需要搜索网络 → 调 search_tools({query:"搜索网络"})
    │
    ▼
  SearchToolsTool.execute:
    ├─ 在扩展组工具的 name+description 里匹配 "搜索网络"
    ├─ 命中 web_search, fetch_url
    ├─ disclosure.disclose(["web_search", "fetch_url"])
    └─ 返回 "已激活: web_search(搜索网络), fetch_url(抓取网页)"

轮次 N+1:
  loop.ts: availableTools = toolDisclosure.pickForLLM(allTools)
    → [7 核心] + [web_search, fetch_url] + [search_tools]  = 10 个
  模型现在能直接调 web_search
```
