# 提交与全方位验证（2026-09-10）

基线：`08bfba80`。本次用户明确要求提交此前保留的 Desktop / Memory 修改、配套测试及子智能体图文文档。验收环境为 macOS arm64、Node 26.7.0。

## 结论

代码保存到独立任务分支，暂不合入 main：确定性检查、静态检查、构建和桌面交互通过，但本次完整真实模型套件仍有 1 项 Plan Graph 失败。没有修改失败断言、放宽工具 Schema 或用重跑覆盖失败记录。

## 提交范围

- 用户级记忆设置页与可省略 workspacePath 的设置 API；记忆内容仍按工作区隔离。
- 统一用户级记忆开关，旧项目设置不再继承，首次保存时事务清理旧配置。这是本次既有修改及新增测试明确约定的迁移语义。
- 健康页区分配置状态与连接验证；扩展管理使用用户级范围。
- 同步路由/UI/存储测试，补充子智能体技术图解和六张 PNG 及可编辑图源。

## 执行结果

| 范围                       | Tests | Pass | Fail | Skip |
| -------------------------- | ----: | ---: | ---: | ---: |
| 当前工作区常规集成         |  1636 | 1624 |    0 |   12 |
| 独立集成目录同一快照复验   |  1636 | 1624 |    0 |   12 |
| Windows 专项（macOS 宿主） |    19 |    1 |    0 |   18 |
| 真实模型相关全套，含压缩   |    50 |   43 |    1 |    6 |

两次常规集成不可叠加计数。确定性测试共 1655 个独立用例：1625 通过，0 失败，30 平台跳过。真实模型相关套件包括 25 个实际模型场景通过、1 个实际模型场景失败、18 个确定性检查通过；耗时 318.2 秒。使用既有默认 `deepseek/deepseek-v4-flash`，未变更用户配置。

当前工作区及独立集成目录的 `lint`（含架构）、`typecheck`、`desktop:typecheck`、`build`、全量格式检查均通过。生产及全部依赖 audit 均报告 0 漏洞。当前平台 sandbox 资源清单检查通过；六张 PNG 均能读取尺寸，关系图已抽查。

## 唯一真实模型失败

`tests/e2e/plan-agent-graph.real-llm.test.ts` 在 `planning.submit` 阶段 120 秒超时。模型成功读取 TASK.txt 后，连续 5 次 `submit_plan` 被拒绝，错误为 `data must have required property 'steps'`。Graph 尚未创建，claims / records 均为 0；其余普通 Plan Mode、Graph v2、Memory、Runtime、TUI 场景通过。

静态核对发现：生产 Schema 明确要求 title / steps，测试写入的示例也包含完整 steps，Provider 使用 `jsonSchema(t.inputSchema)` 转交定义，未发现字段漂移。证据倾向模型未遵循 Schema，但日志没有保存 toolCall.arguments，临时 DB 已被测试自身清理，不能彻底排除传输转换问题，也不能认定这是本次 Desktop / Memory 改动引发的回归。

下一步应先保留脱敏参数结构与最终发送的 Schema，再做有对照的单例诊断；不能直接放宽 Schema、延长等待或只挑选成功重跑结果。

## 原生桌面交互

通过独立 PICO_HOME 和 Electron user-data-dir 启动，未修改用户真实设置：

- 无项目时可打开用户级记忆页；关闭记忆、刷新后保持关闭，再恢复开启。SQLite 确认 version=3、enabled=1。
- 健康页正常展示 Runtime 状态、未验证的模型连接及凭证问题；扩展页为用户级 MCP 范围。
- 两轮真实对话完成：search_tools 查询工具，以及 exec 嵌套 read_file 读取合成 canary，显示 `PICO_DESKTOP_CANARY_20260910`。
- 查询返回 activated=[]，没有产生新工具激活；本次不能宣称已通过协作启用卡的人工展示验收，该兼容逻辑由集成测试覆盖。
- 只读账本确认这两轮的 4 条工具操作全部 settled，无 prepared，也没有写入或委派调用。
- 检测到用户开始操作测试窗口后停止 UI 自动操作，隔离窗口和测试数据暂时保留；配置副本仅位于测试目录，权限 0600，不进入 Git。

## 未覆盖环境与证据

Docker daemon 未运行，因此未执行 Docker 运行期、Terminal-Bench secret FD 和完整容器 benchmark；Linux/Windows 实机未验证。真实模型 6 个跳过项为 Gateway cache、缓存 benchmark、Anthropic cache、OpenCode Free、Windows PowerShell、默认模型不支持的图片输入。Code Mode 审批等待仍计入 30 秒 Cell 预算，本次未改变。

日志：

- `/tmp/pico-submit-integration-VESaEj/integration.log`、`windows.log`
- `/tmp/pico-submit-models-cWuqbp/real-llm.log`
- `/tmp/pico-submit-validation-vaBCZP/clean-integration.log`、`desktop.log`、`format.log`、`audit-prod.json`、`audit-all.json`

独立聚焦审查没有发现可证实的 P1/P2；审查结果不替代上述失败测试。
