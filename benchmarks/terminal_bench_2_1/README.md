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

真实凭据不会经过 Harbor `--agent-env`。adapter 只接受 Harbor 0.20.0 的 Docker
backend，通过固定 `docker compose exec` argv 的 stdin 帧把凭据交给容器内 launcher；
PICO_HOME 只保存固定的 `PICO_TB_PROVIDER_API_KEY` 引用。运行后会扫描完整结果树的
raw、JSON escaped、URL encoded 与 Base64 形态，命中时阻止归一化和发布。

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
  harbor-job/job/
  cases/<task>/<trial>/
```

`harbor-job` 是 verifier/reward 的原始事实源；`summary.json` 和
`normalized-result.json` 只做分类投影。结果目录默认忽略，不提交 Git。

首批固定 12 题见 `canary-task-names.txt`。Harbor 外层保留题目原始 timeout，
Headless 内层预算按 `outer - shutdownGrace(30s) - flushMargin(5s)` 收缩，避免外层
先取消而丢失可信终态。因此结果明确标记为 `localCanaryOnly` /
`leaderboardComparable: false`。官方榜要求 89 题、每题至少 5 trials、不得覆盖
timeout/resource，并公开上传完整 trajectory；当前 Headless v1 没有完整 ATIF tool
trajectory，不满足该条件。
