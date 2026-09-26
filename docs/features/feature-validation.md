# 功能验收记录

日期：2026-09-21。Pico 基线 `c3936b85`。实现来源见[第三方声明](../../resources/licenses/THIRD_PARTY_NOTICES.md)。

## 结果

| 范围           | 验收                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一评测层     | subjects × scenarios × repetitions、配置指纹、不可覆盖 attempt、续跑、失败样本保留、缺失计量为 null                                                                  |
| Code Mode 实测 | `opencode-go/glm-5.2`，3场景 × 5重复 × 2版本，共30次；guided批量10/10触发、单文件0/5；30/30回答正确。baseline保留一次exec错误后恢复。续跑零新增，30份attempt哈希不变 |
| 产物富预览     | Markdown/源码、交互HTML、PNG/JPEG/GIF/WebP/AVIF、PDF、diff；大小边界、伪图片拒绝、Blob清理；真实Electron验证内联交互可用，父页面访问、联网、弹窗、导航被阻止         |
| 研究工具与桌面 | 8工具、来源引用、4检查项、5报告章节、持久化检查点、完成门、研究进度和新建实施任务入口；重启读回、幂等、隔离、历史产物分页与只读守卫                                  |
| 研究真实模型   | 同一模型两轮完整研究，约306秒，10件产物、1个探索步骤、2个检查点，8个研究工具均有成功调用；28次工具结果，最终completed，项目文件不变                                  |

研究真实验证中，模型发生3次可恢复错误：checkpoint将数组参数传错、重复更新已终结检查项、将派生笔记误当原始source引用。校验均拒绝，模型读取错误后纠正，未放宽完成门或来源约束。

早期一轮研究验证遇到Provider超时；诊断轮发现 `exclusive_step` 导致独立读调用被不必要拒绝，该轮主动停止。改为同步SQLite事务下允许独立调用同一步执行后，在最终实现上重新完整通过。初始错误记录未作为成功样本计数。

Code Mode比例仅适用于受控场景，不代表生产任务总体触发概率；本路径没有可信费用计量，cost为null。完整Code Mode口径见 `tests/e2e/code-mode-selection-results.md`。

## 已执行检查

- 56项相关集成：研究工具与Host、评测框架、Plan运行时/协议/准入回归、Session设置、权限与进程沙箱、CLI模式、工作栏协议。
- 6项产物集成：生成文件交付、分块渲染、非法数据拒绝、真实Electron、资源通知。Electron测试未skip。
- 1项真实模型研究闭环；30个真实Code Mode样本及一次不重新调用模型的resume验收。
- 包构建、根TypeScript检查、Desktop main/preload/renderer类型检查、ESLint与架构边界检查、存储能力检查。

## 复跑

```sh
npm run build
node scripts/run-integration-tests.mjs deep-research eval-experiment plan-mode-runtime plan-mode-ui-protocol plan-mode-host-admission session-settings-fail-closed runtime-process-sandbox permission-profile settings-commands workbar-runtime-protocol
PICO_TEST_ELECTRON=/path/to/Electron node --import tsx --test tests/integration/desktop/desktop-artifact-preview.test.ts tests/integration/desktop/desktop-artifact-delivery.test.ts tests/integration/desktop/workbar-resource-continuity.test.ts
RUN_LLM_E2E=1 node --import tsx --import @pico/cli/tui/preload-env --test tests/e2e/deep-research.real-llm.test.ts
```

真实模型研究会在临时目录写不含凭据的逐工具记录，可用 `RESEARCH_E2E_REPORT` 指定位置。评测矩阵命令见 `scripts/eval/README.md`。
