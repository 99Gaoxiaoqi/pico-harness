# Pico 记忆改造实施记录

批准方案：[记忆与自主学习改造方案](./2026-10-16-memory-experience-redesign.md)。基线为 `cef587d11f2cdfb9240946e87d283f37a30c22d5`，最终产品代码为 `9dd898bc70a2941cea519fe5d78d82b1948bd977`；后续提交仅更新本记录。开始时本机与 origin/main 一致，主目录仅有上一轮生成的方案文档。

## 交付结论

已实现事实、案例、方法分层：低风险且范围明确的方法直接成为可用建议，案例不自动注入；证据影响排序和保留，不再按固定成功次数晋级。人工决定只介入高影响做法、范围扩大及明确长期规则冲突。无法核验的冻结范围保留为案例；纠正和可信反证立即阻止旧版本复用，普通恢复不能解除。

事实提取保持空闲 30 秒，经验反思保持无前台任务且空闲 10 秒；预算为每候选 2 次、每工作区滚动小时 4 次。召回保持最多 3 条、320 tokens、其中最多 1 条方法；整理保持 6 小时冷却、256 条和 30 天撤销。新增自动案例 30 天、方法 90 天期限，单纯投递不续期。v16 迁移、v3 协商与严格 v2 投影已完成。

**纯成功任务自动反思默认关闭。** 本次验证证明了功能与范围内效果，尚未证明自然成功学习带来因果复用收益；失败、纠正和明确具体做法有用的入口保留。实验成功场景显式开启该内部选项，不代表生产默认开启。

## 实施清单

- [x] 检查基线与远端，建立独立集成和三个开发 worktree。
- [x] 冻结公共契约，由单一所有者处理 Schema 与迁移。
- [x] 实现 v16 存储、案例和方法策略、反馈与失效保护。
- [x] 实现反思触发、召回条件、案例搜索与即时纠错。
- [x] 实现 v3 协商、严格 v2 投影和服务操作。
- [x] 实现桌面状态、决定卡、案例管理和使用反馈。
- [x] 第一轮：相关集成、类型检查和桌面构建。
- [x] 第二轮：六类真实模型场景，各两个变体；修复后定向复验及 Excel 闭环。
- [x] 第三轮：六组新任务、两个变体、三个条件，共 36 次；另有受影响的 12 次定向对照。
- [x] 最终桌面实际验收与永久应用副本校验。
- [x] 在独立集成分支完成验证、检查差异和远端状态。

## 所有权

- `codex/memory-redesign-storage`：core 经验契约、SQLite 经验存储与迁移、相应集成测试。
- `codex/memory-redesign-runtime`：Host 反思与召回链、Runtime 上下文、工具和运行集成测试。
- `codex/memory-redesign-ui`：renderer 与桌面浏览器集成测试。
- `codex/memory-redesign-integration`：协议、管理服务、能力声明、真实模型与对照验收、集成和交付。

公共接口和迁移单一所有者处理。各 worktree 的依赖和构建目录使用独立写时复制，`@pico` 链接指向自己的工作区。

## 验证记录

所有原始证据保存在 `/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/`，未写入仓库。各轮沿用用户默认模型 `codex-oauth/gpt-5.6-luna-fast`，未修改用户模型或权限设置。

### 第一轮：最终产品 `9dd898bc`

- 全部记忆集成及 11 个相关桌面集成文件：**338/338 通过**，失败、跳过、取消均为 0。
- 根源代码、测试代码及 desktop main/preload/renderer TypeScript 检查通过。
- `npm run desktop:package` 通过，生成并校验 macOS arm64 完整应用。
- `git diff --check` 通过。未运行全仓无关测试。
- 初轮 328 项中 7 项失败及后续诊断日志均保留，最终代码完整重跑通过。

记录：[本轮结果](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round1/final-result.json)、[集成日志](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round1/delivery-integration.log)、[桌面构建日志](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round1/delivery-desktop-build.log)。

### 第二轮：真实模型闭环

事实、无工具方法、成功案例、未知因果、纠错、权限隔离各两个变体，**12 个独立目标均有通过证据**。这些证据来自修复后的受影响场景复验，不是同一构建一次执行 12/12 的稳定性样本。

| 批次 | 产品代码 | 通过 / 执行 |
| --- | --- | ---: |
| 初批 | `1b7db143` | 5 / 12 |
| 夹具及产物前提修正 | `ca0ab378` | 3 / 7 |
| 来源别名、长问题及命令方法修正 | `8a37ae93` | 2 / 4 |
| 原生入口限定后的源任务检查 | `0be39720` | 0 / 2 |
| 补齐读取实际检查要求的工具 | `9dd898bc` | 2 / 2 |

共 27 条执行记录、53 次前台 Run、181 次 Provider 入口调用（134 前台、26 反思、21 提取）。按 canonical eventId 去重，133 次前台调用报告 995,961 输入 / 22,128 输出 token；另 1 次超时调用 usage 未知，后台 token 及金额未知，均不按零计算。旧摘要按 Run 累计 usage 的求和已由该去重汇总替代。

最后两个纠错变体均走完真实失败、读取检查文件、修复、复测、有用做法反馈、冻结范围变化、实际投递、useId 精确纠正、拒绝恢复、下一次排除旧版和新版本证据归零。初始缺失配置和受支持的原生命令入口为明确标记的测试前提，模型自行读取实际要求，未把期望字段或随机答案写进提示。

记录：[完整报告](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round2/summary/final-report.md)、[逐目标及全部失败矩阵](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round2/summary/final-matrix.json)。合法空提案、因果不足保留案例及源任务未完成均如实记录，未通过重试挑选最好结果。

#### Excel 兼容闭环

最终 `9dd898bc` 单次通过，真实模型 7 次物理请求，78,459 输入 / 1,575 输出 token，进程 47.8 秒。初始错误工具调用及隔离会话 full-access 为受控前提；权限通过实际 RPC 设置并读回，没有修改生产默认权限或用户配置。

新附件不同于源附件，实际 Provider 携带方法，工具以 `header:false` 获得 18，账本记录范围内采用与验证。4 条实际投递中，3 条效果关联同一个工具结果，**只算 1 个独立验证结果**；工具结果之后的新投递保持未知。方法仍是 suggestion / trial，positiveReuseCount=0。

此前三次失败完整保留，分别暴露观察摘要截断、测试会话等待审批、自然检索词不命中。Host 仅从已核验且已引用的成功工具参数补工作表与范围锚点，不依赖未来查询或答案。确定性回归证明 Host 补锚点；本真实用例未保存反思原始 JSON，不能仅凭最终字段判定模型是否也生成了相同锚点。

记录：[Excel 报告](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round2/excel-compat/anchored/summary.md)、[投递与结果审计](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round2/excel-compat/anchored/evidence-audit.json)。

### 第三轮：冻结记忆对照

- 固定完整矩阵 **36/36 通过**，0 失败、跳过和脚本重试；新版起点 `0beca6bb`，v15 基线 `cef587d1`。
- 方法及过期条件的受影响定向矩阵 **12/12 通过**，起点 `8a37ae93`；原 36 次未覆盖。
- 两批都关闭自动学习，三臂使用独立数据库、相同来源摘要与任务输入。随后反思、表格锚点与未决原生范围的修复由第一轮和相应真实闭环覆盖，未重复不受影响的冻结任务。
- 完整批次与 v15 的 10 个可同比配对持平，另 2 个案例配对是表示差异。定向批次的 1 胜、3 平只反映预设标签输出，不能解释为自然学习或因果收益。
- 共 83 条物理请求，均有 reported usage、retryAttempt=0；金额未定价。每场景仅两个变体，不作泛化或统计显著性声明。

记录：[完整 36 次报告](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round3/round3-summary.md)、[定向 12 次报告](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/round3/rerun-method-conditions/summary.md)。纯成功自动反思因此保持默认关闭。

### 桌面实际验收

完整生产 main/preload/daemon/renderer 在隔离 PICO_HOME 与 userData 中运行，使用真实 IPC、SQLite 和动作回执。先完成 14 项完整操作，包括案例、决定、暂缓、明确批准、普通修订、反馈纠正、归档恢复、CAS 草稿保留和 A→B→A 迟到响应隔离；随后按修复范围复验。

最终 `9dd898bc` 的 4 个实际检查点全部通过，4 条成功动作有持久回执：普通命令方法可保存；6 条中英越权表达被拒绝且无写入；事实 create/update 保持严格；无可核验原生范围的“冻结范围”修订保存为未启用案例、无 item。截图与 IPC/数据库回执一一对应。

验收通过隔离观察 wrapper 加载完整生产应用，**没有直接启动打包 App**。运行 bundle、打包 App 和永久副本的 984 个文件逐 SHA256 一致，运行前后未变。最终 4 项没有模型请求；UI 种子不算自然学习证据。自有进程已退出。

记录：[最终桌面报告](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/desktop/run-command-context-2026-10-16T03-55-12.699Z/AFFECTED-ACCEPTANCE.md)、[应用来源与哈希](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/provenance.json)、[永久 App 副本](/Users/anxuan/.codex/artifacts/pico-memory-2026-10-16/Pico-9dd898bc.app)。此前包和失败记录均保留。

## 修复与回退边界

验证过程中修复了失效事实的 Provider 边界过滤、Responses 事实提取、会话保存回执身份、来源 UUID 误写后的空提交、长中文查询、表格结果摘要、普通命令与越权指令区分、未核验冻结范围以及表格检索锚点。每项均有相应回归；测试的环境、产物、读取工具和会话权限前提单独修正，没有改变生产权限来通过验收。

源码基线 schema 为 v15，实际用户库仍是 v14：已在更新源代码前做只读一致性备份，权限为私有；全部测试使用隔离库，没有迁移实际用户库。新版本首次使用时按现有事务升级到 v16。运行回退使用现有记忆开关及支持 v16 的兼容构建；不能用旧二进制打开 v16，也不能回灌备份覆盖后来发生的用户删除。
