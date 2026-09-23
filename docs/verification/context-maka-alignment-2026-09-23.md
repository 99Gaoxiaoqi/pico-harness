# Pico / Maka 上下文对齐验收（2026-09-23）

## 基线与范围

固定 Maka 提交 `5846521372d2dd0d3d2d33dc7784dd046dc3f7c8`，Pico 起点 `caad78e4`。读取 Maka 的 `ai-sdk-turn.ts`、`ai-sdk-compaction.ts`、`tool-result-archive-transition.ts` 及输入框／Inspector 实现；不采用其工作区未提交修改，不把 Maka 加入生产依赖。

覆盖现有 OpenAI、Responses、Claude 协议，历史投影、归档、摘要状态机、冻结请求事实、SQLite 派生快照、App/TUI。未新增 Codex 登录或原生压缩。`session.context.get` 仅接受 v3；旧 runSub、字符裁剪 Compactor 及 Host 包装已删除，旧 Evidence 正文和旧摘要格式不再兼容读取。

## 行为矩阵与自动化结果

主集成组 **86/86**，生产装配与持久化组 **14/14**；均为最终生产代码上的确定性集成测试，无跳过。不将重复重跑计入通过总数。

| 验收行为                                                                                        | 对应集成测试                                                                              | 结果       |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| 用户声明窗口、真实 I/O 阈值、路由锚、一次 send 多步、主动失败阻断恢复、图片优先和步骤耗尽       | `engine/maka-compaction-trigger.test.ts`                                                  | 通过       |
| 安全连续前缀、任务锚、滚动摘要、截断／格式修复、已接受边界回退、checkpoint 写失败               | `engine/maka-compaction-summary.test.ts`、`compaction-rolling-digest.test.ts`             | 通过       |
| 2,048／256 阈值、最近两个用户 turn、投影先提交、完整原文、重启、分叉和来源 digest               | `engine/durable-tool-projections.test.ts`、`tools/tool-result-runtime-projection.test.ts` | 通过       |
| 冻结身份／窗口／组成／边界、迟到结算、失败与 Hook／摘要不覆盖、缺失字段不拼接、损坏投影修复     | `runtime/session-context-composition.test.ts`                                             | 通过       |
| OpenAI / Responses / Claude 本地 HTTP → CostTracker → SQLite；usage 缺失、显式零、缓存、失败    | `provider/context-facts-protocols.test.ts`                                                | 三协议通过 |
| 配置 agent_spawn 子会话自动压缩、归档、续接，Hook verifier 独立状态和只读工具                   | `runtime/context-production-subagent.test.ts`、`hook-verifier-compaction.test.ts`         | 通过       |
| 实时 I / 回退 I+O、缓存为输入子集、切换／乱序／错误保留、组成明细和压缩后快照不变               | `desktop/context-maka-ui.test.ts`、`runtime/session-context-checkpoint.test.ts`           | 通过       |
| 一万 canonical 请求下，一千次正常快照读取小于一秒；修复查询走专用索引，无临时排序；查询不添事件 | `runtime/session-context-composition.test.ts`                                             | 通过       |
| 维护 dry-run、v7/v8、事务失败回滚、配置／cron／memory 保留、维护后升级、拒绝未知表              | `storage/context-reset-maintenance.test.ts`                                               | 通过       |

固定基线的事件序列和预期决策固化在 `maka-compaction-trigger`、`maka-compaction-summary`、`durable-tool-projections` 和 `desktop/context-maka-fixture.ts`，而非仅测试阈值公式。旧 schema 兼容升级用例被新版本拒绝／维护后升级用例替代。

此外，子代理验证了 25 条既有 Provider／续接回归、11 条 UI 和 TUI `/context`、2 条真实 daemon TUI 测试。根 TypeScript、Desktop main/preload/renderer TypeScript、全部包构建、根构建、架构检查、存储能力检查、变更文件 ESLint、桌面 arm64 打包均通过。桌面首次下载校验文件遇到网络失败，缓存校验成功后重新打包通过。

## 真实模型

使用已配置的 `opencode-go/glm-5.2`（OpenAI 协议）：5 个 E2E 文件共 **7 项通过，0 跳过**，覆盖自动压缩、单次摘要、滚动摘要、深层滚动、归档回读、配置子代理续用及 Hook。

Hook 与归档首轮 HTTP 连接被重置；仅重跑这两个失败项后通过，没有修改验收阈值。摘要要点召回率分别为 5/6、6/6、8/8，滚动 5/6、深层滚动 6/6。子代理归档绑定修复后，又在最终代码上重跑真实子代理续用测试并通过。

实机切换至 `deepseek/deepseek-v4-flash`（Responses 协议）收到 HTTP 402，失败未覆盖主请求快照。不能据此声称 Responses 真实模型成功验收；Claude 亦仅完成确定性协议验证。当前可完成的真实模型场景已验证，外部账号／服务限制明确保留。

## 本机维护结果

先通过隔离测试，再退出旧 App 并用 `--daemon-stop` 优雅关闭 Runtime。显式清点 112 个旧工作区 SQLite 库（control v7），使用维护脚本 dry-run 后逐库事务执行：

- 清除 1 个旧会话、132 条 Runtime 事件、5 个物理请求及对应轨迹、checkpoint、归档和派生记录。
- 112 库所有旧会话、事件、用量、latest-context 和 checkpoint 表最终均为零，外键检查无错误。
- 6 个用户根文件的内容哈希不变；连接凭证、项目／信任配置、独立长期记忆、业务目录保留。原 cron 定义数为零，脚本保留定义表。
- 外部 asset URI 清单为空，无需删除外部文件；未删除整个 `.pico`。
- 空库通过生产 schema migrator 升为 control v8。一个历史孤立库的设备号绑定与当前磁盘不同，未篡改绑定或自动接管；使用离线显式路径运行同一 schema migrator，保留其绑定原值。

工具入口及约束见 [维护说明](../../scripts/maintenance/README.md)。

## Computer Use 与三端核对

使用真实桌面包新建会话 `cli-mucwvlhd-dc48df42`，标记 `PICO_MAKA_0923`；测试文件仅包含合成行和 `PICO_ARCHIVE_END_0923`。

1. 普通请求：实际输入 6,213、输出 117、缓存 50、冻结窗口 128,000；输入框、Inspector、RPC 与 SQLite 一致。
2. 工具多步：大 read_file 正文完整保存，追加 1 条归档投影；archive_read 回读成功。初始 `/tmp` 安装路径触发沙箱边界拒绝，移至正常应用目录后使用目录参数的 grep 成功；没有放宽安全设置。
3. 手动压缩：当前历史由 14 条变为 1 条摘要，历史估算约 420；最近请求保持 `8,582 / 128,000`，未被摘要请求覆盖。
4. 重启：历史摘要与原 transcript 同时恢复；最近请求身份和上述数值不变。
5. 生产子代理：只读读取第 101 行，再续接同一个 child Session，不再次访问文件仍准确回忆标记。父子各有独立 latest-context 行。临时测试预设已删除，原子代理配置恢复。
6. 切模型／连接：输入框清除旧路由占用，Inspector 继续显示原请求事实；新路由 HTTP 402 后不覆盖它。切回原路线后恢复匹配值。
7. 最终成功请求：实际输入 **13,391**、缓存 **13,219**（输入子集）、冻结窗口 **128,000**；三端请求 ID 一致。当前历史 17 条、估算 4,113，压缩次数 1；请求引用相同 checkpoint。
8. 空闲连续 5 次 RPC 查询，事件／请求／run 数均不变；SQLite 外键检查通过。

最终父请求 `attempt_5493e53e-1d5d-45bb-a54a-a0035d4205a8`；子请求 `attempt_e2cb4550-4da3-4edd-b9fc-19fb7a3978bf`。压缩边界 `checkpoint:9cbfd399-470d-4e5a-8d78-0494680c768f` 覆盖 14 条。

当前安装包位于 `~/Applications/Pico.app`。保留新建验收会话便于查看；旧会话未恢复。

## 日志与文档

本机日志：`/tmp/pico-context-integration.log`、`/tmp/pico-context-final-production.log`、`/tmp/pico-context-validation-a-real.log`、`/tmp/pico-context-validation-a-retry.log`、`/tmp/pico-context-final-child-real.log`。维护清单与执行报告：`/tmp/pico-context-maintenance-{dry,result}.json`；最终 RPC／SQLite 核对：`/tmp/pico-context-cu-final.json`。

已同步功能说明、上下文／子代理／架构技术博客及 README，重绘 4 张技术博客 SVG/PNG；实际用量、历史估算和请求组成字节估算分开标注。本轮是指定行为矩阵的通过记录，不是线上自然压缩触发率实验。
