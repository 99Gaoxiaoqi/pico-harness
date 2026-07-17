# 基础设施与安全层

> 安全底线、审批系统、可观测性、MCP 协议、核心数据结构。

---

## 1. 核心数据结构 (`src/schema/message.ts`)

### Message — 核心传递单元

```ts
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[]; // 模型决定调用工具(支持单轮并行多个)
  toolCallId?: string; // 若本条是工具响应,关联回 ToolCall.id
  usage?: Usage; // 仅模型响应,CostTracker 用
  reasoning?: string; // thinking 摘要
  providerData?: Record<string, unknown>; // Provider 扩展透传
  images?: ImagePart[]; // 多模态
}
```

### Token 五桶模型

```
CanonicalUsage = {
  inputTokens,       // = promptTokens - cacheRead - cacheWrite(避免重复计费)
  outputTokens,      // = completionTokens - reasoning
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
}
```

`toCanonicalUsage()` 把各 Provider 不同口径的 usage 统一成五桶。

---

## 2. 文件历史系统 (`src/safety/`)

文件回滚统一使用 File History v2 的内容寻址快照和持久化 operation journal，不依赖 Git 暂存区，也不存在另一套 Git checkpoint fallback。

```text
建立 rewind point
  └─ 写前捕获每个文件的 preimage
       └─ 发布到 blobs/sha256/<prefix>/<digest>

每轮结束
  └─ 原子更新每 Session 的 v2 manifest（最多 100 个快照）

执行 rewind
  ├─ 预读全部 CAS blob 并校验当前文件指纹
  ├─ journal 发布 prepared operation
  ├─ code/both：恢复 workspace，外部变化时 fail-closed
  ├─ conversation/both：追加幂等 history.rewound RuntimeEvent
  └─ 修剪 File History / Summary sidecar 后将 operation 置为 completed
```

旧版 `backupFileName` 只用于读取和物化 legacy manifest，不是当前权威存储格式。`ContentAddressedBlobGarbageCollector` 与声明式 retention policy 目前保留但未接入生产调度，因此不能假定存在自动全局 GC。

公开交互入口在 TUI 内：`/snapshots` 列出快照，`/rewind` 选择 code / conversation / both。

---

## 3. 审批系统 (`src/approval/`)

### 生产审批链

| 层                        | 文件                              | 说明                                   |
| ------------------------- | --------------------------------- | -------------------------------------- |
| Permission middleware     | `runtime/agent-runtime.ts`        | 模式、安全规则与会话授权判定           |
| Session permission grants | `approval/session-permissions.ts` | 结构化记录当前会话允许的授权范围       |
| ApprovalManager           | `approval/manager.ts`             | Promise 挂起-唤醒（Human-in-the-loop） |

### ApprovalManager

```ts
waitForApproval(taskId, toolName, args, notify, diff?) → Promise<ApprovalResult>
// 返回新 Promise + setTimeout(30分钟超时)
// notify 发审批请求(终端/TUI host)
// resolveApproval(taskId, allowed, reason) 回调流触发
```

`buildPermissionMiddleware` 先执行不可绕过的 hardline、安全边界和运行模式判断，
再检查当前 Session 的结构化授权范围；仍需人工确认时才交给 ApprovalManager。
会话授权不会作为一条独立 Policy 提前短路后续安全检查。

### 危险命令与 YOLO hardline

- **普通危险操作**在非 YOLO 模式仍进入审批策略；YOLO 只有通过 hardline 后才按当前 OS 用户权限直通。
- **YOLO hardline** 是不可审批绕过的纯判定器。它解析 Shell 词、引号、展开、重定向、子 Shell、`eval`、`xargs/find`、常见命令转发器、已知 Shell 组合选项和已审计解释器入口，并传播静态工作目录；系统根、用户根、设备、关机、受保护 Git 远端以及无法证明目标安全的动态破坏操作直接 deny。
- `cd`、wrapper `-C/--chdir/--directory`、子 Shell 和条件分支会更新各自的目录上下文；目录来自动态展开、命令替换或不能静态确定时，后续相对破坏目标 fail-closed。工作区内可静态证明的普通操作仍保留 YOLO 直通语义。
- Pico 自己启动的 Bash 使用 `--noprofile --norc -c`，并移除环境中的 Shell 启动脚本、导出函数和相关调试入口。命令文本内跨语句设置的 `BASH_ENV`、`ENV`、`ZDOTDIR` 与 Bash 导出函数会继续传播到已建模 Shell 调用并 fail-closed。
- 已建模的 POSIX Shell 只有静态 `-c` 文本、静态 no-exec 解析或纯帮助/版本查询可以继续分析；脚本文件、stdin、`source`/`.`、启动文件和环境注入入口直接 fail-closed。语法不兼容的已知 Shell 只允许帮助/版本查询。Python、Node、Perl、Ruby 的内联入口会先解析已审计的前置选项，再保留系统级破坏字面量拒绝底线。
- hardline 不是任意 executable、动态 loader、任意程序自己的配置文件或子进程行为的能力沙箱。它只保证宿主 Shell 启动边界、可见命令文本及已建模入口的拒绝底线；YOLO 主 Agent 的其他程序仍以当前 OS 用户权限执行。
- 判定测试只传入命令文本和临时路径，绝不执行真实删除、设备写入或远端推送。

### diff 预览 (`diff.ts`)

工具执行**前**计算 before/after diff。edit_file 直接取参数；write_file 读原文件；bash 解析重定向目标。**任何异常都吞掉返回 undefined**。

---

## 4. MCP 协议 (`src/mcp/`)

> Model Context Protocol — 外部工具服务器自动注册。

### 三层架构

```
types.ts       协议类型 + McpClient 接口(transport-agnostic)
stdio-client   子进程 stdin/stdout(JSON-RPC 2.0,手写不依赖 SDK)
http-client    HTTP/SSE(fetch + 手写 SSE 行解析)
mcp-tool       McpToolBridge(适配 BaseTool 接口)
manager        McpConnectionManager(连接编排 + 自动注册)
```

### 自动注册流程

```
resolveProjectMcpConfigPath(.pico/mcp.json)
  → validateConfig(结构校验)
  → connectAll(Promise.allSettled 并行连接,per-server 失败隔离)
    → connectAndList:
        client.connect() 握手
        client.listTools() 发现工具
        每个 tool → new McpToolBridge → registry.register
  → closeAll(退出时并行 close)
```

`.pico/mcp.json` 是 Pico 原生配置。旧 `.claw/mcp.json` 只在原生文件不存在时作为只读
兼容输入，所有新建和修改都以 `.pico` 为目标。

### 工具名限定

`mcp__<server>__<tool>`（防多 server 冲突，超 64 字符截断 + FNV-1a 哈希后缀）。

### fail-open

MCP 工具调用失败 → 封装成 isError ToolResult（不抛异常，保持 BaseTool 契约）。

---

## 5. 可观测性 (`src/observability/`)

### Logger (`logger.ts`)

- pino 结构化日志 + pino-pretty 彩色格式化
- 走 stderr（destination=2），stdout 留给 ink TUI
- **限制**：transport 在 worker thread，运行时改 level 无效（TUI 用 preload-env.ts 预加载）

### CostTracker (`tracker.ts`)

装饰器模式——无侵入拦截 Token 消耗：

```
new CostTracker(provider, modelRoute, session)
// 像安检门:数据先经过它,盖时间戳+成本戳,原封不动还回
```

### Tracer (`trace.ts`)

- 借鉴 OpenTelemetry/Jaeger 的 Span 机制
- 三层结构：Root Span(一次 Run) → Turn Span → Leaf Span(Generate/Execute/Compaction)
- 导出 JSON 到 `$PICO_HOME/workspaces/<workspace-id>/traces/`
- 入口：显式 `trace: true` 或环境变量 `PICO_TRACE=1`
- TUI 每轮结束后把 `result.tracePath` 追加为 system message，方便直接打开文件复盘

### Pricing (`pricing.ts`)

- 硬编码官方定价快照（glm-5.2/glm-4.5-air/kimi-k2.5/claude-3-5-sonnet）
- `estimateCost(route, usage)` → costCNY（USD × 7.2）
- subscription 模式全 0

---

## 6. 配置与部署

### 技术栈

| 维度     | 选择                                           |
| -------- | ---------------------------------------------- |
| 语言     | TypeScript ESM, target ES2024, **全开 strict** |
| 运行时   | Node.js 22.x                                   |
| 原生模块 | better-sqlite3（需 node-gyp 编译）             |
| TUI      | ink 7 + React 19                               |
| Desktop  | Electron + React                               |
| 日志     | pino + pino-pretty                             |
| 产品外壳 | `pico` TUI + Pico Desktop                      |

### tsconfig 关键项

- `noUncheckedIndexedAccess`：数组/Map 索引返回 `T | undefined`（强制越界保护）
- `jsx: "react-jsx"`：TUI 支持 .tsx
- `module: NodeNext`：纯 ESM，import 必须带 .js 扩展名

### 当前部署边界

Docker、公开 headless CLI 和远程 Runtime API 不在当前支持范围。TUI 和 Desktop 共享本机
Plugin/Skill/Agent Catalog；周期任务写入本机账本，并由用户级 daemon 在同一安全策略边界内
执行。daemon 不构成远程入口。

daemon 的关闭 API 保持 deadline 有界，但有界返回不等于立即交出所有权：忽略 abort 的 workspace executor 或 worktree runner 会先被冻结为终态，其 TaskHost、RuntimeStore 与进程单例锁继续由 shutdown ownership fence 持有，直到真实执行排空。WorktreeSupervisor 会在 TaskRegistry 发布 pending 前登记 admission gate，关闭快照同时等待准入窗口和已登记 runner，避免同步订阅者重入 close 时漏出任务。

Cron 关闭先停止新 tick 与定时器，再有界等待活动 tick；超时后通过独立 fence 持有 Cron 账本，daemon 同时关闭 service 以传播 abort，最后聚合 Cron 与 service 的释放信号。注销 workspace 时，Cron close 失败会保留 sticky ownership，但后续 reconcile 仍可处理其他 workspace；自定义 runtime 声明 pending 却不提供 release fence 时显式 fail-closed。start/stop 串行化；daemon、Cron、service、runner 或 fence 无法证明安全关闭时保留锁而不是允许新 daemon 重叠。若执行永不结束，活进程持续持锁；进程退出后才由 PID stale recovery 接管。

### 环境变量

- `PICO_HOME`（用户状态根，默认 `~/.pico`）
- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（兼容环境配置入口）
- `LLM_API_KEYS`（复数，逗号分隔，429 自动轮换）
- `AUX_LLM_*`（辅助廉价模型，FullCompactor 用）
- `PICO_TRACE=1`（每轮导出 trace JSON）
- `LOG_LEVEL`（默认 info）
- `SEARCH_API_BASE` / `SEARCH_API_KEY`（WebSearch）

---

## 关键架构洞察

1. **零外部协议依赖**：手写 JSON-RPC over stdio、手写 SSE 行解析、不用 @modelcontextprotocol/sdk
2. **装饰器/AOP 贯穿**：CostTracker（计费）、McpToolBridge（工具适配）、ApprovalManager（Promise 挂起）
3. **单一 Rewind 路径**：File History CAS + operation journal，三种 rewind mode 在 Session 层组合
4. **两层审批**：`buildPermissionMiddleware` 负责安全判定与会话授权，ApprovalManager 负责挂起和唤醒人工审批
5. **严格类型安全**：全开 strict + noUncheckedIndexedAccess，边界值必须显式校验或提供安全默认值
