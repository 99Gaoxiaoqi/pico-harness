# Terminal-Bench 2.1（内部）

该目录把 Pico 的内部 Headless One-shot Runner 作为 Harbor 0.20.0 custom installed
agent 运行在 Terminal-Bench 2.1 task container 内。它只用于本地 canary，不是公开
CLI，也不宣称官方 leaderboard parity。

固定版本：

- Harbor `0.20.0`
- Dataset
  `terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`
- 官方源仓 commit `5c8eadf1f393183288fa08b8f73ca9a469cc5e00`
- Node `22.14.0`（下载包 SHA-256 固定在 `pico_agent.py`）

运行默认使用 `~/.pico/config.json` 的默认模型路由，并优先使用其中受保护的凭据，
否则从项目 `.env` 加载该路由声明的凭据环境变量；两者都只在宿主进程内存中解析。
若路由指向本机 loopback 服务，必须显式传
`--docker-host-gateway`，脚本只会把 loopback host 改写为
`host.docker.internal`。

真实凭据不会进入 Harbor/uvx/Compose 的 ambient env、cwd `.env` 或 task container。
运行器先以 unlinked FD 把凭据交给独立 Gateway Supervisor；Harbor 是无凭据的同级进程，
只通过另一个 unlinked FD 获得 supervisor socket 与本次随机 capability seed。每个
trial 在宿主启动独立、固定路由和模型、限时限流的 workload gateway；container
launcher 通过 stdin 只接收绑定 trial 的 HMAC capability，且不会把 capability 留在
子 shell 环境。`npm run benchmark:terminal-bench:check-secret-boundary` 会用恶意
Compose 变量插值验证真实 key 不可见。

发布前后都会扫描完整结果树中真实凭据及全部 trial capability 的 raw、JSON escaped、
URL encoded、Base64/Base64URL、hex、UTF-16 与有界 gzip 形态；命中或扫描超限时删除
该次结果。`PUBLISHED.json` 记录 final scan 后、排除 marker 自身的完整树 hash，并在
atomic marker 写入后复算一致。

```bash
npm run benchmark:terminal-bench:single -- \
  --task terminal-bench/log-summary-date-ranges

npm run benchmark:terminal-bench:canary
```

结果写入：

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

`harbor-job` 是 verifier/reward 的原始事实源；`summary.json` 和
`normalized-result.json` 只做分类投影。结果目录默认忽略，不提交 Git。

首批固定 12 题见 `canary-task-names.txt`；full 模式的固定 89 题 identity matrix
见 `full-task-names.txt`。canary 从本机 Harbor content-addressed cache 按
`canary-task-lock.json` 校验并离线 staging，避免运行中依赖 registry。Harbor 外层保留题目原始 timeout，
Headless 内层预算按 `outer - shutdownGrace(30s) - flushMargin(5s)` 收缩，避免外层
先取消而丢失可信终态。因此结果明确标记为 `localCanaryOnly` /
`leaderboardComparable: false`。官方榜要求 89 题、每题至少 5 trials、不得覆盖
timeout/resource，并公开上传完整 trajectory；当前 Headless v1 没有完整 ATIF tool
trajectory，不满足该条件。
