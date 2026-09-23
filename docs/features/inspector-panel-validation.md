# 追踪面板改版验证记录

基线：`f07955f800862a2656520b099904d033169dfe0d`。范围为 Renderer 追踪面板及相关测试，不改变 Runtime、Provider、数据库或现有会话数据。

## 分工与集成

主代理串行固定公共组件接口、页签容器、会话切换和样式装配。三个子任务分别负责总览、时间线及真实 Electron 验证，使用独立 worktree 和唯一任务分支。主代理在独立集成分支合并，并完成最终检查和桌面验收。

## 自动化结果

| 验证                                                                                                       | 结果                                                                       |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `desktop-execution-trace`、`context-maka-ui`、`inspector-overview-redesign`、`inspector-timeline-redesign` | 9 条通过                                                                   |
| 既有 Workbar 中 Host、Inspector、helpers、honest 相关测试                                                  | 5 条通过                                                                   |
| 生产 IPC／daemon／SQLite 的执行轨迹 Electron 测试                                                          | 通过；历史分页覆盖 68 次运行，实际刷新延迟 538ms；验证重连、失败恢复和复制 |
| 追踪面板 Electron 交互测试                                                                                 | 通过；独立滚动、页签键盘操作、折叠选择、刷新状态和会话切换                 |
| 320／480／640px × 浅／深色 × 两页签                                                                        | 12 组通过，无横向溢出；最低普通文字对比度 4.95:1                           |
| 桌面类型检查、根 TypeScript 检查、架构边界检查                                                             | 通过                                                                       |
| 变更文件 ESLint、Prettier                                                                                  | 通过                                                                       |
| macOS arm64 桌面打包                                                                                       | 通过                                                                       |

测试覆盖用量缺失、缓存部分上报、零值、未知费用、组成剩余字节、当前历史独立口径、真实存储的运行／轮次／步骤归属。页签切换和展开只改变本地状态，不额外查询或触发模型执行。

复现入口：

```sh
node --import tsx --test tests/integration/desktop/desktop-execution-trace.test.ts tests/integration/desktop/context-maka-ui.test.ts tests/integration/desktop/inspector-overview-redesign.test.ts tests/integration/desktop/inspector-timeline-redesign.test.ts
node --import tsx --test --test-name-pattern='Workbar Host|Inspector|helpers|honest' tests/integration/desktop/desktop-workbar-tool-panels.test.ts
node --import tsx --test --test-concurrency=1 tests/integration/desktop/desktop-execution-trace-electron.test.ts tests/integration/desktop/inspector-redesign-electron.test.ts
npm run desktop:typecheck
npm run typecheck
npm run check:architecture
npm run desktop:package
```

Electron 测试需要可用的 Electron；可通过 `PICO_TEST_ELECTRON` 显式指定可执行文件。本次使用本机 Electron.app，并在隔离测试目录中运行确定性场景。

## 实际桌面验收

打开新打包的应用，用 Computer Use 检查已有会话：最新运行展开、`grep` 原地输入输出、最近请求 `13,391 / 128,000`（10.5%）、会话累计 128,385 Token、当前历史约 4,113 Token／17 条消息／1 次压缩。切换总览和滚动检查均正常。

正式安装路径 `/Users/anxuan/Applications/Pico.app` 已更新。重启后重新打开既有会话，追踪默认显示时间线，新页签和历史记录正常加载。

本次只读取既有会话，没有删除或重新生成本机会话；没有发送新的真实模型请求。上述 UI 改版不以真实模型调用作为确定性测试的替代。[视觉验收与截图](../../design-qa.md)保存了完整对照依据。

根类型检查首次因 worktree 共用 `node_modules` 解析到两份 `@pico` 私有类型而失败；将当前 worktree 的工作区包指向自身，并按 `npm run typecheck` 执行预构建后通过，没有为此修改产品代码。

## 已复现的基线问题

完整 `desktop-workbar-tool-panels.test.ts` 有一条与本次无关的 Files 断言失败：断言期待原始 `# Report`，现有 Files 实际输出渲染后的 `<h1><span>Report</span></h1>`。在未改动的 `f07955f8` 上按同一用例复现。本次未修改 Files，也未修改该断言；因此不声称完整 Workbar 套件或全仓测试全部通过。
