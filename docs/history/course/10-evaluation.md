# 第 10 章 · 用可复查的评测判断改动

> 当前实现教程：按代码 `0092022f`（2026-09-21）重写。保留原路径以兼容已有链接；概念伪代码不作为公开 API。

Agent 完成一次任务，并不能证明新版本更可靠。模型输出有随机性，工具可能失败，评测容器也可能没有准备好。若把这些情况都合成一个通过率，数字看起来简单，却无法解释改动到底影响了什么。

Pico 当前用两层内部设施组织评测：Headless One-shot Runner 把共享 Runtime 变成严格的机器入口；Terminal-Bench 适配器把它装进 Harbor 的任务容器，由题目自己的 verifier 判分。前者提供可信终态，后者提供独立的任务判断。两者都服务于仓库内测试与评估，不是公开 CLI/API。

## 第一层：固定一次运行的输入和归属

[Headless Runner](../../../packages/pico-host/src/internal/headless-one-shot-runner.ts) 复用 `executeAgentRuntime`，不另造“评测版 Engine”。模型、工具、安全门和持久运行仍走产品实现；适配层负责严格输入、非交互预检、隔离租约、超时与输出协议。

```mermaid
flowchart LR
    A[单个 JSON 请求] --> B[schema / 工具 / 路径预检]
    B --> C[工作区信任与精确模型路由]
    C --> D[获取独占 owner leases]
    D --> E[共享 AgentRuntime]
    E --> F[停止确认与 Trace 净化]
    F --> G[单行 JSON 终态]
```

当前协议只接受 `schemaVersion: 2`。协作方式与权限分别由 `collaborationMode` 和 `permissionMode` 表达：前者为 agent/plan，后者为 ask/auto/full-access。旧的 `permissionMode: "plan"` 或 `yolo` 不属于现行请求契约。

下面是请求模板，需要先把路径与模型路由替换为真实配置。路径必须是已存在、互不包含的绝对真实目录，模型与工作区信任也必须提前在独占 Pico home 中配置好，不能直接照抄占位值运行：

```json
{
  "schemaVersion": 2,
  "requestId": "case-001",
  "workspacePath": "/absolute/path/to/workspace-copy",
  "picoHome": "/absolute/path/to/exclusive-pico-home",
  "sessionId": "eval-case-001",
  "prompt": "Inspect the repository and summarize the result.",
  "modelRouteId": "provider-id/model-id",
  "collaborationMode": "plan",
  "permissionMode": "ask",
  "allowedTools": ["read_file", "grep"],
  "timeoutMs": 2700000,
  "shutdownGraceMs": 10000,
  "trace": true
}
```

准备为 `request.json` 后，在仓库根目录调用：

```bash
npm run --silent internal:headless:dev < request.json
```

自动化需要精确保留退出码时，可以先构建，再直接运行机器入口：

```bash
npm run build
node dist/internal/headless-one-shot-main.js < request.json
```

`--silent` 避免 npm 把 lifecycle 标题写入 stdout。机器入口在动态加载 Runtime 前静默内部日志，stdout 只输出一行 JSON。完整准备要求见 [内部 Headless 指南](../../guides/internal-headless-one-shot.md)。

## 严格输入减少的是评测噪声

Runner 拒绝未知字段，不从请求接受 apiKey、baseURL、resume、continue 或 fork。模型只从独占 Pico home 的用户模型目录精确解析；请求不能偷偷绕到另一个 Provider。thinking 可以显式固定，不支持的档位在模型调用前失败。

Runtime 使用隔离 HOME/XDG 根与空 Plugin 快照，不加载普通宿主或项目的 Plugin、Skill、MCP、Hook、Memory 等资源。每个 case 使用独占 Pico home、独立 workspace copy/worktree 和新的 Session ID，并取得 Pico home、workspace、Session 三项 owner lease；冲突时拒绝执行。

这样可以避免一题继承另一题的历史或本机个性化配置。但这些约束仍不是 OS 沙箱。特别是 `full-access`，普通权限链按当前 OS 用户权限直通；外层评测应提供容器或低权限隔离环境。无 UI 的审批请求立即拒绝，不能期待后台任务一直等人点击按钮。

## Runtime completed 不等于题目 passed

结果包含 status、usage、durationMs、effective、error、terminationConfirmed 等字段。effective 记录实际采用的 route、thinking、协作方式、权限与工具名单，不能只把原请求复制一遍当成执行事实。

| status            | 常见退出码 | 含义                                  |
| ----------------- | ---------- | ------------------------------------- |
| `completed`       | 0          | Runtime 正常结束                      |
| `invalid_request` | 2          | 请求、信任、路由或 Session 等预检失败 |
| `failed`          | 3          | Runtime 执行失败                      |
| `policy_blocked`  | 4          | 有效策略阻断执行                      |
| `timed_out`       | 124        | deadline 到期                         |
| `canceled`        | 130 / 143  | 取消或信号终止                        |

`terminationConfirmed` 必须单独检查。Runner 在 shutdownGraceMs 内无法确认 Runtime 和工具已停止时，会保留超时或取消状态，同时输出 `SHUTDOWN_UNCONFIRMED`。不能因为 JSON 已返回，就认定所有外部副作用已经结束。进程内调用继续持有租约直到 Runtime 真正 settle；外层仍需要独立 hard deadline。

Trace 使用 metadata-only 策略，在属性进入内存时替换字符串，并在落盘后补充净化。失败结果只暴露稳定错误码与脱敏摘要，不把原始 Messages、stack 或 ToolResult 塞进机器错误字段。

## 第二层：让题目自己的 verifier 判分

[Terminal-Bench 适配器](../../../benchmarks/terminal_bench_2_1/README.md) 使用固定的 Harbor 版本、数据集身份、题目锁和运行时安装协议。Harbor 创建 task container，Pico installed agent 在其中调用 Headless，题目 verifier 再生成 reward 和相应证据。

当前支持四种模式：

| 模式          | 选择范围                                               |
| ------------- | ------------------------------------------------------ |
| `single`      | 固定题集中的指定单题                                   |
| `canary`      | 固定 12 题 canary                                      |
| `cached-full` | 完整 89 题锁中的本机精确镜像缓存子集，也可指定精确任务 |
| `full`        | 固定 89 题                                             |

full 已是有效模式，不能再写成“尚未启用”。cached-full 也不是临时下载后随便挑题：它要求完整任务和镜像锁，核对精确 linux/amd64 digest，只选择已缓存的镜像，并把选择与排除清单保存为证据。指定任务缺少锁或缓存时整体失败，不悄悄缩小用户要求的范围。

以下命令会运行真实评测，需要 Docker、要求的离线缓存、干净代码工作区和可用模型路由，并会产生模型费用；应在这些条件已准备好且预算明确时运行：

```bash
npm run benchmark:terminal-bench:single -- \
  --task terminal-bench/log-summary-date-ranges

npm run benchmark:terminal-bench:canary

node scripts/terminal-bench/run.mjs --mode cached-full --docker-host-gateway \
  --concurrency 1 --max-run-cost-cny 250

node scripts/terminal-bench/run.mjs --mode full --docker-host-gateway \
  --concurrency 1 --max-run-cost-cny 1200
```

预算值是显式运行配置示例，不是完成全部题目的费用预测。默认 run 总模型预算为 250 CNY；调整 run 预算不解除每个 trial 的独立限制。实际模式与预检实现见 [run.mjs](../../../scripts/terminal-bench/run.mjs)。

## 凭据、网络与费用也属于实验条件

真实模型凭据只在宿主侧解析，通过匿名 pipe 交给 Gateway Supervisor，不作为 Harbor、Compose 或任务容器的 ambient 环境变量注入。每个 trial 通过宿主管理的 gateway 访问固定 route，受到身份、TTL、并发、调用次数、Token 和最坏成本限制；撤销会阻止新请求并处理在途请求。

题目公网访问与模型网关分开管理。task.toml 必须明确声明是否允许互联网，符合条件时才启用本 trial 的受限出口；agent 与 verifier 使用独立出口身份，进入 verifier 阶段时才按生命周期启用后者。不能将“模型能够联网”理解为题目容器默认可访问任意公网和宿主网络。

Runner 对 Harbor 固定关闭自动重试，避免适配器异常触发整题重跑后丢掉先前费用和失败证据。基础设施失败仍要保存；否则“只统计最后成功的一次”会同时扭曲通过率和成本。

## 发布结果前，先确认结果完整

成功发布的结果目录为：

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

原始 Harbor/verifier 结果是事实源，normalized-result 和 summary 是分类投影。发布流程先在 staging 中检查完整性、扫描凭据和受支持归档、生成 hash 与 sealed 标记，再原子发布到 runs；不完整或扫描失败的结果不能当成正常报告。

阅读时先确认 manifest 中的代码 commit、bundle、route、题集、attempts 和策略，再检查 raw verifier 证据，最后看 summary。`sealed: true` 表示预期 trial 矩阵与相关门禁满足完整性要求，不表示模型成绩优秀；`PUBLISHED.json` 也不是质量认证。

Normalizer 区分 passed、task_failed、agent_timeout、agent_canceled、agent_error、policy_blocked、infra_error、adapter_error 和 verifier_error。策略拒绝事件与最终成绩是正交维度：一个任务发生过可恢复的拒绝，最终仍可能由 verifier 判定通过。反之，Runtime 正常完成而 verifier 不通过，应该是 task_failed，不能算成功。

## 比较版本时，分母和边界都要固定

只有题集、attempt 数、模型路由、资源策略和完整性条件可比时，`passed / scheduled` 才有解释价值。cached-full 的子集必须报告实际选择清单，不能与 full 的 89 题比例直接对比。费用优先使用 gateway accounting receipt 的实际记录，并保留价格、路由与失败分类；供应商账单仍是最终对账依据。

当前本地运行仍标为 `localCanaryOnly` 与 `leaderboardComparable: false`，包括运行 full 题集的情况。跑齐题目不自动满足官方榜的 trials、timeout/resource 和完整 trajectory 要求。Headless v2 的严格终态也不等于完整 ATIF 工具轨迹。

可复现的含义是输入、代码与证据可追溯，不是模型每次生成相同字符串。一次成功可以验证主路径；要声称成功率或质量提升，需要预先固定比较条件并运行足够的重复实验，而不是挑选最顺的一段终端输出。

## 验证评测设施本身

先用不需要真实模型的集成测试确认协议、分类和题集选择：

```bash
npm run build:packages
node --import tsx --import @pico/cli/tui/preload-env --test --test-concurrency=1 \
  tests/integration/runtime/headless-one-shot-runner.test.ts \
  tests/integration/engineering/terminal-bench-normalizer.test.ts \
  tests/integration/engineering/terminal-bench-task-selection.test.ts
```

准备好 Docker 后，可另行验证 Gateway 和凭据隔离：

```bash
npm run benchmark:terminal-bench:check-secret-boundary
```

这些命令是当前验证入口，不表示本文已经运行并通过它们。确定性测试验证设施契约，secret-boundary 检查聚焦安全适配，真实 single/canary/full 才产生模型行为数据。三者的失败含义和执行成本不同，应分别报告。

走到这里，Harness 的教学闭环不再停留在“模型能回答问题”：我们能固定输入，执行工具，恢复状态，核对边界，检查成本，并用独立证据判断任务结果。下一次改变提示词、模型或压缩策略时，就可以把“似乎更好”变成可重复检查的问题。

[回到课程起点：为什么自己写？](00-why.md)
