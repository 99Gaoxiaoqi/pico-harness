# Claude Code 风格 Skill 与 Workspace 设计

## 背景

Pico 当前存在两个不一致行为：显式 Skill 命令有时只展示或裸注入 `SKILL.md`，缺少“已激活并执行”的确定语义；写入工作区外文件时先弹审批，批准后又被 `safeResolve()` 拒绝。后者让审批成为无效操作。

本设计采用 Claude Code 风格的权限边界：文件工具只能访问主工作区与显式加入的 additional directories。工作区外路径不能通过单次写入审批穿透，必须先用 `/add-dir`、启动参数 `--add-dir` 或项目配置加入工作区。

## 目标

1. 显式 Skill 调用必定启动 Agent turn，并明确告诉模型遵循 Skill 指令完成当前任务。
2. `/skill <name> [args]` 与 `/<skill-name> [args]` 语义一致；`/skills` 只负责列出可用 Skill。
3. Skill 参数遵循 Claude Code 的 `$ARGUMENTS`、`$ARGUMENTS[N]`、`$N` 规则；无占位符时追加 `ARGUMENTS: ...`。
4. 所有路径型文件工具共享一份 Workspace Roots 能力，不再各自维护不一致的路径边界。
5. `/add-dir` 支持当前 session 添加目录；`--add-dir` 支持启动时重复传入目录；`.pico/config.json` 支持 `permissions.additionalDirectories` 持久配置。
6. TUI 对 Skill 激活和 additional directory 变更留下持久 transcript 条目；确定性路径拒绝不弹审批。

## 非目标

- 不允许“一次批准”临时写入任意工作区外绝对路径。
- 不把 additional directory 变成新的项目配置根；不加载其中的 `AGENTS.md`、hooks 或普通 commands。
- 不实现 Claude Code 全量权限规则语法、`/cd` 或 OS 级 sandbox。
- 不让 Skill 覆盖 system prompt；Skill 仍以 synthetic user prompt 进入模型上下文。

## Skill 激活设计

显式入口包括：

- `/skill <name> [args]`
- `/<skill-name> [args]`

执行前先读取并渲染 Skill。渲染结果包装为：

```text
User explicitly activated skill "<name>". Follow the loaded skill instructions and use them to complete the request.

<pico-skill-loaded name="<name>" trigger="user-slash" source="<sourcePath>">
<rendered SKILL.md body>
</pico-skill-loaded>
```

Skill 正文和参数仍属于 user 层，system prompt 与 `AGENTS.md` 优先级保持不变。`PromptCommandResult.metadata` 记录 `skillName`、`skillArgs`、`skillSourcePath` 和 `skillTrigger`。TUI 在调用 Agent 前追加结构化 `TuiEntry { kind: "skill", ... }`，显示 `Skill · <name> · activated`，而不是把正文回显给用户。

参数规则：

- `$ARGUMENTS` 替换为原始参数文本。
- `$ARGUMENTS[0]` 与 `$0` 替换为第一个 shell-style 参数。
- 若正文没有任何参数占位符且参数非空，在末尾追加 `ARGUMENTS: <raw>`。
- XML 属性做转义，Skill 正文保持原样。

## Workspace Roots 设计

新增共享的 `WorkspaceRoots`：

```ts
class WorkspaceRoots {
  static create(primaryRoot: string, additionalRoots?: readonly string[]): Promise<WorkspaceRoots>;
  list(): readonly string[];
  addDirectory(path: string): Promise<AddDirectoryResult>;
  resolve(path: string): string;
  assertAllowed(path: string): Promise<string>;
}
```

主工作区始终是第一根目录。additional directories 必须存在、是目录，并经 `realpath` 规范化去重。相对路径始终锚定主工作区；绝对路径只有位于任一 root 内才允许。

执行层在物理 I/O 前调用 `assertAllowed()`：

- 已存在目标检查目标 `realpath`。
- 新建文件检查最近存在父目录的 `realpath`，防止工作区内 symlink 指向外部。
- 越界错误统一返回：`路径不在当前工作区。请先运行 /add-dir <directory> 授权该目录。`

`ReadFileTool`、`WriteFileTool`、`EditFileTool`、`GlobTool`、`GrepTool` 与文件历史 hook 使用同一个 `WorkspaceRoots` 实例。工具 schema 明确说明可访问主工作区和 additional directories。确定性越界在审批中间件之前返回，因此不会出现无效审批。

为保证校验顺序，`WorkspaceRoots` 同时提供 request middleware。它只解析 `read_file`、`write_file`、`edit_file`、`glob`、`grep` 的 `path` 参数，作为 ToolRegistry 第一条 middleware 注册；审批 middleware 在它之后注册。Bash 不做不可靠的静态路径解析，继续由现有 Bash 权限策略处理。

## Additional Directories 生命周期

目录来源按以下顺序合并并去重：

1. `.pico/config.json` 的 `permissions.additionalDirectories`
2. 重复的 CLI `--add-dir <path>`
3. 当前 session 中执行 `/add-dir <path>` 的新增项

配置文件中的相对路径相对于主工作区解析。`/add-dir` 只修改当前 session，不写配置文件；命令无参数时列出当前 roots。恢复同一进程内 session 时复用 `SessionSettings.additionalDirectories`。

`/add-dir` 成功后：

- 更新共享 `WorkspaceRoots`。
- 更新 `SessionSettings.additionalDirectories`。
- TUI 写入 `Workspace · added <canonical-path>` 系统条目。
- 后续 Agent turn 的文件工具立即获得该目录能力。

不存在、不是目录、重复目录或主工作区子目录都返回明确本地命令结果，不调用模型。

## 审批与错误可见性

写入主工作区或 additional directory 后，仍按当前 permission mode 决定是否审批。路径是否属于 workspace 是能力判断，审批是动作授权，两者不互相替代。

审批通知继续使用阻塞式 modal，同时在 tool transcript 中保持 `approval` 状态。路径越界作为结构化 tool error 显示，并携带 `/add-dir` 修复建议；不会创建 `ApprovalNotice`。

## 并行实现边界

- Agent A：Skill 参数渲染与激活 prompt，只修改 `src/input/skill-activation.ts`、`src/input/markdown-command-loader.ts` 及对应测试。
- Agent B：Workspace Roots 与文件工具边界，只修改 `src/tools/workspace-roots.ts`、路径型工具和对应测试。
- Agent C：additional directory 配置、session 与 `/add-dir` 命令，只修改 input/config/command 文件和对应测试。
- 主协调者：合并三分支，处理共享接线文件、CLI/TUI 事件、真实模型 e2e、ROADMAP 与最终验证。

## 验收

1. `/skill review src/a.ts` 会启动 Agent，prompt 包含激活声明、Skill 正文和参数，不再只显示正文。
2. `/review src/a.ts` 与上面的激活 prompt 等价。
3. 未授权的绝对外部路径和 `../` 越界均在审批前拒绝，并提示 `/add-dir`。
4. `/add-dir /tmp/shared` 后，Read/Write/Edit/Glob/Grep 可访问该目录；写操作仍遵循 permission mode。
5. symlink 指向 workspace 外部时拒绝。
6. TUI 可见 Skill 激活、目录加入、审批等待和路径拒绝。
7. 单元测试、typecheck、lint、全量测试和真实模型 e2e 通过。
