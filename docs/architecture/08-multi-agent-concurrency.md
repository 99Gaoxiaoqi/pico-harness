# 多 Agent 共享工作区并发规范

> 状态：目标架构，尚未全部实现。本文是 Pico 多 Agent 写入、冲突处理和隔离升级的权威规范；现有代码中的强制 worktree worker 属于迁移前实现，不代表最终产品契约。

## 1. 目标与边界

Pico 默认允许多个 Agent 在同一工作目录中并发工作。普通文件夹不需要 Git，也能使用 Explore Agent 和可写 Worker；Git 只为分支、提交、合并、PR 与 worktree 强隔离提供增强能力。

设计目标：

- 不冲突的任务直接并发，不因为“可能写文件”而全局串行。
- 所有接入协调器的 Pico Writer 都必须在最终版本校验前拒绝过期写；外部进程变化采用 best-effort 检测并尽量缩小竞态窗口。
- Agent 只写 Coordinator 分配给自己的范围，责任边界可见、可审计。
- 不用任务生命周期长锁；Agent 失败、暂停或失联不能长期占住文件。
- 无法可靠跟踪的动态写入升级为串行或隔离执行，不伪装成已受 OCC 保护。

非目标：

- 自动合并两个 Agent 对同一文件的语义修改。
- 用全局资源图预测 Agent 整个任务期间会访问的所有路径。
- 用 OCC 替代工作区信任、工具审批、OS 沙箱或 Git 交付流程。

## 2. 两组模式必须分开

现有 `WorkspaceMode = "folder" | "git"` 描述所选目录具备什么版本控制能力；新增 `WorkspaceExecutionMode` 描述 Worker 如何隔离。两者正交：

| 工作区能力 | 执行模式   | 是否可用 | 说明                                           |
| ---------- | ---------- | -------- | ---------------------------------------------- |
| `folder`   | `shared`   | 是       | 多 Agent 共享目录，通过写入范围和文件 OCC 协作 |
| `folder`   | `worktree` | 否       | 没有 Git，不能创建 worktree                    |
| `git`      | `shared`   | 是       | 默认模式；Git 存在但不是并发前提               |
| `git`      | `worktree` | 是       | 高冲突、动态写或独立交付时显式升级             |

```ts
export type WorkspaceExecutionMode = "shared" | "worktree";
```

“没有 Git”只关闭 branch、commit、merge、PR 和 worktree，不得阻止普通任务、可写 Worker、文件 Diff 或基于 File History 的 Rewind。

## 3. 四层并发模型

### 3.1 Agent 内：单轮工具批次调度

现有 `ToolAccesses` 与 `ToolScheduler` 保持不变。每个 Agent 在一次模型响应产生的 `toolCalls` 批次中创建自己的 Scheduler：

- `read + read` 可以并行。
- 不同文件的写入可以并行。
- 同一路径至少一方含写时串行。
- `all()` 代表该批次内无法静态分析的全局副作用点。

这个冲突图只决定**一个 Agent 单轮工具批次**的启动顺序。它不跨 Agent 共享，不在下一轮保留，也不承担文件所有权或长期锁的职责。

### 3.2 Agent 间：任务分区与写入范围

Coordinator 创建 Worker 时必须同时给出语义任务和 `writeScopes`。范围是授权与责任边界，不是锁：另一个 Agent 可以读取这些文件，但未经重新分配不能写入。

```ts
export interface AgentWriteScope {
  /** 现有 SubagentActivityEvent 的稳定 Worker 实例键；profile 名不能代替它。 */
  readonly activityId: string;
  /** 相对可信工作区的 POSIX 风格 glob；可为空，为空即只读。 */
  readonly include: readonly string[];
  /** 从 include 中排除，优先级高于 include。 */
  readonly exclude?: readonly string[];
}
```

约束：

- 路径先按工作区真实路径归一化，再匹配 scope；符号链接不能绕过根目录边界。
- 空 scope 表示只读，不能解释为“允许全部”。
- Hook 或模型改写工具参数后，必须对最终参数重新检查 scope。
- Coordinator 应优先按模块、目录或明确文件拆分；同一路径的写范围默认不能分给两个活跃 Worker。
- 重新分配范围必须生成可审计事件，不追溯授权已经完成的写入。
- v1 的可写 Shared Worker 只允许 `completion_policy="required"`；`optional`/`detached` 跨越父工具批次，必须先升级 worktree，直到独立的长生命周期 Journal 完成。

### 3.3 文件提交：乐观并发控制

每个 Agent 维护独立的读取版本表。`read_file` 完整读取文件时记录强指纹；`edit_file`、覆盖已有文件和删除文件必须携带本 Agent 最近一次完整读取得到的期望版本。

```ts
export interface FileVersion {
  readonly kind: "file" | "missing" | "directory" | "symlink" | "special";
  /** SHA-256(kind + mode + bytes/target)，不能只使用 mtime。 */
  readonly fingerprint: string;
}

export type FileMutationExpectation =
  | { readonly kind: "version"; readonly value: FileVersion }
  | { readonly kind: "absent" };

export interface FileMutation {
  readonly activityId: string;
  readonly path: string;
  readonly operation: "create" | "replace" | "edit" | "delete";
  readonly expected: FileMutationExpectation;
}
```

提交顺序固定为：

1. 工具参数完成 Schema 校验、Hook 改写和审批。
2. 用最终路径校验工作区信任、敏感路径与 `writeScopes`。
3. 获取目标路径的短临界区；跨进程实现必须使用能覆盖所有 Pico 写入者的 per-path mutex。
4. 重新读取磁盘状态并计算 `FileVersion`。
5. 比较 `expected`；不一致立即拒绝，不产生部分写入。
6. 在同目录创建权限受控的临时文件，完整写入并在支持的平台刷盘。
7. 通过平台适配器原子替换目标；释放临界区。
8. 更新该 Agent 的版本表，并把写前/写后指纹记录到 File History 和活动事件。

最终 scope 与 OCC 守卫必须位于最内层文件 mutation service，不能复用会吞掉失败的 best-effort `preWriteHook`，也不能只依赖 Hook 前计算的 `Registry.getAccesses()`。

新文件必须使用 `{ kind: "absent" }`，并通过平台 no-clobber 发布原语提交（例如同文件系统临时文件配合 exclusive create/link）；普通 `rename` 不能满足“目标刚出现时拒绝覆盖”。`edit_file` 的模糊匹配发生在版本验证之后、内存中的已验证内容上，不能拿旧内容重新匹配新文件。

短 per-path mutex 能强约束所有接入同一协调器的 Pico Writer。对编辑器和其他外部进程，它只能缩小“最终校验到发布”之间的竞态窗口，不能提供跨进程文件系统 CAS；File Watcher 发现窗口内变化时必须报告风险，不能宣称任意外部写都绝不会被覆盖。

### 3.4 可选隔离：worktree

下列任务默认建议或强制升级到 `worktree`：

- 多个 Worker 必须密集修改相同模块或相同文件。
- 使用无法声明准确写入范围的 formatter、生成器、构建脚本或包管理器。
- 需要独立分支、提交、PR、可丢弃实验环境或批量合并审查。
- 安全策略要求进程级文件系统隔离。

升级由 Coordinator、用户或安全策略显式决定。不能因为工作区恰好存在 Git 就自动把所有 Worker 放入 worktree；也不能在 worktree 创建失败后静默降级为共享写入。

## 4. 错误契约与恢复

```ts
export type WriteConflictCode =
  | "STALE_FILE"
  | "PATH_OUT_OF_SCOPE"
  | "FILE_ALREADY_EXISTS"
  | "DYNAMIC_WRITE_REQUIRES_ISOLATION"
  | "WORKTREE_UNAVAILABLE";

export interface WriteConflict {
  readonly code: WriteConflictCode;
  readonly path?: string;
  readonly retryable: boolean;
  readonly expectedFingerprint?: string;
  readonly actualFingerprint?: string;
  readonly message: string;
}
```

| 错误                               | `retryable` | 处理                                                        |
| ---------------------------------- | ----------- | ----------------------------------------------------------- |
| `STALE_FILE`                       | 是          | 重新完整读取，吸收新内容，重新生成修改；禁止原样自动重放    |
| `PATH_OUT_OF_SCOPE`                | 否          | 停止写入，请 Coordinator 调整任务或 scope                   |
| `FILE_ALREADY_EXISTS`              | 是          | 重新读取并决定改名、编辑现有文件或放弃创建                  |
| `DYNAMIC_WRITE_REQUIRES_ISOLATION` | 否          | 串行运行或切换 worktree/沙箱                                |
| `WORKTREE_UNAVAILABLE`             | 否          | 解释 Git/仓库能力缺失；用户可改用满足条件的 shared 任务方案 |

错误进入 Agent 工具结果和 Runtime 事件，但 UI 默认展示人类可理解的动作：“文件已被其他工作修改，正在重新读取”，不要求普通用户理解 OCC 或 Git。

上述细码先属于工具/执行层契约。透传现有 Desktop Runtime 协议时，`STALE_FILE` 映射到通用 `CONFLICT`、`PATH_OUT_OF_SCOPE` 映射到 `FORBIDDEN`，并把细码放入后续新增的结构化 details；协议扩展前不能假装 Renderer 已能直接识别这些细码。

## 5. Bash 与动态写入

OCC 只能保护经过 Pico 文件工具提交的变更，不能自动覆盖任意子进程的所有 I/O。

- 已证明只读的 Shell 命令可以并行。
- 写入路径能准确声明的命令，按声明的资源进入 Agent 内调度，并在执行前校验 scope。
- formatter、生成器、包管理器及未知脚本视为动态写入；共享模式下必须获取 workspace 级独占执行门，阻止同期 Pico 文件工具写入，并由 File Change Journal 扫描前后变化，或切换隔离模式。
- 命令尝试写出 scope、触碰敏感路径或无法满足平台沙箱边界时 fail-closed。
- Journal 只能用于发现和审计变化，不能把未经过 CAS 的外部写入宣传为 OCC 安全；workspace 执行门也不能阻止用户编辑器或其他外部进程。

## 6. Rewind 与文件归属

Rewind 复用现有 File History 指纹校验，并增加 Agent 写入归属：每条变更至少记录 `activityId`、可选 Agent Profile 名、写前指纹、写后指纹和路径。

恢复某个 Agent 的变更前，当前文件必须仍等于该变更的写后指纹。若用户、其他 Agent 或外部进程已经修改文件，Rewind 返回冲突并要求刷新 Diff；不得覆盖后来者的工作。批量 Rewind 先预检全部文件，任一冲突则整批不开始；提交时按稳定路径顺序持有全部目标的短锁直到恢复结束。若平台不能安全持有这组锁，则每个文件写前再次 CAS，并用 operation journal 在中途失败时补偿已恢复文件，不能留下未声明的部分恢复。

## 7. Runtime 事件与 UI

跨 Agent 视图展示事实，不展示推测的全局锁图：

- Agent 的任务、状态、`writeScopes` 与执行模式。
- 正在读取、计划修改、已经修改的文件。
- `STALE_FILE`、重新读取、重试和最终结果。
- 工作区是普通文件夹还是 Git 仓库，以及 Git 缺失具体关闭了哪些能力。
- 因动态写或高冲突升级隔离的原因。

第一阶段复用现有 `DesktopReporter` 的 `subagent.activity/subagent.trace → run.timeline` 投影，把 `agent.scope.assigned`、`file.read`、`file.mutation.committed`、`file.conflict` 和 `agent.execution-mode.changed` 作为结构化 timeline item type；不假设它们已经存在于 `RuntimeEventMap`。需要断线 replay 和独立订阅时，再把稳定字段提升为正式协议事件并使用单调 `resourceVersion`。Renderer 只投影 Runtime 真值，不自行推断文件所有权。

## 8. 关键时序

### 8.1 两个 Agent 写不同文件

1. Agent A 获得 `src/a.ts`，Agent B 获得 `src/b.ts`。
2. 两者各自读取并记录版本，同时生成修改。
3. 两条路径分别进入短临界区并通过版本校验。
4. 两次原子替换并行完成，无全局等待。

### 8.2 两个 Agent 写同一文件

1. A、B 都读取 `src/shared.ts@v1`。
2. A 先提交，文件成为 `v2`。
3. B 提交时发现期望 `v1`、实际 `v2`，收到 `STALE_FILE`。
4. B 重新读取 `v2`，重新生成修改后才可提交；系统不自动覆盖 A。

正常情况下 Coordinator 不应把同一路径同时分给 A、B；这个时序仍用于处理外部修改、范围重叠漏洞和竞态。

### 8.3 动态 Bash 写入

1. Worker 请求运行无法枚举输出路径的代码生成器。
2. 系统不能为其建立可靠的文件期望版本集合。
3. 共享模式拒绝并返回 `DYNAMIC_WRITE_REQUIRES_ISOLATION`，或由可信策略改为独占串行运行。
4. 用户选择 worktree 时，Git 可用性预检通过后再启动；失败不降级。

### 8.4 Rewind 遇到后来修改

1. Agent A 把文件从 `v1` 写到 `v2`。
2. Agent B 或用户把它改为 `v3`。
3. A 的 Rewind 期望当前状态仍为 `v2`，预检发现 `v3`。
4. Rewind 整体停止，保留 `v3` 并提示刷新 Diff。

## 9. 实施顺序与验收

1. 先引入执行模式、scope、文件版本和错误类型，不改变现有 worker 路由。
2. 将 Read/Write/Edit 接入每 Agent 版本表、scope 校验与原子提交。
3. 补齐 Runtime 事件、冲突重读提示和 File History 归属。
4. 在确定性测试覆盖通过后，把默认 Worker 从强制 worktree 切到 `shared`。
5. 最后接入动态 Bash 分类和自动建议升级；未知写入始终保守处理。

必须覆盖：不同文件并发成功、同文件后提交冲突、新文件竞争、scope 越界、Hook 改写后越界、外部进程修改、动态 Bash、daemon 重启、Rewind 冲突，以及无 Git 工作区中的完整 Shared Worker 主路径。
