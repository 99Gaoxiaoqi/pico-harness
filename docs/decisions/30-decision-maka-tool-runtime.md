# 决策记录 30：对齐 Maka 工具运行时边界

## 范围

对齐 Maka `beyond-function-calling.zh-CN.md` 涉及的已落地工具语义，不复制产品 UI，不实现文章末尾的 S3 / Serverless 愿景。

本记录取代决策 23 的跨 Turn 持久激活与未披露工具软路由策略；保留现有工具实现、权限、中间件、SQLite 账本和安全恢复基础。

## 生命周期与发现

- 一次 `AgentEngine.run()` 是本功能的 Turn，内部模型循环是 Step。绑定目录在 run 入口冻结。
- 宿主显式要求的 baseline 与模型搜索激活分离。baseline 仍受绑定、角色、宿主 allowlist 限制。
- `search_tools`（避免 Provider 保留名称冲突）覆盖所有 Deferred Tools；`load_tools` 是兼容入口。返回名称，Schema 只进入下一 Step。
- Step 捕获工具绑定和参数 Schema，执行拒绝未披露、同 Step 新激活、已替换绑定和伪造快照。
- Turn 激活单调增加，重试不清空，结束后释放。旧 `tool.group.loaded` 只保留审计，不能为新 Turn 扩权。

## 派发、结果与恢复

模型/子代理/代码子调用共用 Registry 的参数验证、Hook、安全、权限及资源准入。最终参数在副作用前通过 `beforeDispatch` 提交 T1；结果提交 T2 后才能交给下一次推理。提交错误不能转换为普通工具错误或被编排层吞掉。

执行中间件不能改写已授权参数或重复调用执行函数。工具定义通过显式 `nesting` 声明是否允许代码调用，默认禁止；编排工具声明 `executionMode: orchestrator`，不持有覆盖子工具的全局资源锁。

旧 `tool.started` 不重新解释。旧、新未决副作用均阻止模型继续。可信宿主调用 `resolveToolRecovery`，引用原 indeterminate 事件、提供证据 URI、核查结论与明确 outcome，追加 `tool.recovery.resolved`；原事件不变。该接口不是模型工具，也不保证外部系统恰好执行一次。

## Code Mode

`exec` 使用 `@ai-sdk/code-mode` 的 QuickJS/WASM 沙箱，不直接暴露宿主 OS、网络或模块导入。受限工具桥只提供当前 Step 中明确 nestable 的绑定。

子调用有独立 ID、父调用与 Step 关联，逐项提交 T1/T2。内部明细持久化，但不作为顶层模型历史；宿主敏感值清理在子结果落账及返回沙箱之前生效。模型主要消费 exec 聚合结果。Cell 超时/取消后先等待已经发起的真实操作收口，不自动重跑 Cell。

初始 nestable 集合为文件读写、编辑、glob、grep、网页读取和搜索。Shell、交互、委派及控制协议工具默认 direct-only。Plan 不暴露 exec；命令、后台和子代理白名单不因新增 exec 自动扩大。

## 资源权威范围

共享资源权威独立于单次批调度，覆盖同一执行宿主进程的多个 Registry/Agent。文件依据真实路径及 inode（包括硬链接）仲裁；原子替换后重新获取当前 inode 的准入。尚无 inode 的创建请求使用额外保守的大小写别名键：可能在大小写敏感系统上多串行一次，但不会改写真实 I/O 路径或合并已有不同文件的身份。

浏览器以 Session 资源身份串行，容量限额与互斥概念分开。取消不能提前释放活跃操作持有的资源。此模块不是跨进程分布式锁，也不能约束外部编辑器；跨进程仍依赖既有 Session/Workspace 所有权及独立 worktree 隔离。

## 兼容与验收

保留旧账本，不删除历史加载/调用事件。新增事件要求新版读取器，不能假定旧二进制可以读取新账本后安全回退。缓存前缀可能因 Turn 工具释放而变化，不以保证缓存命中为验收目标。

验收覆盖：发现时序/生命周期、绑定身份、Schema 和权限、T1/T2 故障、未决恢复阻断与证据结案、隐藏子调用、沙箱能力与限额、资源别名/原子替换/取消、子代理父子锁及真实模型发现与聚合闭环。
