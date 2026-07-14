# 工具层 (`src/tools/`)

> Main Loop 永远是"瞎子聋子"，只通过统一的 Registry 接口拿工具 schema、下发 ToolCall、接收 ToolResult。

## 架构分层

```
接口层  registry.ts        BaseTool / Registry 抽象 + 三层中间件签名
实现层  registry-impl.ts   ToolRegistry 默认实现 + 6 个核心内置工具
工厂层  default-registry.ts 全量工具注册工厂(host 注入单例依赖)
控制层  tool-access.ts      资源访问集(冲突图原语)
        tool-scheduler.ts   并发调度(最大独立集贪心)
        tool-disclosure.ts  渐进披露状态机
```

---

## 1. 核心接口

### BaseTool (`registry.ts:36-65`)

```ts
interface BaseTool {
  name(): string; // 全局唯一名
  definition(): ToolDefinition; // name + description + inputSchema(JSON Schema)
  execute(args: string): Promise<string>; // 原始 JSON 字符串,延迟解析
  readOnly?: boolean; // 默认 false
  accesses?(args: string): ToolAccesses; // 资源访问集;未实现按 all() 保守
  maxResultSizeChars?: number; // 默认 8000
  toolset?: string; // 工具所属集(预留分组)
}
```

关键设计：**延迟解析**——execute/accesses 都收原始 JSON 字符串，各工具内部反序列化，Main Loop 不关心参数结构。

### Registry (`registry.ts:68-98`)

```ts
interface Registry {
  register(tool: BaseTool): void;
  getAvailableTools(): ToolDefinition[]; // 返回 schema 给 Main Loop
  execute(call: ToolCall): Promise<ToolResult>; // 路由并执行
  use(mw: MiddlewareFunc): void; // 安全拦截中间件
  useRequest?(mw: RequestMiddleware): void; // 可拦截/改写参数
  useExecution?(mw: ExecutionMiddleware): void; // 洋葱包裹执行
  isReadOnlyTool?(name: string): boolean;
  getAccesses?(call: ToolCall): ToolAccesses;
  setHookService?(service: HookService): void; // 前台会话 Hooks
}
```

### 执行链

```
execute(call)
  ├─ 1. 路由查找 (tools.get)
  ├─ 2. Hardline / Plan / Workspace Trust 不可绕过门
  ├─ 3. PreToolUse Hook（可 deny/改写）
  ├─ 4. 改写后重跑安全门
  ├─ 5. PermissionRequest Hook → 人工审批
  ├─ 6. preWriteHook / ExecutionMiddleware / tool.execute
  ├─ 7. PostToolUse 或 PostToolUseFailure（有界等待）
  └─ 8. 并行批次完成后 PostToolBatch
```

---

## 2. 资源冲突图调度 (`tool-access.ts` + `tool-scheduler.ts`)

### ToolAccesses 原语

```ts
type FileAccessOp = "read" | "write" | "readwrite";
// 冲突 = 任意一方含写 && 路径重叠
// read+read 同文件 → 不冲突(并行)
// write+write 不同文件 → 不冲突(并行)
// write+read 同文件 → 冲突(串行)
```

工厂：`none()` / `all()` / `readFile(path)` / `writeFile(path)` / `readWriteFile(path)`

路径归一化：转小写 + 反斜杠转正斜杠 + 合并重复斜杠（跨平台一致）。

### 调度器

在 `loop.ts:786` 每批 toolCalls 创建 `ToolScheduler`：

- 不冲突的重叠执行，冲突的等待
- 结果按 provider 原始顺序回传（保序）
- `maxConcurrency=8` 防打爆 IO
- 每完成一个任务重新扫描队列唤醒可执行的任务

---

## 3. 全部已注册工具清单

### 核心组（每轮始终暴露，渐进披露）

| name         | readOnly | accesses              | 用途                                        |
| ------------ | -------- | --------------------- | ------------------------------------------- |
| `read_file`  | ✅       | `readFile(path)`      | 读文件，加行号，截断 12000 字节             |
| `write_file` | ❌       | `writeFile(path)`     | 创建/覆盖文件，自动建父目录                 |
| `edit_file`  | ❌       | `readWriteFile(path)` | 四级模糊匹配链局部替换                      |
| `bash`       | ❌       | `all()`               | 执行 shell，30s 超时，支持 background       |
| `glob`       | ✅       | `none()`              | glob 模式匹配文件路径（自实现 glob→RegExp） |
| `grep`       | ✅       | `none()`              | 搜索文本/正则（ripgrep 优先，降级 Node.js） |
| `todo`       | ❌       | `all()`               | 任务清单 add/update/toggle/remove/list      |

### 扩展组（按需披露，search_tools 激活）

| name             | readOnly | accesses | 用途                             |
| ---------------- | -------- | -------- | -------------------------------- |
| `echo`           | ✅       | `none()` | 原样回显（验证链路）             |
| `skill_view`     | ✅       | —        | 查看 SKILL.md 正文               |
| `task_list`      | ✅       | `none()` | 列后台任务                       |
| `task_output`    | ✅       | `none()` | 读后台任务输出                   |
| `task_stop`      | ❌       | `all()`  | 停止后台任务                     |
| `fetch_url`      | ✅       | `none()` | 抓网页 → 纯文本                  |
| `web_search`     | ✅       | `none()` | 网络搜索                         |
| `exit_plan_mode` | ❌       | `all()`  | Plan Mode 审批网关               |
| `create_goal`    | ❌       | `all()`  | 创建并激活长程目标               |
| `get_goal`       | ✅       | `none()` | 查询目标                         |
| `update_goal`    | ❌       | `all()`  | 更新目标字段                     |
| `search_tools`   | ✅       | `none()` | 渐进披露元工具（检索激活扩展组） |

### 子代理工具（host 单独注册）

| name              | 用途                                    |
| ----------------- | --------------------------------------- |
| `spawn_subagent`  | 单任务子代理委派（只读 registry）       |
| `delegate_task`   | 批量/explore/worker 委派（Hermes 风格） |
| `delegate_status` | 查询 background 委派状态                |

---

## 4. EditFileTool 四级模糊匹配

```
L1 精确匹配
L2 换行符归一化 (\r\n → \n)
L3 Trim 首尾空白
L4 逐行去缩进 + 缩进重对齐
```

安全底线：匹配结果 > 1 时拒绝（要求更多上下文）。全失败时附候选上下文帮模型重定位。

---

## 5. 子代理机制

### 防污染设计

- 全新纯净 contextHistory（不依赖外部 Session）
- 仅挂载受限 Registry（explore 只读 / worker 受控写）
- `maxSubTurns=10` 防卡死，`maxSpawnDepth=2` 防无限委派
- 强制关闭慢思考

### explore vs worker

| 模式    | 工具                                                               | 限制                              |
| ------- | ------------------------------------------------------------------ | --------------------------------- |
| explore | read_file/skill_view/bash(强制只读)/glob/grep/fetch_url/web_search | 禁止任何写操作                    |
| worker  | 上述 + write_file/edit_file                                        | 禁高危命令（rm/sudo/git push 等） |

### 自定义角色 (`.claw/agents.yaml`)

按 `profile.tools` 白名单实例化工具，支持自定义 system prompt + maxTurns。

---

## 6. 渐进披露

```
模型默认看到: 7 核心工具 + search_tools
    ↓
需要 web_search → 调 search_tools({query:"搜索网络"})
    ↓
命中 web_search, fetch_url → disclosure.disclose()
    ↓
下一轮 pickForLLM 返回: 核心 + web_search + fetch_url + search_tools
```

安全网：即便工具未披露，模型误调时 registry.execute 仍按全集路由。

---

## 7. 会话级 Hooks (`src/hooks/`)

对标 Claude Code / Codex / Kimi Code 协议：

- 前台 `HookService` 支持完整事件集和 `command/http/mcp_tool/prompt/agent`。
- 普通 handler 故障 fail-open；父级 Abort 必须中止全部子执行。
- Canonical 配置位于 `~/.pico/hooks.json`、`.pico/hooks.json`、`.claw/hooks.local.json`；legacy settings 只读兼容。
- 可执行 handler 经工作区、定义和脚本字节哈希绑定信任。
- 后台/Cron 继续使用 command-only、network-deny、fail-closed strict runner。

---

## 关键设计原则

1. **延迟解析**：execute/accesses 收原始 JSON 字符串，各工具内部反序列化
2. **保守降级**：工具未实现 accesses → `all()`（宁可损失并发不可错判冲突）
3. **分层故障语义**：前台普通 Hook 故障 fail-open，父级取消不得被吞掉
4. **爆炸半径限制**：子代理仅挂载受限工具
5. **路径安全**：`safeResolve` 防穿越是所有文件工具的防御底线
6. **解耦**：工具不直接操作 engine 私有状态，通过 host 注入回调
