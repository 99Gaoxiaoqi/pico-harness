# syntax=docker/dockerfile:1.7
# =============================================================================
# pico-harness Docker 镜像(多阶段构建)
#
# 关键约束:better-sqlite3 是原生模块(Node addon,需 node-gyp 编译)。
#   - builder 阶段:装 build-essential + python3,跑 npm ci(编译) + tsc 编译 TS
#   - prod 阶段:精简镜像,npm ci --omit=dev 优先下载 better-sqlite3 预编译 binary
#     (Linux x64 / arm64 均有 prebuilt);若目标平台无 prebuilt,见 docs/deployment.md
#     的「better-sqlite3 兜底」小节,在 prod 阶段补装编译工具链。
# =============================================================================

# ---------- builder:编译 TS + 编译/安装全部依赖(含 dev) ----------
FROM node:22-bookworm-slim AS builder

# 原生模块编译工具链:make/g++/python3(node-gyp 三件套)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷锁文件,利用层缓存(node_modules 是最大缓存单位)
COPY package.json package-lock.json* ./
RUN npm ci

# 拷源码后编译 TS -> dist/。
# 注意:.dockerignore 排除了 tests/ 与 vitest.config.ts(运行时不需要),
# tsconfig 的 include 里虽含 tests/**/*.ts,但缺失时 tsc 不会报错(空 glob 静默跳过)。
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


# ---------- deps:仅安装运行时依赖(产 prebuilt binary 的干净 node_modules) ----------
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev 只装运行时依赖;better-sqlite3 会优先尝试 prebuilt binary,
# 失败时回退到本地编译(此时上面的 build-essential 兜底)。
RUN npm ci --omit=dev


# ---------- prod:最终镜像,只带 dist/ + 运行时 node_modules ----------
FROM node:22-bookworm-slim AS prod

# bash:bash 工具依赖;git:Agent 常用版本控制探查;curl:健康检查/调试
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        git \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# 运行时依赖(从 deps 阶段拿干净的 node_modules)
COPY --from=deps /app/node_modules ./node_modules
# 编译产物 + 清单
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# bin 入口(见 package.json: "bin": { "pico": "./dist/cli/main.js" })
ENV NODE_ENV=production
ENV PICO_PERSISTENCE=1

# REST 模式(--serve)默认端口;CLI/feishu/acp 模式不监听此端口,但暴露无害
EXPOSE 3000

# 挂载点:工作区(traces/sessions/.claw 持久化在此)。compose 用 ./workspace:/workspace
VOLUME ["/workspace"]

# 默认 CLI 模式(无参 = README 总结冒烟任务,见 main.ts 兜底分支)。
# 真实使用时由 compose 的 command 或 docker run 的参数覆盖,
# 切换到 --serve / --feishu / --acp 等模式(见 docs/deployment.md)。
ENTRYPOINT ["node", "dist/cli/main.js"]
CMD []
