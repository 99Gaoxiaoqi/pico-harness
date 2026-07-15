# 数据流：核心流程时序

> 以具体场景串联整个架构，展示数据在各模块间的流转。

---

## 1. 一轮 ReAct 循环的完整时序

```
用户输入 "读一下 README.md 并总结"
    │
    ▼
┌─ runtime/agent-runtime.ts ─────────────────────────────────────┐
│ 固定 picoHome/runtimeEnv、Session、Provider 与工具依赖          │
│ RuntimeRun.run(() => engine.run(session))                       │
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
│ │     ├─ Skills 清单(.pico/skills + $PICO_HOME/skills)         │ │
│ │     ├─ TodoList($PICO_HOME/workspaces/<id>/todo.json)        │ │
│ │     └─ Goal(如有 active goal)                                │ │
│ │   availableTools = registry.getAvailableTools()              │ │
│ │     └─ toolDisclosure.pickForLLM(渐进披露:7 核心+search_tools) │ │
│ │   modelContext = session.getModelContext()                   │ │
│ │     └─ 完整历史副本 + ToolResult 访问元数据更新                │ │
│ │   contextHistory = [system, ...modelContext]                 │ │
│ │                                                              │ │
│ │ ② token 水位整理                                             │ │
│ │   低于 85% 原样发送；超水位先缩短旧 ToolResult                │ │
│ │   仍超水位则在完整工具批次边界摘要旧前缀                       │ │
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
│ │     ├─ Hardline/Plan/Trust 安全门                             │ │
│ │     ├─ PreToolUse Hook(改写后重跑安全门)                 │ │
│ │     ├─ PermissionRequest Hook / 人工审批                    │ │
│ │     ├─ preWriteHook(文件历史备份:read 不写,跳过)               │ │
│ │     ├─ tool.execute(args) → 文件内容                          │ │
│ │     ├─ truncateToolOutput(截断 8000 字符)                     │ │
│ │     └─ PostToolUse/PostToolUseFailure（有界等待）          │ │
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
发送前估算（消息 + 工具 Schema）超过输入预算的 85%
    │
    ▼
旧 ToolResult 请求投影
    │
    ├─ 回到 85% 以下 → 发送投影（Session 不变）
    └─ 仍超水位 → FullCompactor
        ├─ findSafeCompactionCut(token 目标)
        ├─ toolCalls 与整批 results 不跨边界
        ├─ session.applyCompaction(summary, compactedCount)
        └─ 重新组装“摘要 + 完整安全尾部”

provider.generate() 若仍返回 ContextOverflowError
    │
    ├─ 用 10% 尾部目标执行一次紧急 FullCompaction
    ├─ 重试一次，不做 14/10/6 条消息缩窗
    └─ 仍失败才硬重置:
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
    │   │   AgentRuntime 的 CredentialRotationCoordinator:
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
用户在 TUI 输入: /rewind

TUI rewind command/dialog:
  ├─ 直接打开用户消息列表，不暴露 UUID 参数补全
  ├─ 用户选择提示词，再选择 code / conversation / both
  ├─ messageId / messageIndex 从所选快照读取
  └─ 统一调用 applyTuiRewind，同步 Session、文件、transcript、输入框与 mode

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

下面只展示 `explore` 的只读数据流，不代表所有 Worker 都只读。可写 Shared/Isolated Worker 的任务范围、OCC、动态写入和隔离升级流程见[多 Agent 共享工作区并发规范](./08-multi-agent-concurrency.md)。

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
      └─ artifacts: 大输出落盘 $PICO_HOME/workspaces/<id>/artifacts/

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

## 7. Desktop 到 Runtime 的控制流

```text
Renderer 用户操作
  └─ window.pico.runtime.invoke(method, params)
       └─ Preload DesktopBridge
            └─ Electron IPC（method allowlist + sender 校验）
                 └─ Electron Main LocalRuntimeClient
                      └─ authenticated local daemon socket/pipe
                           └─ DesktopRuntimeService / WorkspaceRuntimeService
                                ├─ 读写 RuntimeEventStore / RuntimeStore
                                └─ 需要模型执行时调用 AgentRuntime

daemon subscription
  └─ Runtime notification
       └─ LocalRuntimeClient 独立订阅连接
            └─ Preload callback
                 └─ Renderer 将通知投影为 Transcript / Timeline / status
```

Renderer 不直接读取 SQLite、文件系统或 secret。Session 标题来自 RuntimeEvent；Desktop
metadata 只保留 archive 等 UI 状态。Jobs、Runs 和 Usage 来自 RuntimeStore 控制面，不能
替代 Session Transcript。

---

## 8. 渐进披露交互流程

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
