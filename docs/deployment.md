# Docker 部署

pico-harness 支持通过 Docker 镜像一键部署。镜像基于 `node:22-bookworm-slim`,采用**多阶段构建**把编译期(原生模块 + TS 编译)与运行期(精简依赖)分离,最终镜像只带 `dist/` + 运行时 `node_modules`。

---

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| Docker | ≥ 20.10(支持 BuildKit `# syntax=docker/dockerfile:1`) |
| Docker Compose | v2(`docker compose` 子命令) |
| Node(仅本地开发需要) | ≥ 22,镜像内自带 |

镜像架构默认 `linux/amd64`;`linux/arm64` 同样支持(`node:22` + `better-sqlite3` 均有 prebuilt)。

---

## 2. 环境变量

`.env` 文件(由 `.env.example` 拷贝而来)在**运行时**通过 `env_file` 注入,**绝不打包进镜像**。

### 2.1 LLM(必填)

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `LLM_BASE_URL` | OpenAI 兼容端点 或 Claude 端点 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | 单个 API Key | `sk-...` |
| `LLM_API_KEYS` | 多凭证轮换(逗号分隔,可选;429 限流时自动切换) | `sk-a,sk-b,sk-c` |
| `LLM_MODEL` | 模型名,需与端点一致 | `glm-5.2` |

### 2.2 飞书机器人(仅 `--feishu` 模式)

| 变量 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` | 飞书开放平台应用 ID |
| `FEISHU_APP_SECRET` | 应用 Secret |
| `FEISHU_ENCRYPT_KEY` | 事件订阅加密 Key(可选) |
| `FEISHU_VERIFY_TOKEN` | 事件订阅校验 Token(可选) |
| `FEISHU_PORT` | HTTP 回调端口(可选,WSClient 长连接模式不需要) |

### 2.3 搜索 API(可选,`web_search` 工具需要)

| 变量 | 说明 |
| --- | --- |
| `SEARCH_API_BASE` | 搜索服务端点 |
| `SEARCH_API_KEY` | 搜索服务凭证 |

### 2.4 引擎运行时

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PICO_PERSISTENCE` | `1`(开启) | Session 持久化开关。设 `0` 关闭 `wire.jsonl` 落盘 |
| `PICO_SHELL_PATH` | 自动探测 | 覆盖 bash 工具使用的 shell 路径 |
| `LOG_LEVEL` | `info` | 日志级别:`debug` / `info` / `warn` / `error` |
| `NODE_ENV` | `production`(镜像内设死) | Node 运行模式 |

> 完整 key 清单见 `.env.example`;源码内还涉及 `process.env.NODE_ENV` / `process.env.PATH` / `process.env.LOCALAPPDATA` 等 Node 自身变量,无需显式配置。

---

## 3. 构建镜像

```bash
docker build -t pico-harness:latest .
```

或用 npm 脚本(见 §7):

```bash
npm run docker:build
```

构建过程:

1. **builder 阶段**:装 `python3 / make / g++`(node-gyp 三件套),`npm ci` 装全量依赖并编译 `better-sqlite3` 原生模块,再 `tsc` 编译 `src/` → `dist/`。
2. **deps 阶段**:`npm ci --omit=dev` 装运行时依赖(`better-sqlite3` 优先取 prebuilt binary)。
3. **prod 阶段**:拷 `dist/` + 运行时 `node_modules` + `package.json`,装 `bash / git / curl`。

镜像入口:`node dist/cli/main.js`(对齐 `package.json` 的 `bin: { "pico": "./dist/cli/main.js" }`)。

---

## 4. 用 docker compose 运行

### 4.1 准备配置

```bash
cp .env.example .env
# 编辑 .env,至少填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
mkdir -p workspace          # 工作区挂载点(Agent 的文件操作根目录)
```

### 4.2 CLI 模式(默认,一次性任务)

```bash
# docker-compose.yml 默认未设 command,即 CLI 模式
docker compose run --rm pico "用 read_file 读取 README.md 并总结"
```

`-it` 由 `stdin_open: true` + `tty: true` 提供;`--rm` 跑完即删容器。

### 4.3 REST + WebSocket 模式(常驻服务)

编辑 `docker-compose.yml`,取消注释:

```yaml
command: ["--serve", "--port", "3000"]
```

然后:

```bash
docker compose up -d
# 测试
curl -X POST localhost:3000/sessions
```

REST 端点矩阵(`POST /sessions`、`GET /sessions/:id`、`POST /sessions/:id/messages`、`POST /approvals/:taskId`、`GET /tools`)及 WebSocket(`ws://localhost:3000/?sessionId=...`)详见 `src/server/`。

### 4.4 飞书模式(长连接)

```bash
docker compose run --rm pico --feishu --plan --trace
```

(需在 `.env` 配齐 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。)

### 4.5 ACP 模式(stdio,供 IDE 驱动)

```bash
docker compose run --rm -i pico --acp --mode default
```

IDE(VSCode 插件等)通过 stdin/stdout 收发 ACP JSON-RPC 消息。

---

## 5. 用纯 docker 命令运行

```bash
# CLI 模式
docker run -it --rm \
  -v "$(pwd)/workspace:/workspace" \
  --env-file .env \
  -w /workspace \
  pico-harness:latest "你的任务"

# REST 模式
docker run -d --name pico-serve \
  -p 3000:3000 \
  -v "$(pwd)/workspace:/workspace" \
  --env-file .env \
  pico-harness:latest --serve --port 3000
```

---

## 6. 卷挂载(工作区持久化)

容器 `WORKDIR` 为 `/workspace`,且 `VOLUME /workspace`。`docker-compose.yml` 默认把宿主机 `./workspace` 挂入 `/workspace`:

| 容器路径 | 内容 | 持久化 |
| --- | --- | --- |
| `/workspace` | Agent 的文件操作根目录(读/写/编辑/bash 的 CWD) | ✅ 挂载 |
| `/workspace/.claw/sessions/` | Session 持久化(`wire.jsonl`) | ✅ 挂载 |
| `/workspace/.claw/traces/` | 链路追踪 JSON | ✅ 挂载 |
| `/workspace/.claw/permissions/` | 中间件审批状态 | ✅ 挂载 |
| `/workspace/.claw/artifacts/` | ToolResult 离线产物 | ✅ 挂载 |

> 改 `PICO_PERSISTENCE=0` 可关闭 Session 落盘(纯无状态跑批场景)。

---

## 7. npm 脚本(可选便捷入口)

`package.json` 内新增:

```jsonc
"docker:build": "docker build -t pico-harness .",
"docker:run": "docker run -it --rm -v $(pwd):/workspace --env-file .env pico-harness"
```

```bash
npm run docker:build
npm run docker:run -- "你的任务"
```

> ⚠️ `docker:run` 里的 `$(pwd)` 在 PowerShell 需改为 `${PWD}`,或直接用 §4 的 compose 方式(跨 shell 一致)。

---

## 8. better-sqlite3 原生模块注意事项

`better-sqlite3` 是 Node 原生 addon(N-API + node-gyp 编译),是镜像构建的主要复杂度来源。

### 8.1 预编译 binary(默认路径)

`linux/amd64` 与 `linux/arm64` 在 [better-sqlite3 官方](https://github.com/WiseLibs/better-sqlite3/releases) 都提供了 prebuilt binary。prod 阶段 `npm ci --omit=dev` 会**自动下载 prebuilt**,无需编译。镜像因此能保持精简。

### 8.2 兜底:目标平台无 prebuilt

若你在非常规平台(如 `linux/ppc64le`)构建,或 prebuilt 下载失败(离线环境),`npm ci` 会回退到本地编译。本镜像的 **deps 阶段已预装 `python3 / make / g++`**,因此 fallback 编译也能成功——代价是镜像体积变大(编译工具链不进最终镜像,但 `node_modules/better-sqlite3/build` 会带上编译产物)。

### 8.3 极致精简镜像(可选)

若确认目标平台 prebuilt 可用且想极致缩小镜像,可把 deps 阶段的工具链去掉:

```dockerfile
# deps 阶段去掉 python3/make/g++,纯靠 prebuilt
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
```

风险:prebuilt 下载失败时构建直接挂。**默认配置(保留工具链)更稳,推荐保留。**

### 8.4 跨平台构建(`docker buildx`)

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t pico-harness:latest . --push
```

`better-sqlite3` 在每个目标平台都会拉对应 prebuilt,无需交叉编译器。

---

## 9. 排障速查

| 症状 | 排查 |
| --- | --- |
| 启动报 `Cannot find module ... better-sqlite3` | deps 阶段 prebuilt 下载失败且无工具链。保留 §8.2 的 `python3/make/g++`,或 `npm rebuild better-sqlite3` |
| 容器内 LLM 请求超时 | 宿主机端点用 `host.docker.internal`(compose 已配 `extra_hosts`)。Linux 原生 Docker 需确认 `host-gateway` 可解析 |
| Agent 写的文件在宿主机看不到 | 确认 `-v` 挂载路径正确,且 `working_dir` / `--dir` 指向 `/workspace` |
| 端口 3000 占用 | 改 compose 的 `ports: ["3001:3000"]`,或 CLI 模式不映射 |
| `.env` 改了不生效 | compose 用 `env_file`,**改完需 `docker compose down && up`**(run 命令每次重读,无需) |
