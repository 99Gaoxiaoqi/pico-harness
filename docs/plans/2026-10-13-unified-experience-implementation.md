# Pico 统一经验闭环实施记录

2026-10-13。依据用户批准的《Pico 统一经验闭环修复与交付计划》实施。

- [x] 保存当前 165 项既有改动的完整基线及文件哈希；创建独立集成、Runtime、存储、桌面工作树。
- [x] 冻结三来源公共契约、v13 迁移和新 capability/RPC；旧 v2 结果保持原形。
- [x] 集成 Runtime 开关拆分、实际引用和原生逐次效果记录。
- [x] 集成公共账本、删除、并发屏障和 Excel 目标覆盖验证。
- [x] 集成桌面审核、草稿、入口与统一效果展示修复。
- [x] 相关集成测试、类型检查、真实模型跨会话闭环。
- [x] 重新打包、Computer Use 验证和实际安装版交付。

默认保留旧 memory_learn 三次成功自动保存；普通事实/笔记不增加自动效果验证。效果记录不增加模型调用或重跑工具。只有实际 Provider 请求携带片段才显示已引用。

开发基线位于 `/tmp/pico-unified-20261013-1791872509/baseline`，清单为同目录 `manifest.json`。集成仅采用相对该基线的本轮增量；不提交已有用户修改。

公共存储 `SqliteMemoryItemStore.experienceLedger` 实现 `ExperienceLedgerStore`。公共表为 experience_uses、experience_effects、experience_feedback、experience_diagnostics；v12 通用引用保留结论并标记历史、交付未知，不补造时序，不授权自动停用。

回退不得降级 v13 数据库，不恢复已删除内容；迁移用户数据库前备份。

验证记录：

- 相关桌面与 Runtime 集成 15/15 通过；存储、迁移、权限和协议专项回归通过；全仓源代码与测试类型检查通过。
- 真实 Excel 模型跨会话闭环：旧附件错误 20，用户纠正后 30；审核后新附件得到 18。新会话关闭自动学习仍记录实际引用、采用与范围验证。最后只生成回答的独立引用保持未知，未冒认成功。
- 真实 Node 模型闭环：自动学习命名测试的精确条件，新会话执行前应用，公共账本记录实际引用与当前命名测试验证通过。
- 对抗审查复现的权限撤销竞态与总开关关闭后读取问题已修复；实际打包 UI 已验证审核、冲突保草稿、更正 v2、验证重置及停用。CUA 发现的 Host/Engine Run 展示关联与片段 XML 直接展示问题已修复，追加 6 条界面回归通过；管理跳转实际点击正确，AX 显示的转义不是导航错误。

升级只追加 v13 表并事务迁移 v12 记录，不补造原生或旧经验的历史引用。新版本未知来源排除召回；关闭学习保留历史管理，关闭总开关禁止新增读取与状态控制。

交付：

- 最终桌面包已替换 `/Users/anxuan/Applications/Pico.app`，实际 app 与 daemon 进程均从该路径运行。资源指纹 `23e2fd4614d46065c96953010ca2adbd11b4b9bdaf40f64654d39af56c059173`；Runtime capability 包含 `memory-experience-feedback-v1`，公开协议仍为 v2，Desktop schema 仍为 18。
- 本机安装版原 DB 是 v9，已备份后升级到 v13，integrity_check=ok；专项测试另验证 v12→v13 原结论迁移及事务回滚。原有草稿“1”、enable/autoExtract/recall 均保持，pico-harness 管理页已打开。
- CUA 验收了折叠任务摘要、审核状态分离、更正先停用、更正 v2 验证重置、第二客户端归档导致 CAS 冲突而草稿保留、本次排除、停止引用、重启持久化、实际管理跳转与已安装包。审核待审卡和诊断示例是隔离 UI 测试种子；实际来源纠正、30/18 结果和引用结算来自真实模型运行，未改造 canonical journal。
- 最终专项存储/迁移/协议 16 项、追加桌面回归 6 项、此前桌面/Runtime 15 项均通过；最终源与测试类型检查、桌面构建及打包通过。
- 本机数据、桌面 profile 与原源码快照备份在 `/Users/anxuan/.codex/visualizations/2026/10/13/pico-unified-experience-delivery/backups`，完整实拍和交付报告在同级目录。旧包仅为留档；不直接使用旧构建打开 v13，也不通过恢复旧 DB 撤回已删除内容。
