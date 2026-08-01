# 第 10 章 · 怎么知道它变聪明了

Agent 能完成一次任务，不等于我们已经知道它“变聪明了”。模型输出有随机性，工作区会
变化，工具可能失败，评测环境本身也可能出错。要比较两个版本，至少要先回答三个问题：

1. 能否用机器可判定的合约启动一次完整 Runtime？
2. 能否把任务失败与基础设施、适配器、Verifier 失败分开？
3. 能否证明结果来自固定代码、固定题目和完整证据，而不是一段终端故事？

pico-harness 当前用两层内部设施回答这些问题：

- [Headless One-shot Runner](internal-headless-one-shot.md) 把共享 Runtime 适配成严格的
  单请求机器入口。
- [Terminal-Bench 2.1 本地 canary](../benchmarks/terminal_bench_2_1/README.md) 把该入口
  装进 Harbor 的 task container，使用题目自带的 Verifier 判分并保存证据。

它们服务于仓库内 benchmark、可靠性测试和封闭评估，不是公开产品入口。

---

## 第一层：让一次运行可以被机器判定

公开的根命令 `pico` 当前启动 TUI。评测不能依赖交互界面，也不能靠抓取彩色终端文本
猜测是否完成，因此仓库提供了内部 Headless One-shot Runner：

```text
严格 JSON 与工具预检
  → 非交互工作区信任
  → 精确模型路由
  → PICO_HOME / workspace / Session 独占租约
  → executeAgentRuntime
  → 单行 JSON 终态
```

关键点是它复用 [`executeAgentRuntime`](../src/runtime/agent-runtime.ts)，而不是另建一套
“评测版 Engine”。Provider、工具、安全门禁、Session 和运行事件仍走产品 Runtime；
[`headless-one-shot-runner.ts`](../src/internal/headless-one-shot-runner.ts) 只负责严格
输入、隔离、生命周期和结果投影。

### 一个最小请求

开发态可以从 stdin 传入一个 `schemaVersion: 1` JSON 对象：

```bash
npm run --silent internal:headless:dev <<'JSON'
{
  "schemaVersion": 1,
  "requestId": "case-001",
  "workspacePath": "/absolute/path/to/workspace-copy",
  "picoHome": "/absolute/path/to/exclusive-pico-home",
  "sessionId": "eval-case-001",
  "prompt": "Inspect the repository and summarize the result.",
  "modelRouteId": "provider-id/model-id",
  "permissionMode": "plan",
  "allowedTools": ["read_file", "grep"],
  "timeoutMs": 2700000,
  "shutdownGraceMs": 10000,
  "trace": true
}
JSON
```

构建后的机器调用应直接执行入口并保留退出码：

```bash
npm run build
node dist/internal/headless-one-shot-main.js < request.json
```

请求必须显式固定模型路由、权限模式、工具白名单、超时和 Trace 开关。它不接受 API Key、
`baseURL`、resume、continue 或 fork 等字段，未知字段会在模型调用前拒绝。工作区和
`PICO_HOME` 必须是互不包含的真实绝对目录；调用方还要预先在隔离的
`PICO_HOME/trusted-workspaces.json` 中记录该工作区。

### 终态不是一句“成功了”

Runner 的 stdout 始终只输出一行 JSON。核心字段包括：

- `status`：`completed`、`invalid_request`、`failed`、`policy_blocked`、
  `timed_out` 或 `canceled`。
- `usage` 与 `durationMs`：本次运行的用量投影和耗时。
- `effective`：实际模型路由、thinking、权限模式和工具白名单。
- `error`：稳定错误码与脱敏摘要，不包含 stack、完整消息或原始 ToolResult。
- `terminationConfirmed`：Runtime 与工具是否已在宽限期内真正停止。

`completed` 只说明 Runtime 正常给出终态，不代表外部任务已经通过 Verifier。
`terminationConfirmed: false` 也不能被当成普通超时：它意味着仍无法证明外部副作用已经
停止，评测层必须把它归为基础设施错误。

为了让并发 case 不共享状态，Runner 要求独占 `PICO_HOME`、独立 workspace
copy/worktree 和唯一的新 Session ID。同机并发还会取得三项 owner lease；冲突时
fail-closed。Trace 在属性进入内存 Span 时就执行 metadata-only 脱敏，并在落盘后再次
净化，但这仍不把 Runner 变成 OS 沙箱。尤其是 `yolo` 模式，权限边界仍然是当前 OS
用户；评测调度器必须另行提供一次性低权限账户或容器。

### 它能保证什么

固定 prompt、代码版本、模型 route、thinking、权限、工具白名单和配置快照，可以让输入
和状态归属可追溯。它不能保证同一模型的最终文本逐字一致，也不能只凭一次运行证明质量
提升。这就是为什么还需要第二层：外部题目和独立 Verifier。

---

## 第二层：Terminal-Bench 2.1 本地 canary

仓库中的 Terminal-Bench 适配器通过 Harbor `0.20.0` custom installed agent，把 Pico
安装到 Terminal-Bench 2.1 task container，再由题目自己的 Verifier 产生 reward。数据集
引用、官方源 commit、Harbor 依赖、Node 运行时和 canary 题目清单都有固定身份。

当前入口只有本地 single/canary：

```bash
# 先跑一题，验证环境与路由
npm run benchmark:terminal-bench:single -- \
  --task terminal-bench/log-summary-date-ranges

# 跑固定的 12 题 canary
npm run benchmark:terminal-bench:canary
```

运行前需要干净的 Pico worktree、Docker、完整的本机 Harbor 离线缓存，以及
`~/.pico/config.json` 中可用的默认模型路由和凭据。脚本会拒绝 dirty worktree。默认命令
带 `--docker-host-gateway`；只有配置的 Provider 指向本机 loopback 服务时才需要这层
地址改写。

一次 canary 的主流程是：

1. 校验代码、题目清单、数据集缓存、Harbor wheelhouse 和固定依赖。
2. 构建当前 commit 的 Pico bundle，为每个 trial 准备隔离的执行身份。
3. Harbor 创建 task container，installed agent 在容器里调用 Headless Runner。
4. 题目 Verifier 运行并生成原始 reward 与 CTRF 证据。
5. Normalizer 将 Runtime、Gateway accounting 和 Verifier 证据分类投影。
6. 安全与完整性门禁通过后，结果才从 staging 原子发布到 `runs/`。

模型真实凭据不会作为 Harbor、Compose 或 task container 的 ambient env 注入。宿主上的
Gateway Supervisor 通过按 run/trial 绑定的一次性能力转发固定 route，并执行 TTL、并发、
调用次数、Token 和最坏成本上限。发布前后还会扫描结果树中的多种凭据编码与有界嵌套
归档；命中、无法支持的归档或扫描超限都会 fail-closed。

这些措施保护的是当前评测适配边界，不应被外推成“任意 Docker 任务都已安全”。

---

## 结果：先看证据，再算通过率

成功发布的本地结果位于：

```text
output/benchmarks/terminal-bench-2.1/runs/<run-id>/
  manifest.json
  summary.json
  source-hashes.json
  run-status.json
  PUBLISHED.json
  harbor-job/job/
  cases/<task>/<trial>/
```

阅读顺序建议如下：

1. `manifest.json`：确认 Pico commit、bundle hash、模型 route、固定版本、任务数和执行
   策略。`localCanaryOnly: true` 与 `leaderboardComparable: false` 是当前硬边界。
2. `harbor-job/job/`：Harbor 的原始任务、Verifier 和 reward 事实源。
3. `cases/.../normalized-result.json`：查看单个 trial 的基础设施、适配器、Agent、
   accounting、Verifier 和 reward 分类。
4. `summary.json`：只有在 `sealed: true` 时，才说明预期 trial 矩阵、唯一身份、
   基础设施/适配器/Verifier 门禁和原始结果树都完整，可据此汇总。
5. `source-hashes.json` 与 `PUBLISHED.json`：核对源证据 hash、发布扫描和最终结果树
   完整性。

Normalizer 不把所有非通过都叫做“模型失败”。`primaryStatus` 会区分：

| 类别                                               | 含义                                           |
| -------------------------------------------------- | ---------------------------------------------- |
| `passed`                                           | Agent 完成，Verifier reward 通过               |
| `task_failed`                                      | Agent 完成，但 Verifier 没有判定任务通过       |
| `agent_timeout` / `agent_canceled` / `agent_error` | Runtime 超时、取消或执行失败                   |
| `policy_blocked`                                   | 有效权限或安全策略阻止了必要动作               |
| `infra_error`                                      | 隔离、终止确认或 Harbor 基础设施异常           |
| `adapter_error`                                    | Headless 协议、状态/退出码或 accounting 不一致 |
| `verifier_error`                                   | Verifier 未完成或证据无效                      |

因此，`headlessCompleted` 不是通过数；一个 trial 可以正常完成 Runtime，最终仍是
`task_failed`。`policyIncident` 与 `primaryStatus` 是正交维度：已完成 trial 即使记录了策略
拒绝，也按 Verifier 投影为 `passed` 或 `task_failed`；只有策略实际阻断运行而未完成时才是
`policy_blocked`。策略事件计数、原因分类和 clean 指标仍会完整保留。`PUBLISHED.json` 证明
结果经过本地发布门禁，不证明模型质量优秀。

只有在 run 已 sealed、任务与 attempts 一致、模型和策略可比时，通过率
`passed / scheduled` 才有解释价值。Token 和成本比较应优先使用 Gateway accounting
receipt 的实际值，并同时报告 route、pricing hash、attempt 数与失败分类；不要把基础设施
失败混进模型能力结论。

---

## 验证分层

评测设施本身也需要被评测。当前可按成本从低到高验证：

```bash
# 无真实模型：验证 Headless、Normalizer、容器策略和发布边界等确定性行为
npm run test:integration

# 有 Docker，但不需要把真实凭据交给 Harbor：验证凭据与 Gateway 边界
npm run benchmark:terminal-bench:check-secret-boundary

# 有 Docker、固定缓存和真实模型路由：验证一题或 12 题本地闭环
npm run benchmark:terminal-bench:single -- \
  --task terminal-bench/log-summary-date-ranges
npm run benchmark:terminal-bench:canary
```

第一层适合代码回归门禁；第二层聚焦凭据隔离和撤销/预算协议；第三层才产生模型行为数据。
真实 canary 受 Provider、网络、Docker 和本机缓存影响，不应伪装成无凭据 CI 的确定性
测试。

---

## 当前没有哪些承诺

早期课程草稿曾把若干设想写成已存在能力，当前必须明确收回：

- 没有公开的 positional `pico "任务"` one-shot，也没有公开的 `pico run`。
- 没有 `pico --serve`、公开 HTTP/REST 入口或飞书 AgentOps 产品入口。
- 没有通用的 `src/eval/benchmark.ts` Benchmark Runner；当前评测链就是内部 Headless
  适配器与已跟踪的 Terminal-Bench 脚本。
- 当前 full 模式被脚本禁用。固定 89 题清单只是 identity matrix；官方榜还要求每题至少
  5 trials、不覆盖 timeout/resource，并公开完整 trajectory。
- Headless v1 没有完整 ATIF tool trajectory，因此本地 canary 不具备官方 leaderboard
  parity，也不应把未经保存的历史成绩故事当成证据。

评测真正带来的不是一个漂亮百分比，而是一条可以追问的证据链：**输入是否固定，运行
是否隔离，终态是否可信，Verifier 是否完成，结果是否完整，比较边界是否一致。** 先把
这些问题答清楚，版本之间的“变聪明了”才是可检验的工程结论。

[回到课程起点：为什么自己写？](00-why.md)
