# Graph Mode：增量工作调度与显式编排入口

> 本文梳理 pico-harness Graph Mode 的统一设计。核心不是"预声明一个 DAG 再执行",而是**模型用 `add_work` 逐个提交工作单元,系统从上游 record 的存在性自动解析依赖**。全部状态复用 RuntimeEventStore 事件流,零新 store;诊断与崩溃恢复内建在事件投影里,不依赖任何独立调度服务。

---

## 一、为什么需要 Graph Mode

`delegate_task` 是主 Agent 的一级编排入口,但它有两个局限:

1. **串行阻塞**——主 Agent 派一个子代理、等它完成、读结果、再派下一个。N 个独立任务要排成 N 轮模型往返。
2. **依赖隐式**——下游任务靠主 Agent 在 prompt 里手动转述上游产出,系统看不到"这个任务依赖那个结果"。

Graph Mode 把这两件事显式化:

- **并行**——多个无依赖的 `add_work` 立即并行派发子代理,主 Agent 不必轮询等待。
- **依赖**——`add_work` 的 `input_ids` 显式声明"等这些 record 产出后再派发我",系统自动调度。

**关键设计取舍**:模型不预先声明整个 DAG。原因很现实——下游的 `input_ids` 必须引用上游产出的 `recordId`,而 recordId 在上游完成前不可知(确定性哈希派生,但模型算不出)。所以 Graph Mode 的实际形态是**增量提交**:声明一个、等它产出 record、再声明依赖它的下一个。系统在这之上提供"声明后自动派发 + 上游 settle 后自动链式下游"的调度,让模型的增量提交尽量接近"声明即并行"的体验。

---

## 二、全景:事件流 + 投影 + 工具 + 调度

Graph Mode 由四个角色协作,全部架在 RuntimeEventStore 之上:

| 角色       | 位置                                      | 职责                                                                                            |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **事件流** | RuntimeEventStore                         | 5 种 `graph.*` 事件,单 canonical,唯一真相                                                       |
| **投影**   | `graph-reducer.ts`                        | 从事件流幂等折叠出 `GraphProjection`(works/records/status)                                      |
| **工具层** | `graph-tools.ts`                          | `add_work` / `view_graph` / `close_graph`,经事件读写(view_graph 只读,add_work / close_graph 写) |
| **调度**   | `agent-runtime.ts` + `session-runtime.ts` | `graphDispatcher` 派发子代理 + `settleGraphWork` 写终态 + `graphReconcile` 续行                 |

```text
┌─────────────────────────────────────────────────────────────┐
│  RuntimeEventStore (单 canonical)                            │
│  graph.work.added / dispatched / recorded / failed / closed  │
└────────────────────────────┬────────────────────────────────┘
                             │ readSessionEntries
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  graph-reducer (projectGraphEntries)  ← 幂等折叠投影          │
│  GraphProjection { works, records, status, sessionSequence } │
└────────────────────────────┬────────────────────────────────┘
                             │ 读投影
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   AddWorkTool         ViewGraphTool        CloseGraphTool
        │ (input 就绪时)
        ▼
   graphDispatcher → DelegationManager → engine.runSub(子代理)
        │ 子代理完成
        ▼
   settleGraphWork (写 recorded/failed + 链式派发下游)
```

**核心不变量**:graph 层没有任何独立存储。`GraphProjection` 是从事件流现场折叠的派生视图,任何时候都可以从事件流重建。这意味着 rewind/fork/resume 天然一致——graph 状态就是事件历史。

---

## 三、核心抽象与确定性 ID（`src/graph/contract.ts`）

```text
GraphWork      = { workId, instruction, inputIds, mode, status,
                   delegationId?, recordId? }
GraphRecord    = { recordId, workId, outputSummary, evidenceRefs? }
GraphProjection = { graphId, works, records, status, sessionSequence }
```

两个确定性派生函数是一切幂等与依赖解析的基础:

```text
workIdFor(graphId, instruction, inputIds)
  = "work_" + sha256(graphId : instruction : sorted(inputIds)).slice(0,32)

recordIdFor(graphId, workId)
  = "record_" + sha256(graphId : workId).slice(0,32)
```

**为什么这是基础**:

- **幂等声明**——相同 (instruction, inputIds) 永远算出同一 workId。模型重复 `add_work` 同一任务,不会创建第二个 work,reducer 直接短路。
- **依赖寻址**——下游 `input_ids` 引用的就是上游的 recordId。recordId 由 workId 派生,workId 由 instruction 派生,所以"声明依赖"等价于"我知道上游任务的语义指纹"。
- **跨 run 稳定**——纯哈希,不依赖时间或随机数。resume 同一 session,graphId 从 sessionId 派生(`graph:${sessionId}`),同一图的 workId/recordId 不变。**graphId 与 sessionId 一对一绑定,每会话至多一个 active graph**;close 后该 session 不再可用 graph,需新会话或 fork。

### work 状态机

```text
                 graph.work.added            graph.work.dispatched
   (不存在) ─────────────────────▶ requested ─────────────────────▶ dispatched
                                        │                               │
                                        │ set 跳过 dispatched 事件       │
                                        │ (链式派发路径,实际罕见)         │
                                        ▼                               ▼
                                  ┌─────────────────────────────────────┘
                                  │ graph.work.recorded / graph.work.failed
                                  ▼
                            recorded 或 failed (终态)
```

**非常规守卫**:reducer 对 `recorded`/`failed` **不校验前置状态**(`graph-reducer.ts`)——只要 work 存在即可覆盖。这意味着 `requested → recorded`(跳过 dispatched)在 reducer 层合法,支撑了"settle 在 dispatcher 未绑定时仍能 commit record"的设计。`dispatched` 则要求前置为 `requested` 或 `dispatched`(后者用于幂等 replay)。`added` 在 closed 投影上被防御性忽略(reducer 守卫,见第九章)。

---

## 四、声明与派发:`add_work`

`AddWorkTool.execute` 的流程,每一步都有明确的不变量守护:

```text
1. normalize(instruction, input_ids, mode)
2. workId = workIdFor(graphId, instruction, inputIds)
3. 读投影 before
4. 守卫:before.status === "closed" → 抛 GraphConflictError
   (关闭后不得声明新工作)
5. work 不存在 → 写 graph.work.added (CAS: operationId+fingerprint+
   expectedSessionSequence 三重绑定,一次性事务)
6. 读投影 after → computeReadyWorks(after).find(workId)
7. 分支:
   ├─ work 已 dispatched/recorded/failed → 返回真实状态(防误导)
   ├─ ready(input 全满足) → graphDispatcher 派发 → 写 dispatched
   └─ 未就绪 → 返回 {status:"waiting", missingInputIds, hint}
```

**关键洞察 1:record 存在性 = 就绪**。`computeReadyWorks` 看 `inputIds` 是否都在已提交 records 里**且图处于 active 状态**(`graph-reconcile.ts`)。closed 图返回空就绪集——这是 settle 在 close 后只 record 不链式派发下游的底层原因。它不校验 record 内容——这是 graph 层的故意边界:record 的"真假"由 subagent 层保证,graph 层只负责调度。

**关键洞察 2:`missingInputIds` 诊断**。waiting 分支不止返回 `status:"waiting"`,还带上 `missingInputIds`(未产出的 recordId 列表)+ hint 文本。这是死锁反馈的第一道闸门——如果模型引用了错误的 id(比如把 workId 当 recordId),它在声明那一刻就能看到"这些 input 永远不会产出",而不必等到困惑地反复 view_graph。

**关键洞察 3:CAS 事务**。AddWorkTool 写 added 与写 dispatched 是**两次独立的 CAS**(`appendGraphOperation` 各自 `operationId+fingerprint+expectedSessionSequence`),分别实现声明与派发的幂等去重;dispatched 的 CAS 冲突被 best-effort 吞掉(delegation 已在跑)。`settleGraphWork` 则在 CAS 冲突时 retry 最多 3 次。reducer 幂等保证重复事件被短路。

### view_graph:只读投影(模型调试主入口)

view_graph 是模型排查 graph 状态的首选工具,返回当前投影的 JSON 快照:

- **顶层聚合**:`hasPendingWorks`(故意独立于图状态,closed 图也如实反映)、`readyWorkCount`
- **每个 work 渲染时也带 `missingInputIds` + hint**——这是 missingInputIds 的**常驻来源**(每次调用都重算),`add_work` 的 waiting 分支只是在声明那一刻额外提示一次
- **`include_records=false`** 可省略 records 数组省 token(默认 true)

这让第六章"工具返回值诊断易被忽略"成立——missingInputIds 确实每次 view_graph 都在,但模型在声明后往往不再主动查,所以需要续行消息在停止时再推一次。

---

## 五、settle 与链式派发

子代理(backing delegation)完成时,`DelegationManager` 在 delegation 终结路径里直接调用 `onGraphWorkSettled` 回调(`session-runtime.ts`)——**不经 delegationCompletionQueue**。这是有意的职责分离:`onCompletion`(经 queue)只用于 `delegate_task` 唤醒主 Agent;graph work 的完成走 `onGraphWorkSettled` 旁路,只写 graph 终态事件,不作为 completion 消息打断主 Agent(主 Agent 并未在等 graph work)。回调进入 `settleGraphWork`:

```text
settleGraphWork(session, graphContext, workId, status, outputSummary):
  CAS retry 循环(最多 3 次):
    1. 读投影 → 若 work 未 settle:
       completed(partial) → 写 graph.work.recorded
       其他(error/timed_out/cancelled) → 写 graph.work.failed
    2. 链式:重读投影 → computeReadyWorks → 对每个新就绪下游调 dispatcher
```

**关键设计:settle 不检查 graph.status**。即使图已 closed,在跑的 delegation 完成仍会写 recorded。这是 `close_graph` 的 warning 必须**按 dispatched/requested 分级措辞**的原因:

- `requested` 的 pending work——"不会再被调度、也不会产出记录"
- `dispatched` 的 pending work——"子代理仍在执行,完成后仍会写入 record(但不再触发下游)"

如果 warning 笼统说"不会再产出记录",对 dispatched work 就是虚假承诺,会被系统行为立刻打破。

**链式派发的边界**:`settleGraphWork` 调 dispatcher 派发下游,但**不写 `graph.work.dispatched` 事件**(只有 AddWorkTool 写)。实际中这条路径几乎不可达——模型无法预知 recordId,只能等上游 recorded 后再 add_work(走 AddWorkTool 内派发,会写 dispatched)。settle 的链式派发是兜底,正常流程用不到。

---

## 六、续行仲裁:决策时刻的诊断锚点（`src/engine/loop.ts`）

主 Agent 产生**非工具停止**(准备结束回合)时,engine 检查 graph 是否还有 pending 工作:

```text
graphSnapshot = graphReconcile()  ← {pending, ready, stuck}
if (pending > 0):
   if (continuations >= MAX=5):
      放行停止(pending 留待下次 run 或 orphan 恢复)
   else:
      注入 [Graph continuation] user 消息:
        "Graph Mode 仍有 N 个未完成的工作。"
        + readyHint(M 个已就绪 / 等待上游)
        + stuckHint(死锁 work 的 missingInputIds)  ← 关键
      continue(重新进入模型循环)
```

**为什么续行消息是诊断的核心**:工具返回值里的 `missingInputIds`(第四章)很容易被模型忽略——它在"声明那一刻"读到,但真正需要被提醒是在"准备停止/close"的决策时刻,那时诊断早已滚出注意力窗口。续行消息是模型在停止前的高注意力锚点,把死锁证据直接喂到这里,才能让模型自救(重新 `add_work` 修正 id,或显式 close 放弃)。

`graphReconcile` 的 `stuck` 字段(`agent-runtime.ts`)就是为此设计:它列出"requested 且当前仍有未提交 input"的 work(含真正死锁——id 错或上游已 failed——与上游在途两类,模型需用 view_graph 区分),在续行消息里带 missingInputIds 逐个列出。真实模型测试证明这条闭环有效——模型收到 stuck 提示后会主动用正确 recordId 重新声明。

---

## 七、显式入口:`orchestrationMode`

Graph Mode **默认关闭**,需用户显式开启。这是通过一个正交于 `collaborationMode`(agent/plan)的新字段 `orchestrationMode`("default"|"graph")实现的。

**三端入口**:

| 端      | 入口                                  | 作用域         |
| ------- | ------------------------------------- | -------------- |
| TUI     | `/graph` · `/graph on` · `/graph off` | session 级持久 |
| CLI     | `--graph` flag                        | 新会话初始模式 |
| desktop | composer graph toggle + 环境面板显示  | session 级持久 |

**门控三处**(`agent-runtime.ts`),确保 default 模式下模型完全看不到 graph:

```text
1. graph 工具注册(:1767)
   if (runtimeEventStore && !backgroundPolicy && orchestrationMode()==="graph")
2. GRAPH_TOOLS_SPEC prompt 注入(:1522)
   graphToolsAvailable = ... && orchestrationMode()==="graph"
3. graphReconcile 续行仲裁(:1644)
   ... && orchestrationMode()==="graph"
```

这三处必须同改——只改工具注册不改 prompt,会出现"工具没注册但 system prompt 仍在教模型用它"的反向不一致。

**门控的两个正交维度**:除 `orchestrationMode`(用户可见开关)外,`backgroundPolicy`(运行态派生条件)是隐式关闭维度。背景 runtime(如 detached delegation 内层)即使 `orchestrationMode==="graph"` 也无 graph 工具——graph 调度依赖 engine 续行仲裁,背景 runtime 不跑 engine loop。两维同时为真才注册工具。

**完全对标 `collaborationMode` 基础设施**:`orchestrationMode` 复用了 plan mode 的整套链路——`PersistedSessionSettings` 字段 + `normalize` 校验 + `SessionSettings` + setter + snapshot/applyPersisted + fork 继承 + execute 闭包 + daemon wire 投影 + 协议层 RPC + JSON-schema 白名单。新增一个模式字段 = 在这条链路的每个对称点加一行。resume 时持久化的 orchestrationMode 自动恢复(零额外代码)。

---

## 八、失败、死锁与恢复

### 8.1 settle 语义的边界

`recorded` 的含义是**子代理自报完成**,不是"任务目标达成"。子代理遇到不可完成任务时(如读取不存在的文件),会返回 `completed` + summary 里写"无法完成",而不是 `error`。于是 graph 层照常写 recorded,下游 input 满足后继续执行——错误被"自报完成"掩盖。

这是 graph 层的故意边界:record 的内容真实性无法在调度层识破(需要 LLM-as-judge 或 evidence 校验,属 subagent 层职责)。graph 层能做的,是保证 record 的 `outputSummary` 在 view_graph 里可见,让主 Agent 有机会读到"任务无法完成"的说明并自行判断。

### 8.2 close 边界

`close_graph` 有两条平行语义边界:**硬校验**——`result_record_ids` 引用未知 recordId 时抛 `GraphConflictError`(对标 finish 断言 result_ids 已提交,保证声明的"最终交付"真实存在);**软报告**——图带 pending work 时不拒绝,但返回 pendingWorks 清单 + 分级 warning,如实反映未收敛状态:

```text
close_graph → {
  status: "closed",
  pendingWorks: [...],          ← requested + dispatched 的 work 清单
  warning: "requested 不会再调度/产出;dispatched 仍会完成并写 record,但不再触发新的下游调度"
}
```

配套的,`hasPendingWorks`(`graph-reconcile.ts`)**故意不看图状态**——closed 图若有 in-flight/never-started work,view_graph 的顶层标志必须说 true,而不是和 close 的 pendingWorks 报告矛盾。

### 8.3 orphan 恢复:进程崩溃中断 delegation

如果一个 graph work 已 dispatched,但进程在子代理执行期间崩溃,backing delegation 随进程丢失。重启后该 work 永远停在 `dispatched`,既不会 record 也不会 fail——它是 orphan。

**检测**(`graph-recover.ts`):不能用 `delegationId === runId` 匹配(两者是独立 id 空间,永不相等)。正确判据是**活跃 delegation 集合**——重启后 DelegationManager 是全新空实例,所以"dispatched 且 delegationId 不在活跃集合里"= orphan。

**接入**(`runtime-run-executor.ts`):在启动恢复序列里,`reconcileIncompleteRuns`(折回未终结 run)之后、`RuntimeRun.start` 之前,跑一次 `findOrphanGraphWorks`,对每个 orphan 调 `settleGraphWork(status:"error", "orphan: backing delegation lost on process restart (recovered)")`。

**不自动 reclaim**:没有"claim 预分配 runId"的幂等机制,reclaim 会启动第二个子代理(双 activation,可能重复 side effect)。orphan 统一标 failed,让下游通过 missingInputIds 诊断自然卡住,由模型在续行消息里决定重新 add_work 或放弃。

---

## 九、关键不变量速查

| 不变量                          | 守护位置                                             |
| ------------------------------- | ---------------------------------------------------- |
| 单 canonical(无跨 store 一致性) | 全部走 RuntimeEventStore                             |
| work 声明幂等                   | workId 哈希 + reducer `findWork` 短路                |
| added+dispatched 原子事务       | CAS operationId+fingerprint+expectedSessionSequence  |
| closed 后不得新增 work          | AddWorkTool 检查 + reducer added 守卫(双重)          |
| record 存在性 = 下游就绪        | computeReadyWorks(只看存在性,不校验内容)             |
| settle 不依赖 graph.status      | settleGraphWork 不检查(closed 后仍写 recorded)       |
| 诊断在决策时刻可见              | 续行消息注入 stuck missingInputIds                   |
| closed 图的 pending 如实报告    | hasPendingWorks 不看图状态 + close 返回 pendingWorks |

---

## 十、设计权衡

- **record 驱动依赖**——不预声明 DAG 的代价:模型无法预知 recordId,只能"声明→等产出→再声明下游"的轮询式。链式自动派发是兜底,正常流程用不到。好处是依赖语义纯粹(存在性即就绪),无需 DAG 拓扑校验/环检测。
- **显式入口**——默认关闭给用户控制权(避免模型在不合适场景误用 graph),代价是用户需知晓何时开。入口形式三端齐全,底层对标 plan mode 基础设施。
- **不自动 reclaim orphan**——换来了简单性(无幂等 claim 机制),代价是崩溃中断的 work 要靠模型在续行消息里手动重新声明。
- **graph 层不识破自报完成**——换来了层级清晰(调度层只管存在性),代价是错误可能链式传播为"成功",需 subagent 层补 status 语义。

---

## 代码索引

| 模块            | 文件                                                     | 职责                                                          |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| 类型与 ID       | `src/graph/contract.ts`                                  | GraphWork/GraphRecord/GraphProjection + workIdFor/recordIdFor |
| 投影            | `src/graph/graph-reducer.ts`                             | projectGraphEntries 幂等折叠                                  |
| 依赖解析        | `src/graph/graph-reconcile.ts`                           | computeReadyWorks/hasPendingWorks/missingInputIdsFor          |
| orphan 检测     | `src/graph/graph-recover.ts`                             | findOrphanGraphWorks(liveDelegationIds 判定)                  |
| 工具            | `src/tools/graph-tools.ts`                               | AddWorkTool/ViewGraphTool/CloseGraphTool                      |
| 派发器          | `src/runtime/agent-runtime.ts`                           | graphDispatcher + graphReconcile + 三处门控                   |
| settle          | `src/runtime/session-runtime.ts`                         | settleGraphWork + onGraphWorkSettled 回调                     |
| orphan 恢复接入 | `src/runtime/runtime-run-executor.ts`                    | recoverOrphanGraphWorks(启动恢复序列)                         |
| 续行仲裁        | `src/engine/loop.ts`                                     | graphReconcile callback + [Graph continuation] 注入           |
| 持久化字段      | `src/engine/session-runtime.ts`                          | PersistedSessionSettings.orchestrationMode                    |
| 运行态字段      | `src/input/session-settings.ts`                          | SessionSettings + setSessionOrchestrationMode                 |
| 入口            | `src/input/pico-command-registry.ts` / `src/cli/main.ts` | /graph 命令 + --graph flag                                    |
| 协议层          | `packages/protocol/src/runtime.ts`                       | RuntimeOrchestrationMode + session.settings.update RPC        |
| daemon          | `src/daemon/desktop-runtime-service.ts`                  | wire 投影 + updateRuntimeSessionSettings                      |
| desktop UI      | `apps/desktop/src/renderer/App.tsx`                      | graph toggle + 环境面板显示                                   |

---

## 来源与范围

本文描述 Graph Mode 的当前实现状态(含多轮真实模型测试驱动的修复、对抗审查修正、orphan 恢复接入、显式入口与 desktop app 入口)。行为契约由 `tests/integration/graph-mode-test.ts`(31 条)与 `tests/e2e/graph-mode.real-llm.test.ts` + `graph-mode-multiround.real-llm.test.ts`(9 条真实模型场景)锚定。
