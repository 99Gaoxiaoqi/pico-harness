# Pico Desktop · 全流程原型

视觉命题：石墨色本地 Agent 控制台，以排版和细分隔线建立可信密度；青蓝只表示主导航与主动作，琥珀只表示需要用户介入。

内容结构：首次启动与信任 → 工作队列与任务创建 → Plan → 运行监督与人工介入 → Diff 审阅 → Rewind/失败恢复 → 完成归档 → Automations/Customize/Settings。

交互命题：

1. URL hash 保存主要视图和弹窗状态，关键画面可直接定位。
2. Inspector 随任务阶段从“当前”切换到“Changes”，不让用户从聊天里寻找结果。
3. Approval、Ask User、Rewind 和 Stop 使用有焦点所有权的模态层；Steer 保持非阻塞。

推荐评审入口：

- `#onboarding/welcome`
- `#work/home`
- `#work/task-running`
- `#work/task-running?dialog=approval`
- `#work/task-running?dialog=ask`
- `#work/task-review`
- `#work/task-review?dialog=rewind`
- `#work/task-failed`
- `#work/task-completed`
- `#automations`
- `#customize`
- `#settings`

## 交互覆盖矩阵

| 阶段 | 原型状态 | 关键决策 |
| --- | --- | --- |
| 首次启动 | 本地/登录、Workspace、信任、Provider、扫描结果 | 本地模式不被登录阻断；信任前不读项目配置 |
| 创建任务 | 目标、运行环境、模型、权限、预算、Plan 确认 | 写入任务必须先确认 Plan；保留现有未提交变更的来源 |
| 执行中 | 计划、工具、子代理、测试、Trace、Usage | 时间线只展示可审计事件，不暴露隐藏思维链 |
| 人工介入 | Approval、Ask User、Steer、暂停、停止 | Approval 只管权限，Ask User 只管方案；Steer 不阻断当前工具 |
| 结果审阅 | 完成摘要、文件范围、Diff、测试、要求修改、批准 | Worktree 需“批准并应用”；当前目录只需“完成审阅” |
| 恢复 | Rewind 范围、检查点、指纹校验、失败重试 | 冲突时 fail closed，不强制覆盖；外部副作用明确不会被回滚 |
| 持续运行 | Automations、通知、Session 工作库 | 启用前确认时区、凭证、工具网络与 daemon 条件 |
| 自定义 | Skills、MCP、Plugins、Providers、Trust、Usage | 未实现的 Plugin Runtime 保持禁用，模型能力未知时显示“未知” |

## 原型边界

这是目标交互原型，不代表当前 CLI 已具备所有后端能力。暂停/继续、Steer 队列编辑、子代理树形关系、可持久通知、跨重启 daemon 与 Session 归档仍需在应用实现时补齐。

## 本地预览

```bash
python3 -m http.server 4174 --directory output/prototypes/pico-desktop/full-flow
```

打开 `http://127.0.0.1:4174/#work/home`。原型使用原生 HTML/CSS/JavaScript，无构建依赖；正式桌面 App 仍建议采用 Electron + React + TypeScript，并复用现有 TypeScript Runtime。
