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

## Atomic Memory 本地召回基准

先在当前 checkout 安装依赖并构建，避免链接到其他 worktree 的旧 dist：

```sh
npm ci --ignore-scripts
npm run build:core && npm run build:storage && npm run build:runtime
node scripts/eval/atomic-memory-recall-benchmark.mjs > /tmp/memory-recall-benchmark.json
```

默认每个独立子进程创建临时 SQLite：1k/10k/50k facts（80% 当前 workspace、10% 其他 workspace、10% global），另加 20 个经真实 API 审批的方法和 20 个案例。每个规模固定 40 个 query，先单列首次 build（包括 tokenizer 冷启动），再串行重复 5 轮；没有预热剔除，也不读取用户 DB 或调用模型。`MEMORY_BENCHMARK_SIZES=1000` 可运行相同采样规则的快速检查。

输出保留全部样本、fixture/query SHA-256、总 build 与 content search 的 p50/p95、SQLite 正文评分实际遍历行数、key/resident 返回行数、RSS 高水位和临时 DB 大小。content search 时间包含生产 Store 调用等待，不等于整个 build；正文扫描计数通过包装原有 SQLite `iterate` 观察生产全正文评分 SQL，不把 top-100 返回行数当作全表扫描量。case 保存在真实 Store 中，不冒充可投递 method。fixture hash 覆盖确定性输入（不含 Store 随机 ID）；冷启动是新进程首次 build，OS 文件页缓存不受控。计时保留统计结果供验收比较，不因机器性能不同而让脚本退出失败；结果内容和 token 预算有断言。临时数据库在完成后删除。

最终生产比较直接运行默认入口，不加外部 revision/index wrapper。`cold` 保留第一次完整 Builder 调用，因此包含该次发生的脏索引初建成本；`firstQueries` 汇总 cold query0 与首轮其余39个首次查询，`repeatedQueries` 单列后4轮160次重复查询。`contentSearchCalls` 与正文扫描行数分别报告，不能把索引查询与全正文扫描混计。数据库同时报告逻辑页大小、主文件及 WAL 文件大小；逻辑大小与磁盘文件大小口径不同，不相加当作一份逻辑数据。
