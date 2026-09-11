# 全量回归问题修复

> 归档说明：本计划已完成实现与最终验收，仅保留为阶段性修复证据，不定义当前待办。

基线：`aa14bab5`。只处理 2026-09-10 全量测试已定位的问题，不降低 Schema、权限、提交或抗注入边界。

## 分工与验收

- [x] 合同迁移：Graph / Turn 测试迁移到当前公开接口；桌面识别 JSON 工具加载回执并保留旧历史兼容；披露门拒绝与 safety 统计分开验收。
- [x] Plan / Graph：补足合成 canary 的一次性审批，按公开 Schema 和运行时生成标识验证两个独立分支各执行一次；保留脱敏执行诊断。
- [x] TUI / 记忆 E2E：补足交互审批、失败等待诊断，抗注入使用可观察结果契约而非误伤拒绝说明；修复 Graph 完成后遗漏持久化水位通知，保留内部运行边界隐藏。
- [x] 工程：通过宿主注入子执行器消除循环依赖；重新生成 benchmark 依赖锁及校验和；修复已有六项格式问题。
- [x] 集成：独立分支合并后运行全套确定性测试、相关真实模型、类型/构建/架构/格式检查。
- [x] 当前工作区：与用户未提交 UI 设计相关的三份测试文件单独调整并验证，不提交用户原有修改；相关 UI / Memory 集成 19/19 通过。

用户原工作区已有 Desktop / Memory 修改。干净分支只提交独立修复；依赖未提交 UI 的测试调整保留本地，不能在缺少相应 UI 实现的 main 上制造新失败。

## 风险与范围

运行时只改可复现问题，失败结果不被伪装为通过。保持真实默认模型与合成临时工作区。Docker、跨操作系统、无配置 Provider 的缺失环境不能通过改测试假装验证；保持未覆盖说明。

## 已确认的根因与边界

- Desktop 工具启用卡仍解析旧中文回执，未识别当前 JSON；现兼容两种格式，拒绝错误、截断和不属于协作组的内容。
- Graph 隐藏内部 Run 边界时提前返回，遗漏终态 transcript 通知；账本已有 assistant 回复而客户端无法推进。新增断言在旧实现失败，补发通知后真实 TUI 首回合、设置收敛和回复均通过。
- Plan 写文件缺少测试审批交互，不是 CAS 失败；保持默认权限，只对合成 canary 路径及内容放行一次。
- 历史 Graph 某个子 Run 长时间运行的确切原因不可追溯，不能把 fixture 规范化称为生产并发修复。
- Code Mode 人工审批等待仍计入 Cell 的 30 秒预算；本次未改变这项行为。实际 Docker、Linux/Windows 平台与无凭证 Provider 的验证仍需相应环境。

## 最终验收（2026-09-10）

| 范围                                 | tests | pass | fail | skip |
| ------------------------------------ | ----: | ---: | ---: | ---: |
| 干净集成分支常规集成                 |  1634 | 1622 |    0 |   12 |
| 原工作区常规集成（含用户原有修改）   |  1636 | 1624 |    0 |   12 |
| Windows 专项（macOS 宿主）           |    19 |    1 |    0 |   18 |
| 真实模型相关套件首次最终回归，含压缩 |    50 |   43 |    1 |    6 |
| 修复 tracer 后集成分支定向复验       |     1 |    1 |    0 |    0 |

原工作区确定性集成合计 1655 项：1625 通过、0 失败、30 平台跳过。真实模型相关套件的唯一失败为 tracer 将正常回复“好的”误判为缺少字面值 `ok`；预先保存的账本确认 Run 和模型均成功。仅该测试迁移到新回合观察器，保留 running 回调、重命名、状态和中断验收，随后在任务分支与集成分支各通过一次。按每项最后结果去重为 44 通过、0 失败、6 跳过，其中 26 项真实模型场景、18 项确定性检查；不能将其描述为同一次全套命令 44/44 通过。

- 干净分支 `lint`（含架构）、`typecheck`、`desktop:typecheck`、`build`、全量格式检查通过；原工作区根类型与 Desktop 类型检查也通过。
- Terminal-Bench 专用锁及摘要检查通过，最终构建器实际生成分发包；锁摘要为 `581e5e05ab4f454374919b83bc99cc8f83cb5482c2bb346ff7e33ebdaaf12d33`。
- 依赖用户未提交 UI 的 `desktop-capability-scope-ui.test.ts`、`desktop-maka-navigation-contract.test.ts`、`desktop-memory-ui.test.ts` 只留在本地，不混入干净提交。
- 日志目录：`/tmp/pico-full-repair-hdPWJH/`。主要证据为 `final-integration.log`、`original-final-integration.log`、`windows.log`、`final-e2e.log`、`tracer-live-diagnostic.json`、`integrated-tracer-final.log`。修复前 Graph 断言失败及修复后通过分别在 `graph-transcript-before.log`、`graph-transcript-after.log`。
