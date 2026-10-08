# Pico 记忆优化方案与验收

## 目标与范围

改进本地 SQLite 记忆的召回、更正和观测，继续使用当前 Memory Item、用户级策略与工作区隔离。数据库保持 schema v9；不引入 Mem0 服务、向量库、迁移或自动覆盖旧事实。

## 实施方案

1. 召回：保留 key exact/prefix 优先级，增加正文词法检索（完整英文词、路径、至少两个中文双字信号），扫描所有可见活跃项，仅加载最多 100 条匹配候选的完整记录。无匹配行跳过分词。
2. 自动上下文：最多 3 项、320 tokens，包括低信任包装、XML 转义和时间来源标识。助手笔记可按原文锚点摘录；普通长条目自动跳过。
3. 主动检索：新增只读 `memory_search({query})`，固定最多 3 项、1600 tokens，每项最多 480 tokens。按原文摘录并记录 code-point 半开区间，不能提供工作区或扩大预算。执行前后检查信任和记忆开关；Plan、Research、Responses 可读，隔离 headless、子代理及 graph operator 不开放；后台任务仍需显式允许该工具。
4. 查询预览：记忆页输入问题，使用与自动召回相同的 builder，展示实际引用片段、完整注入文本、预算和选择/重复/超预算/项数原因。请求序号及上下文标识防止迟到响应覆盖新结果。
5. 更正：记忆页显式编辑内容、类型、陈述类型和事件日期，使用原版本 CAS。省略日期保留原值；清除必须提交 `undated/null/null`。人工更正清除旧来源引用，保留原观察时间，最近修改时间不代表事件发生时间。
6. 投影去重：仅去除同作用域、种类、来源类别及原文完全相同的无日期 fact；不改数据库、不合并日期事件、不去重助手参考笔记。
7. 提取观测：真实处理段的 trigger、operationId、stage 跟随辅助模型调用进入 physical usage ledger 和费用页。成功结算 receipt 保存创建数、模型调用数、耗时；观测字段不参与请求幂等哈希。删除条目不改变历史创建数。
8. 用户统计：`memory.metrics.get` 默认最近 7 天，按 remember/extract/compaction 显示结算段、有效评估段、历史创建数、调用数、空提取率及累计耗时。无有效评估率为 null；旧无观测 receipt 独立标为未知；未知费用继续显示未知。

## 验收标准

| 项目       | 可验证标准                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| 漏召回回归 | 缺 key 的相关正文、最近 500 项之外的旧笔记命中；已归档及其他工作区内容不泄露                                               |
| 预算与原文 | 自动 ≤320、主动 ≤1600、主动单项 ≤480 tokens；XML 完整；引用范围精确对应原文；未合成摘要                                    |
| 权限与模式 | 正常 Agent/Plan/Research/Responses 可读；关闭召回、撤销信任和受限 allowedTools 拒绝；零辅助模型调用与零记忆写入            |
| 时间更正   | 默认保留日期，非法边界不保存，清除提交完整空边界，陈旧 CAS 失败，内容更正清来源且保留观察时间                              |
| 预览与 UI  | 与同参数 builder 的 block、references、diagnostics 和 token 数一致；更正失败保留输入；迟到/工作区/策略改变无旧结果覆盖     |
| 统计与归因 | 重放不重复计数，删除后历史计数保留，旧 receipt 未知，零调用不进入空提取率分母；Provider→ledger→UI trigger/stage 对应实际段 |
| 真实模型   | 用户默认模型实际执行自动提取、保存及跨会话召回、注入抵抗、主动检索长笔记和日期区分；无跳过、不替换默认模型                 |
| 性能       | 临时库 10000 项，每项 2000 code points，10 次预热、100 次完整主动检索；P95 ≤200ms                                          |

## 验证命令

运行前重新构建工作区包，确保测试没有引用旧 dist：

```sh
npm run check:storage
npm run build:packages
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json
npm run desktop:typecheck
node --import tsx --import @pico/cli/tui/preload-env --test --test-concurrency=1 tests/integration/memory/*.test.ts tests/integration/desktop/desktop-usage-dashboard.test.ts tests/integration/desktop/desktop-usage-ui.test.ts tests/integration/desktop/desktop-automation-tool-policy.test.ts
RUN_LLM_E2E=1 node --import tsx --import @pico/cli/tui/preload-env --test --test-concurrency=1 tests/e2e/atomic-memory-runtime.real-llm.test.ts tests/e2e/atomic-memory-behavior.real-llm.test.ts tests/e2e/atomic-memory-search.real-llm.test.ts
node scripts/eval/atomic-memory-recall-benchmark.mjs
```

## 结果

最终验收结果见同目录验收记录。实现和测试在独立集成 worktree 完成；原工作区的既有桌面修改不纳入任务提交。
