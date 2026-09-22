# 上下文压缩：Maka 机制移植

完整实现原理、失败语义和源码导航见 [Pico 上下文压缩技术详解](../pico-context-compaction-technical-guide.md)。

参考用户本地 Maka `584652137`。移植运行中的主会话上下文策略，接入 Pico 的 Runtime 事件、Provider、权限和 `archive_read` / `read_file`；不引入第二套事件库或 Evidence CAS。

## 触发与恢复

- 仅用户模型配置显式声明的 `capabilities.context` 是主动压缩窗口；Provider/profile 默认窗口用于预算，但不触发主动压缩。
- 使用同一模型、同一连接最后接受请求的真实 `input + output + min(2 × output, 8000)` 对比声明窗口；无可靠 usage 时不主动压缩，不用 BPE 冒充实际容量。
- 接受请求的 usage 锚随助手消息持久化，重启可以恢复；切换模型/连接不复用旧锚。
- 工具批次完成后、下次模型请求前选择最大安全完成前缀，不能拆开 tool call/result，不能覆盖未完成交换。当前任务文本保留原文，当前图片和实时 steering 保留在未压缩尾部。
- Provider 真正报告上下文溢出时，每个未获接受的请求最多恢复一次：优先移除旧任务的工具图片，否则安全摘要后重试。接受新的模型步骤后重新开放恢复机会；摘要失败在本轮锁存，避免重复花费。
- 压缩失败保留原历史；重试仍溢出则报告真实错误，不再硬重置主会话或伪造成功。

## 摘要与 checkpoint

- 采用 Maka 的 Goal / Progress / Key Decisions / Next Steps / Critical Context 格式，正文可用中文，保留路径、命令、错误、约束和未完成工作。
- 摘要请求预算为最多 8000 输出 token，受实际模型路线输出上限约束。不再按 1500 字符裁剪正文，也不在摘要输入中截断每条原文。
- 校验必需章节、顺序、有效内容、截断迹象；首次折叠输入超过 10000 实际 token 时，输出至少 200 实际 token。滚动摘要不套该最低长度。
- 输出截断允许一次缩短重试，格式缺陷允许一次修复；仍不合格不写 checkpoint。
- 摘要请求自身溢出时，仅允许退到同路线最后实际接受的历史前缀边界一次，没有证明边界则保留历史。
- checkpoint 保持不可变事件、来源摘要校验和滚动更新。新格式标记 `sections_v1`，写入与加载验证；旧格式仍可读取。

## 工具输出归档与回读

- 保留 1 MiB 单次结果入口限制；超限结果仍拒绝，指引分段重取。
- 适用成功结果超过 `2048 × 4 = 8192` 个序列化字符时，原文与有界归档投影在同一事务保存。错误及带 Recovery 提示的结果保持原处理。
- 归档写入和回读工具是一组能力：每一步只有实际可见且绑定当前会话 reader 的工具存在，才允许归档；工具被裁剪时恢复完整 inline 原文，不留下无法回读的新占位符。
- 使用 `pico://archive/<session>/<event>/<sha256>/<bytes>` 定位，模型调用 `archive_read` 做 inspect、search、query 和按字符/行 read；offset 从 0 开始，limit 默认 4000、最多 6000，完整 JSON 响应最多 7500 字符。`read_file` 兼容归档 URI，offset 从 1 开始、limit 最多 6000 个 JavaScript 字符，按 nextOffset 续读；普通文件仍按行分页且最多 1000 行。
- URI 绑定当前会话并验证原文哈希、字节数；不开放跨会话访问。重启可回读，fork 会重新绑定子会话 URI。
- 旧 inline 历史无需迁移：保护最近两个 turn，其余适用结果在 checkpoint 验证后生成归档投影，不改变原始事件或摘要来源校验。

Maka 使用独立 archive/transition；Pico 的适配把新原文与投影放在已有原子事件中，旧事件视图确定性重建，避免额外双写。旧 `read_evidence` 不恢复。Graph／配置型子代理复用同一会话引擎。Hook 验证器也使用独立持久化子会话，接入相同 usage 窗口、FullCompactor 与会话绑定归档读取；保持只读工具、取消信号、Hook 计费归属，且不挂载 Hook 服务以防递归。最后一次无工具收尾包含在 Hook maxTurns 限制中。旧 `runSub` 私有压缩仍作为兼容接口保留，但仓库内生产调用已迁出。

## 验证

本次相关集成与回归共 96 项通过；包构建、根项目和桌面类型检查、ESLint 与架构边界检查通过。

相关集成覆盖声明窗口与路由锚、摘要质量和滚动更新、工具安全边界、中断恢复、失败不重置、当前图片保留、归档搜索/条目查询/按行与字符读取、完整性/隔离/重启/fork，以及三种 Provider 协议的生成和流式输出预算。

真实模型测试使用用户默认路线，不修改用户配置：

```sh
npm run build:packages
node scripts/run-integration-tests.mjs maka-compaction compaction-rolling-digest compaction-review-fixes compaction-output-budget interrupted-history-resume tool-result-runtime-projection archive-read-tool read-file session-fork
RUN_COMPACTION_E2E=1 node --import tsx --import @pico/cli/tui/preload-env --test tests/e2e/compaction-auto-trigger.real-llm.test.ts tests/e2e/compaction-quality.real-llm.test.ts tests/e2e/tool-result-archive.real-llm.test.ts
```

若本机联网依赖系统代理，需让测试进程使用既有代理。OpenCode Go 路线的直接 Provider 测试必须携带独立 `sessionId`，与生产 Runtime 的会话头保持一致。

### 本次真实模型记录

默认路线 `opencode-go/glm-5.2`。三组单步摘要的事实锚点召回为 6/6、6/6、8/8；滚动摘要为 6/6，三轮滚动后仍为 6/6。真实 usage 触发后，模型能准确完成原任务并返回随机标记。归档搜索仅调用一次 `archive_read` 就找回了预览之外的随机标记，工具错误为 0，工作区文件不变。

这些是受控样本结果，不代表任意长任务都不会遗忘。早期验证先遇到直连 ECONNRESET，随后遇到测试夹具缺少 OpenCode 会话头的 HTTP 400；使用本机已有系统代理并为直接 Provider 测试补 sessionId 后重新通过。未修改用户 Provider 配置，也未把失败尝试计为通过。
