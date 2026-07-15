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

文件回滚统一使用 `file-history.ts` 的 copyFile/CAS 快照与持久化 operation journal，
不依赖 Git 暂存区，也不存在另一套 Git checkpoint fallback。

### 纯 copyFile 机制（三步）

```
① trackEdit (写操作前,loop.ts 经 registry.setPreWriteHook 调用)
   ├─ 按 messageId 分组(每 turn 清空 pending)
   ├─ 每文件每 turn 只 track 一次(多次写同文件只备份第一次)
   └─ createBackup: copyFile + chmod 保留权限
       └─ 文件不存在 → backupFileName: null(回滚时删除)

② makeSnapshot (每轮 turn 结束,loop.ts finally 块)
   ├─ 遍历所有 trackedFiles
   ├─ mtime+size 没变 → 复用旧备份(不重复 copy)
   ├─ 变了 → 新建 backup(version++)
   └─ 快照数上限 100,超限删最旧 + cleanupExclusiveBackups

③ rewind (三轴可选)
   ├─ code: fileHistoryRewind(messageId) → 只恢复文件
   ├─ conversation: rewindTo(messageIndex) → 只截断对话
   └─ both: 先恢复文件再截断对话
```

### 备份路径

`$PICO_HOME/file-history/<sha256(sessionId)[:32]>/<sha256(filePath)[:16]>@v<N>`（默认位于 `~/.pico`）

### 持久化

`manifest.json` 原子写（先写 .tmp 再 rename，防崩溃损坏）。

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

### 危险命令两层正则

- **DANGEROUS_PATTERNS**（需审批）：rm/find -delete/sudo/drop/truncate/mkfs/dd/chmod 777/git push --force...
- **HARDLINE_PATTERNS**（不可逆，直接 deny）：`rm -rf /`、`mkfs /dev/`、`dd of=/dev/`、fork bomb、shutdown、`git push --force main`

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
loadConfig(.claw/mcp.json)
  → validateConfig(结构校验)
  → connectAll(Promise.allSettled 并行连接,per-server 失败隔离)
    → connectAndList:
        client.connect() 握手
        client.listTools() 发现工具
        每个 tool → new McpToolBridge → registry.register
  → closeAll(退出时并行 close)
```

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
- 导出 JSON 到 `.claw/traces/`
- 入口：显式 `trace: true` 或环境变量 `PICO_TRACE=1`
- TUI 每轮结束后把 `result.tracePath` 追加为 system message，方便直接打开文件复盘

### Pricing (`pricing.ts`)

- 硬编码官方定价快照（glm-5.2/glm-4.5-air/kimi-k2.5/claude-3-5-sonnet）
- `estimateCost(route, usage)` → costCNY（USD × 7.2）
- subscription 模式全 0

---

## 6. 配置与部署

### 技术栈

| 维度         | 选择                                           |
| ------------ | ---------------------------------------------- |
| 语言         | TypeScript ESM, target ES2024, **全开 strict** |
| 运行时       | Node.js ≥ 22                                   |
| 原生模块     | better-sqlite3（需 node-gyp 编译）             |
| TUI          | ink 7 + React 19                               |
| 日志         | pino + pino-pretty                             |
| 测试         | vitest                                         |
| 公开运行方式 | `pico` 启动 TUI                                |

### tsconfig 关键项

- `noUncheckedIndexedAccess`：数组/Map 索引返回 `T | undefined`（强制越界保护）
- `jsx: "react-jsx"`：TUI 支持 .tsx
- `module: NodeNext`：纯 ESM，import 必须带 .js 扩展名

### 当前部署边界

Docker、公开 headless CLI 和 Plugin runtime 不在当前支持范围。周期任务通过 TUI 确认后写入本机账本，并由用户级 daemon 在同一安全策略边界内执行；daemon 不构成远程或公开 CLI 入口。

### 环境变量

- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（必填）
- `LLM_API_KEYS`（复数，逗号分隔，429 自动轮换）
- `AUX_LLM_*`（辅助廉价模型，FullCompactor 用）
- `PICO_TRACE=1`（每轮导出 trace JSON）
- `LOG_LEVEL`（默认 info）
- `SEARCH_API_BASE` / `SEARCH_API_KEY`（WebSearch）

---

## 关键架构洞察

1. **零外部协议依赖**：手写 JSON-RPC over stdio、手写 SSE 行解析、不用 @modelcontextprotocol/sdk
2. **装饰器/AOP 贯穿**：CostTracker（计费）、McpToolBridge（工具适配）、ApprovalManager（Promise 挂起）
3. **单一 Rewind 路径**：file-history（copyFile/CAS）+ operation journal，三轴 rewind 在 Session 层组合
4. **两层审批**：`buildPermissionMiddleware` 负责安全判定与会话授权，ApprovalManager 负责挂起和唤醒人工审批
5. **严格类型安全**：全开 strict + noUncheckedIndexedAccess，代码里随处可见 `!` 非空断言和 `?? fallback`
