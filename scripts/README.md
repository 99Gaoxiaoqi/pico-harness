# 工程脚本

从仓库根目录运行。构建和 CI 的稳定入口见根 `package.json`。

| 位置                                       | 负责内容                                                |
| ------------------------------------------ | ------------------------------------------------------- |
| `run-integration-tests.mjs`                | 递归发现集成测试，按稳定顺序串行运行；支持名称/路径筛选 |
| `check-*.mjs`                              | 存储能力与架构依赖检查                                  |
| `build-*.mjs`、`verify-*.mjs`              | 跨平台 sandbox 构建与包资源校验                         |
| `run-desktop-forge.mjs`                    | Desktop 开发与打包入口                                  |
| `model-pricing/`、`sync-model-pricing.mjs` | 价格快照与生成数据同步                                  |
| `terminal-bench/`                          | 独立 benchmark 运行、采集与校验                         |
| `diagnostics/`                             | 手动诊断与压力复现，不由常规测试自动执行                |

测试入口：

```sh
npm run test:integration
npm run test:integration -- memory/
node scripts/run-integration-tests.mjs --list
node scripts/run-integration-tests.mjs --list --windows
```

默认递归包含 `.test.ts` 和 `.test.tsx`，排除 `windows/` 专项；Windows CI 保留原专项入口。筛选结果为空时以失败退出，避免漏跑被当成成功。

诊断探针默认使用 `PICO_HOME` 或 `~/.pico`，也可指定路径。它会读取诊断日志和工作区状态；host 未运行时可能启动它。`--help` 仅显示用法。

```sh
node --import tsx scripts/diagnostics/probe-daemon.ts --help
node --import tsx scripts/diagnostics/probe-daemon.ts --pico-home /path/to/pico-home
```

`diagnostics/stress-daemon-diag.ts` 用临时数据根和不可用模型端点复现连接压力，不需要真实模型；运行方式见文件头。
