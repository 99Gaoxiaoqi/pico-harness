# Pico TUI 产品化设计

## 背景

Pico 已经具备 Ink TUI、流式输出、工具折叠、审批、虚拟 transcript、Slash 命令、Skills、PluginManager、GoalManager 和后台任务等基础能力。当前问题不是重新搭建一套 TUI，而是把已有能力收口成可信、可发现、稳定的产品交互。

本设计采用已确认的方案 C：使用 Claude Code 的 transcript 与渲染思路，结合 Kimi Code 的三层 TUI 和能力管理入口，同时保持 Pico 的极简实现。

## 目标

1. 用户看到的状态必须与真实运行时一致。
2. 键盘输入在任意时刻只有一个焦点所有者。
3. 长对话、中文、Emoji、工具聚合和展开内容都能稳定滚动。
4. Logo、消息区、输入区和状态行形成一个统一外壳。
5. 内置命令、Skills、Plugins、Goal、Tasks 和 MCP 通过同一个 `/` 入口发现。
6. 不复制 Claude Code 中与 Pico 规模不匹配的鼠标坐标系统、外部状态脚本和超大虚拟列表。

## 界面结构

```text
PICO
pico · model · project · permission · MCP summary

  ❯ 用户消息

  ✦ 助手回复
    ⎿ read · src/file.ts · Success
    ⎿ Skill · aihot · loaded

  ───────────────────────────────────────────────
  ❯ 输入消息，键入 / 查看命令，@ 引用文件
    model · mode · context · tasks · branch
```

Logo 是 transcript 的第一项，只在新会话开头出现一次并随历史滚走。窄终端只显示 `pico · model · cwd`。状态行固定在输入区附近，避免与 Logo 重复。

## 运行时正确性

### 真实中断

每次 TUI run 创建一个 `AbortController`。信号沿 `runTuiAgentPrompt -> runAgentFromCli -> AgentEngine.run -> Provider/ToolScheduler` 传递。`Ctrl+C` 先触发 abort，再清理队列并等待运行收口，最后将 QueryGuard 置回 idle。

### 焦点所有权

焦点优先级固定为：

```text
modal dialog > approval > autocomplete > input > transcript
```

审批期间普通输入和工具卡快捷键停用。审批面板仍保持内联风格，但属于 modal 焦点层；用户使用方向键、数字键或确认键完成选择。

### 状态不可变更新

Reporter 更新工具状态时替换对象，不原地修改条目。只有已完成、失败或拒绝的工具条目才可视为静态，避免 memo 跳过状态刷新。

## Transcript 与滚动

工具条目先聚合，再由同一份 display entries 计算总高度与虚拟窗口。文本宽度使用终端显示宽度，不使用 UTF-16 `string.length`。展开状态进入行高估算；活动条目和展开条目保留 overscan。

用户离开底部后停止自动跟随，显示新消息数量；回到底部后恢复 auto-follow。普通 `Up/Down` 保留给输入历史，transcript 使用 `PageUp/PageDown`、`Ctrl+Up/Ctrl+Down` 和 Home/End。

## 命令体系

保留现有 `CommandRegistry`，扩充单一命令描述对象：

```ts
interface SlashCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  category?: "session" | "model" | "runtime" | "extension" | "help";
  source?: "builtin" | "project" | "user" | "skill" | "plugin" | "mcp";
  availability?: "always" | "idle";
  argumentHint?: string;
  argumentCompleter?: CommandArgumentCompleter;
}
```

命令候选保留完整结果，UI 仅渲染一个可滚动窗口。空 `/` 优先显示最近使用命令和 Skills，再按类别展示。搜索顺序为精确名称、精确别名、前缀、描述模糊匹配。

Markdown 命令只从明确的 command 根目录加载，跳过 `resources`、`references`、`templates`、`workflows`、`agents`、`skills` 和 README。命令的 `model`、`allowed-tools` 等元数据必须真正进入执行路径；无法执行的元数据不应显示为已支持。

## 能力入口

第一阶段接通已有能力，不引入新的运行时系统：

- `/skills`：按来源展示，并在调用时向 transcript 写入 Skill 激活行。
- `/plugins`：列出、启用、禁用和重载本地插件；显示插件贡献的 Skills/MCP。
- `/goal`：创建、查看、暂停、恢复、替换和取消当前目标；TUI 会话内复用同一个 GoalManager。
- `/tasks`：列出后台任务并支持查看输出、停止任务。
- `/plan`：作为真实 Plan Mode 的直接入口。
- `/permissions`：真实更新审批策略，不再只改展示字符串。
- `/sessions`、`/resume`：启动级 `--session`、`--continue`、`--fork` 与 TUI selector 使用相同语义。

## 错误与工具展示

错误使用结构化条目，不再依赖 `⚠️` 字符串前缀判断。错误至少区分 provider、authentication、context、permission、tool 和 aborted，并允许渲染可执行建议。

工具默认显示一行摘要：名称、目标、状态、耗时或输出大小。同类连续工具可聚合；选中条目后展开完整详情。Skill 激活、Plugin 加载和 Goal 状态使用同一事件行样式。

## 分阶段交付

### 阶段 1：正确性与基础产品外壳

- 真实中断
- 焦点仲裁
- immutable reporter
- Unicode/聚合滚动
- Logo 进入 transcript、状态行去重
- 命令真实性与扫描收敛

### 阶段 2：能力管理

- `/skills`、`/plugins`、`/goal`、`/tasks`
- 动态参数补全
- 统一 Help/Command 面板
- session 启动与恢复闭环

### 阶段 3：增强体验

- `/tui default|fullscreen`
- `/theme`、`/config`、`/provider`
- `/btw`、`/focus`、外部编辑器和运行中 steer
- MCP prompts/resources 命令投影

## 测试策略

所有行为遵循 TDD。纯函数和状态流使用 Vitest；Ink 组件使用 `ink-testing-library`；关键交互增加真实 PTY smoke，覆盖审批抢键、Ctrl+C、40x12 resize、CJK/Emoji、长回复滚动和工具聚合。功能完成后运行 typecheck、lint、完整单元测试、TUI smoke，并使用真实 LLM 验证一次中断/审批/工具流程。

