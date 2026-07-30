# Terminal-Bench 2.1（内部）

该目录把 Pico 的内部 Headless One-shot Runner 作为 Harbor 0.20.0 custom installed
agent 运行在 Terminal-Bench 2.1 task container 内。它只用于本地锁定评测，不是公开
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
运行器通过匿名 pipe 把凭据交给独立 Gateway Supervisor；Harbor 是无凭据的同级进程，
只通过另一个匿名 pipe 获得 supervisor socket、本次 run identity 与随机 root seed。
Supervisor control plane 同时校验同 UID peer credential、run/trial identity、HMAC、
时钟窗与单次 nonce；trial 必须先注册，不能由 proxy 请求自动创建。每个 trial 在宿主
启动独立 workload gateway，通过一次性 stdin enrollment 绑定 task container 的网络
peer identity；container 内只获得无权限含义的固定 SDK 占位值。Supervisor 对固定
route/model/path、TTL、并发、调用次数、input/output token 与最坏价格上限做原子预留，
revoke 会拒绝新请求、关闭在途上游并丢弃迟到响应。
`npm run benchmark:terminal-bench:check-secret-boundary` 会验证恶意 Compose 插值、
pre-start container profile、无 root seed 同 UID 调用、nonce 重放、未注册 trial、
并发超卖、revoke-before-use 与在途 revoke。

发布前后都会扫描完整结果树中真实凭据与 root seed 的 raw、JSON escaped、URL encoded、
Base64/Base64URL、hex、UTF-16，以及有界嵌套 gzip/tar 形态；不支持的压缩归档、命中或
扫描/展开超限都会 fail closed。全部结果先写 `work/` staging，重写内部路径、扫描、计算
完整树 hash、写 sealed marker 并 fsync 后，才原子 rename 到 `runs/`，随后 fsync parent
并复算 hash；启动恢复会把残留 staging 或 marker/hash 不一致的结果移入 `quarantine/`。

```bash
npm run benchmark:terminal-bench:single -- \
  --task terminal-bench/log-summary-date-ranges

npm run benchmark:terminal-bench:canary

node scripts/terminal-bench/run.mjs --mode full --docker-host-gateway
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
`canary-task-lock.json` 校验；full 按 `full-task-lock.json` 从工作区
`output/benchmarks/terminal-bench-2.1/cache/harbor-tasks/packages/` 校验。两种模式均
完整离线 staging，不会回退到远程 dataset；锁文件、缓存或逐题 tree hash 缺失时直接
失败。full 还要求 `full-image-lock.json` 精确覆盖固定 89 题，并锁定
`linux/amd64` 镜像 manifest digest；每题缓存 tree hash 与原始 `docker_image` tag
校验通过并复制到 staging 后，运行器才把 staged `task.toml` 改写为
`repository@sha256:digest`，随后注入隔离网络并审计 Compose。镜像锁缺失、平台、
题集、source tag、digest 或压缩大小不合法时均 fail closed；canary/single 不读取该锁。
Harbor 外层保留题目原始 timeout，
Harbor 自身及其 82 个传递依赖由 `harbor-constraints.txt` 固定，并以 `uvx --offline`
运行；本机 cache 不完整时直接失败，不回退到网络解析。
Headless 内层预算按 `outer - shutdownGrace(30s) - flushMargin(5s)` 收缩，避免外层
先取消而丢失可信终态。因此结果明确标记为 `localCanaryOnly` /
`leaderboardComparable: false`。官方榜要求 89 题、每题至少 5 trials、不得覆盖
timeout/resource，并公开上传完整 trajectory；当前 Headless v1 没有完整 ATIF tool
trajectory，不满足该条件。
