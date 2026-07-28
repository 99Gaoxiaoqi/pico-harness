# 内部 Headless One-shot Runner

该入口只供仓库内 benchmark、可靠性测试和封闭评估使用。它不是公开 CLI 或 API，不承诺跨版本兼容；根命令 `pico` 仍然只启动 TUI，公开的 `pico run` 尚未提供。

Runner 只是一层宿主适配器，执行链固定为：

`严格 JSON/工具预检 → 非交互工作区信任 → 仅用户模型目录的精确路由 → 独占租约 → executeAgentRuntime → 单个 JSON 终态`

它不会另建 Engine、Provider、Tool Registry、Session 或安全中间件。

## 调用

开发态：

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

构建后：

```bash
npm run build
node dist/internal/headless-one-shot-main.js < request.json
```

开发态命令中的 `--silent` 用来阻止 npm 自己把 lifecycle 标题写到 stdout；需要精确保留退出码的自动化调用应直接执行构建入口。stdin 必须只包含一个 `schemaVersion: 1` JSON 对象。Runner 的 stdout 对成功、请求错误和运行失败都只输出一行 JSON；Runtime 日志只允许写入 stderr。请求不接受 `apiKey`、`baseURL`、resume、continue 或 fork 字段，未知字段直接拒绝。

`thinkingEffort` 是可选的显式 route 能力选择；省略时使用有效配置的 route 默认值。若显式值不被该 route 支持，请求会在模型生成前失败。

## 隔离与权限

- `workspacePath` 和 `picoHome` 必须是两个互不包含的现存绝对真实目录。
- Runner 拒绝默认 `~/.pico`。调用方必须为每个 case 准备独占 `PICO_HOME`、唯一新 `sessionId` 和独立 workspace copy/worktree。
- workspace 必须预先记录在该 `PICO_HOME/trusted-workspaces.json` 中。Runner 不显示信任提示，未知 workspace 会在读取项目配置前 fail-closed。
- `modelRouteId` 只从隔离 `PICO_HOME/config.json` 的用户模型目录精确解析。Runner 不读取项目 Provider，不使用旧 `LLM_*` 路由；传给模型装配的环境也只包含该可信 route 声明的一个凭证变量。
- Runtime 使用隔离的 `HOME`/XDG 根和显式空 Plugin 快照，不加载宿主或项目的 Claude、Plugin、Skill、Agent、MCP、LSP、Hook、Memory 资源。
- `permissionMode` 和 `allowedTools` 必填，不继承新 Session 的默认 YOLO。支持 `default`、`auto`、`plan`、`yolo`；工具白名单只接受 `read_file`、`read_evidence`、`write_file`、`edit_file`、`bash`、`glob`、`grep`、`todo`、`fetch_url`、`web_search`，无 UI 的审批请求会立即拒绝。
- YOLO 是当前 OS 用户权限下的全程放权，不是完整沙箱。外层调度器必须使用一次性低权限账户或容器、独占 `PICO_HOME` 和可丢弃 workspace copy/worktree。
- 同机并发通过 `PICO_HOME`、workspace、Session 三个按序获取的 owner lease fail-closed；部分获取会回滚，正常/失败/已确认取消会释放，进程崩溃后的 dead owner 可由下一个 case 安全接管。已有 Session ID 也会在 Runtime 执行前拒绝。

## 输出与退出码

每个结果都包含以下固定字段：

```json
{
  "schemaVersion": 1,
  "requestId": "case-001",
  "status": "completed",
  "sessionId": "eval-case-001",
  "workDir": "/real/workspace",
  "finalMessage": "...",
  "usage": {
    "promptTokens": 100,
    "completionTokens": 20,
    "costCNY": 0.01
  },
  "durationMs": 12345,
  "tracePath": "/absolute/path/to/trace.json",
  "effective": {
    "modelRouteId": "provider-id/model-id",
    "thinkingEffort": null,
    "permissionMode": "plan",
    "allowedTools": ["read_file", "grep"]
  },
  "error": null,
  "terminationConfirmed": true
}
```

失败只输出稳定错误码和脱敏摘要，不输出 stack、完整 Messages 或原始 ToolResult。

| status            | 退出码      | 含义                                       |
| ----------------- | ----------- | ------------------------------------------ |
| `completed`       | `0`         | Runtime 正常完成                           |
| `invalid_request` | `2`         | JSON、路径、信任、route、Session 等无效    |
| `failed`          | `3`         | Runtime 或内部执行失败                     |
| `policy_blocked`  | `4`         | 工具动作被有效安全/权限策略阻断            |
| `timed_out`       | `124`       | `timeoutMs` 到期                           |
| `canceled`        | `130`/`143` | SIGINT / SIGTERM（其他宿主取消映射为 130） |

timeout、SIGINT 和 SIGTERM 合并为同一个 Runtime `AbortSignal`，同一 deadline 覆盖路径、信任、凭证和模型装配等异步预检。Runner 最多等待 `shutdownGraceMs` 让 Runtime 和工具完成清理；若无法证明外部副作用已经停止，仍按原始原因返回 `timed_out`/`canceled` 及对应退出码，同时输出 `error.code: "SHUTDOWN_UNCONFIRMED"` 和 `terminationConfirmed: false`。进程内调用会继续持有三项租约，直到后台 Runtime Promise 真正 settle；CLI 退出或崩溃后由 dead-owner 协议恢复。父调度器仍应设置独立 hard deadline。

## 确定性边界

同一 case 应固定 prompt、Runtime 版本、模型 route、thinking、权限、工具白名单和配置快照。该约束保证执行输入和状态归属可追溯，不承诺模型最终文本逐字一致。详细事实继续以 RuntimeEvent、Evidence 和 Trace 为准。
