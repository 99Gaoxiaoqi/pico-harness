# 统一实验记录

`experiment.ts` 提供 `runExperiment({ spec, directory, execute, signal?, shouldStop? })`。
Spec 声明 subjects × scenarios × repetitions 和不含凭据的 config；execute 返回 measurement 与业务 result。执行串行，奇偶轮交换 subject 顺序。config 应固定模型、提示词、数据集、判分与实现版本；发生变化必须使用新目录。

每个完成的 cell（包括失败/不可用样本）保存一个不可覆盖的 attempt JSON。相同目录续跑只补缺失 cell，不重新抽取失败样本。目录使用独占 `.lock`；进程异常退出留下锁时，确认进程已退出后手动移除该锁。写入使用临时文件再 rename，孤立临时文件不作为有效样本。执行器抛异常会终止本次运行，当前 cell 不落盘；应将已发生的模型/业务失败作为 measurement 返回以保留失败证据。不要在 result/config 中包含凭据。

summary 的 planned 是计划样本数，observed 是已完成样本数，available 是有模型响应的样本数；successRate/errorRate 的分母为 observed，失败样本不剔除。triggerRate 只有完整采样且每次有响应时才非 null。token/cost 同时报告 measured 数；任一样本缺失计量时 total 为 null，不把未知值当 0。cost 使用调用者声明的统一币种（建议在 config 中写明），框架不推算价格。

## Code Mode A/B

```sh
npm run build:packages
RUN_LLM_E2E=1 CODE_MODE_SELECTION_REPEATS=5 \
CODE_MODE_SELECTION_RUN_DIR=output/eval/code-mode-selection-local \
node --import tsx --import @pico/cli/tui/preload-env --test \
tests/e2e/code-mode-selection.real-llm.test.ts
```

相同命令续跑；改变模型配置、工具实现、测试内容或重复次数时换目录。未指定目录会创建独立 UUID 目录。`CODE_MODE_SELECTION_REPORT` 可额外导出汇总 JSON。

仍使用用户默认真实模型，重复次数必须 5–20，连续两次无模型响应则停止；该停止条件会在续跑时保留，恢复服务后如需重新取样应建立新实验，不能覆盖失败记录。原始 baseline、任务提示、guided 成功要求、80% 触发率/20% 误触发率保持不变。失败输出只留在本地 attempt/report，控制台仅汇总。token 来自模型 usage，无法确认完整报告则 null；本路径没有可信费用计量，cost 为 null。

确定性集成验收：

```sh
node --import tsx --test tests/integration/engineering/eval-experiment.test.ts
```
