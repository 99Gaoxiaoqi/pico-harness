# 测试目录

集成测试按主要行为所属领域归类，文件名保留原名以便检索。跨领域测试按主要验收对象归属，不复制测试。

| 目录                                | 验证范围                                      |
| ----------------------------------- | --------------------------------------------- |
| `integration/memory/`               | 原子记忆提取、召回、管理与宿主生命周期        |
| `integration/desktop/`              | Desktop 页面、协议与桌面业务服务              |
| `integration/engine/`               | 主循环、上下文压缩与子代理执行                |
| `integration/graph/`                | Graph 编排、持久化、恢复与权限                |
| `integration/provider/`             | 模型协议、配置、凭证、缓存与用量              |
| `integration/runtime/`              | 宿主、Session、运行生命周期、Plan 与恢复      |
| `integration/storage/`              | SQLite、文件状态、备份和恢复边界              |
| `integration/safety/`               | 审批、Hook 信任、文件与进程安全               |
| `integration/tools/`                | 工具、MCP、Plugin 与结果投影                  |
| `integration/tui/`                  | CLI/TUI 输入、命令与展示                      |
| `integration/engineering/`          | 构建契约、架构约束、测试入口与 benchmark 工具 |
| `integration/windows/`              | Windows 原生专项，独立入口                    |
| `integration/helpers/`、`fixtures/` | 共享装配和进程测试夹具                        |
| `e2e/`                              | 真实模型场景，独立显式执行                    |

从仓库根目录执行：

```sh
npm run test:integration
npm run test:integration -- memory/
npm run test:integration -- desktop-session
node scripts/run-integration-tests.mjs --list
npm run test:integration:windows
npm run test:llm-e2e
```

常规集成入口递归发现 `.test.ts` / `.test.tsx`，默认不包含 Windows 专项。筛选参数按路径或文件名子串匹配，多个参数取并集；无匹配以非零状态退出。真实模型测试不纳入常规集成入口。
