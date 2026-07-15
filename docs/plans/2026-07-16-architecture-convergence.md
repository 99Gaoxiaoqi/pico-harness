# Pico Harness 架构收敛计划

> 状态：实现与最终集成验收已完成，待合并与推送
> 建立日期：2026-07-16
> 基线：`main@260dbac`
> 实现快照：`codex/architecture-convergence@8d64385`
> 原则：先修确定性边界，再做局部拆分，最后清理；保持实现直接、可读，避免过度抽象。

## 目标

- 统一 Session、权限、凭证、`picoHome` 与 `env` 的宿主边界。
- 修复 Desktop 状态升级和 daemon client 竞态等确定性缺陷。
- 删除已经确认无引用的依赖、兼容别名和打包配置。
- 只按真实状态所有权拆分合并热点，不按文件行数机械重构。
- 保持 RuntimeEvent 为会话事实真源，不恢复长期 fallback 或双写路径。

## 范围

### 包含

- Session scope、Settings、Approval Grants 和 CredentialPool 隔离。
- Artifact、Slash Session 命令、WebSearch、Bash 的 `picoHome/env` 传播。
- Desktop session metadata v1 → v2 一次性迁移。
- daemon client request/close 竞态修复。
- Desktop 协议、CI、Release 和 updater 配置收敛。
- 无用依赖、production sourcemap、deprecated alias 和过期架构文档清理。
- `DesktopRuntimeService` 等合并热点的渐进拆分。

### 不包含

- 不删除、修改或接入 `src/storage/blob-garbage-collector.ts`。
- 不删除、修改或接入 `src/storage/retention-policy.ts`。
- 不恢复旧 fallback、旧事实源或双写兼容路径。
- 不恢复历史大型测试体系。
- 不一次性重写 AgentEngine、Session 或 RuntimeStore。
- 不引入 DI 容器、Service Locator、Repository 框架或全能型 Context 服务。

## 完成标记规则

- 未开始：`- [ ]`
- 完成：`- [x] ... ✔️`
- 每一部分只有在代码完成、相关验证通过并检查最终差异后才能标记完成。
- 完成时在该部分的“完成记录”中填写提交哈希、验证命令和必要说明。

## 第一部分：Runtime Context 边界

- [x] 统一 Session scope，将 `picoHome` 派生的 workspace identity 纳入 Session Settings、CLI semantics 和 Approval Grants 的键。✔️
- [x] 断开 `session-settings.ts` 与 `session-permissions.ts` 的运行时循环，把跨 store 操作移动到小型上层协调函数。✔️
- [x] 移除进程级 CredentialPool，由 AgentRuntime 根据显式 `runtimeEnv` 创建并持有凭证池。✔️
- [x] 补齐 Artifact、Slash Session 命令、WebSearch 和 Bash 的 `picoHome/env` 显式传播。✔️
- [x] 验证同一进程、相同 cwd/sessionId、不同 `PICO_HOME` 时状态、授权、凭证和路径完全隔离。✔️

### 实现约束

- 优先复用 SessionManager 已有 workspace identity 和 `resolvePicoPaths`。
- 能通过增加 `picoHome`、`env`、`artifactBaseDir` 等明确参数解决时，不新增通用框架。
- 删除 provider factory 的全局凭证池、reset 入口和隐式 `process.env` 初始化。

### 完成记录

- 提交：`c69275b refactor(runtime): 收敛会话与凭证宿主边界`；`adf447f refactor(runtime): 显式传播路径与工具环境`。
- 验证：`npm run lint`、`npm run typecheck`、`npm run build`；两轮临时 smoke 覆盖同 cwd/sessionId 跨 `PICO_HOME` 的 settings、CLI semantics、approval grants、凭证池、Artifact 读写、Session 列表/补全/存在性与 rewind fallback 隔离，并验证 Bash/WebSearch 不读取注入 env 之外的同名进程变量。
- 说明：主 Agent 与子代理共用显式 Artifact 根，主 Bash 及主/子代理 WebSearch 均服从 Runtime env，未引入通用 Context 容器。

## 第二部分：Desktop 确定性缺陷

- [x] 实现 Desktop session metadata v1 → v2 一次性、幂等迁移。✔️
- [x] 将旧 title 迁移为 RuntimeEvent，并保留 archive metadata。✔️
- [x] 保证迁移成功后正常路径只读写 v2，不保留长期 v1 fallback。✔️
- [x] 修复 daemon client 中 `request()` 与 `close()` 同 tick 竞争导致 Promise 永久 pending 的问题。✔️
- [x] 验证迁移失败不会删除旧数据，client 关闭竞争只会成功或明确 reject。✔️

### 实现约束

- 迁移必须先完成 RuntimeEvent 写入，再原子发布 v2 文件。
- client 使用最小 closed/generation fence，不重写 transport 层。

### 完成记录

- 提交：`4fc56c0 fix(desktop): 修复状态迁移与连接关闭竞态`；`d3ebab5 fix(desktop): 加固会话状态迁移`；`bac0176 fix(daemon): 阻止关闭后创建事件订阅`。
- 验证：`npm run lint`、`npm run typecheck`、`npm run build`、`npm run desktop:typecheck`、`npm run desktop:package`；临时 smoke 覆盖真实 title RuntimeEvent 迁移、archive 保留、失败时保留 v1、并发 migration/update、title 后续 mode 快照、hydration 竞态、跨 workspace orphan、quarantine 写失败、重跑幂等及 request/close 同 tick 明确 reject。
- 说明：title 新旧只按 RuntimeEvent 顺序中的真实 title 变化判定；orphan title 先写一次性 quarantine 再发布 active v2，正常路径不读取 quarantine，其他迁移错误 fail-closed 并保留 v1。

## 第三部分：协议、CI 与发布

- [x] 为 Desktop bootstrap 增加最小 daemon build/schema capability 校验。✔️
- [x] 为 Desktop 主路径关键 result 增加必要的运行时结构校验，不建设全协议代码生成系统。✔️
- [x] 让 Desktop CI 在 `main` 上运行，并覆盖实际打包依赖的 `src/**`、Desktop 与 protocol 变更。✔️
- [x] 将 package/tag 设为应用版本单一来源，workflow version 输入只负责校验。✔️
- [x] 将 updater feed 作为经过 HTTPS 校验的构建期配置写入安装包，缺失时发布流程 fail-closed。✔️

### 完成记录

- 提交：`66315cd fix(desktop): 增加运行时协议兼容校验`；`2947c23 ci(desktop): 扩展拉取请求检查路径`；`f034f64 build(desktop): 收敛发布配置与未使用依赖`；`8d64385 fix(desktop): 收紧订阅校验与发布说明`。
- 验证：`npm run lint`、`npm run typecheck`、`npm run build`、`npm run desktop:typecheck`、`npm run desktop:package`、`npm audit --omit=dev --audit-level=high`；临时 smoke 覆盖真实 daemon ping、旧 schema 拒绝、畸形 Session/Transcript/Event result 拒绝和 Desktop allowlist 未扩大，并验证 HTTP 更新地址会使打包失败、HTTPS feed 已写入打包产物。
- 说明：Desktop `package.json` 是应用版本真源，tag 与手工 version 输入仅做一致性校验；协议校验在 IPC 边界 fail-closed。

## 第四部分：低风险清理

- [x] 删除未使用的 `node-pty` 依赖及 Vite external、Forge copy/unpack/prune 配置。✔️
- [x] 删除 Desktop 未使用的 `@radix-ui/react-tabs` 和 `zustand`。✔️
- [x] 将实际使用的 `string-width` 声明为直接依赖。✔️
- [x] 关闭 production sourcemap，并确认其不进入安装包。✔️
- [x] 删除 deprecated `RuntimeEvent` lifecycle alias，并将协议通知命名收敛为 `RuntimeNotification`。✔️
- [x] 执行产品入口可达性分析，只删除证据明确、无动态入口的代码。✔️
- [x] 保留 `blob-garbage-collector.ts` 与 `retention-policy.ts`，并确认相对计划基线零差异。✔️

### 完成记录

- 提交：`f034f64 build(desktop): 收敛发布配置与未使用依赖`；`8963ffe refactor(runtime): 清理无引用兼容代码`；`2205d0c refactor(protocol): 收敛运行时通知命名`。
- 验证：`npm ls node-pty @radix-ui/react-tabs zustand string-width --all`；`npm run lint`、`npm run typecheck`、`npm run build`、`npm run desktop:typecheck`、`npm run desktop:package`；检查 `app.asar` 不含已删依赖和 `.map`；`rg` 确认协议旧通知名消失且 canonical `src/runtime/runtime-event.ts` 无差异。
- 说明：345 个 TS/TSX 源文件中 336 个 value 可达，9 个 value-unreachable 候选因存在类型入边而保留，最终只删除无任何仓内引用的运行时工厂与其专用输入类型。`git diff --exit-code 9856ef7..3924955 -- src/storage/blob-garbage-collector.ts src/storage/retention-policy.ts` 与对应 `git log` 检查均为空；两文件 blob 在基线/快照前后分别保持 `b8f68abf02acb2777a2b66f30e857b5fdc5d96de` 和 `00d3acfff90bfeb718fd03526e0ff80e3747f813`。

## 第五部分：局部拆分合并热点

- [x] 将 `DesktopRuntimeService` 的资源目录查询收敛到独立边界。✔️
- [x] 将 Automation 凭证、authority 和 trusted task 收敛到已有持久化 owner。✔️
- [x] 将 Changes/Rewind 审阅与回滚收敛到显式 `Session`/FileHistory 边界。✔️
- [x] 将 Transcript ingestion/persistence 收敛到显式 `Session + RuntimeNotification` 输入的独立 owner。✔️
- [x] 完成 Session 与 ProviderConfig 的证据审查，命中拆分停止条件并保留现有 owner。✔️
- [x] 将 AgentRuntime 收敛为 resolve context/config、acquire session、build capabilities、execute、finalize 五个可读阶段。✔️
- [x] 完成 AgentEngine 与 Session 的冲突审查；两者无可独立抽取的状态 owner，按停止条件不拆分。✔️
- [x] 将 RuntimeStore schema 版本、SQL 与迁移事务抽取到独立 migrator。✔️
- [x] 更新 `ARCHITECTURE.md`、`docs/architecture/00-overview.md` 和相关数据流文档，删除 Feishu、eval、`.claw` 等过期描述。✔️

### 拆分停止条件

- 新模块没有独立状态、生命周期或清晰输入输出时，不拆。
- 拆分只是在不同文件间转发同一批参数时，回退为原地整理。
- 单次提交只处理一个状态边界，不夹带功能扩展。

### 完成记录

- 提交：`fe34a51 refactor(desktop): 抽取资源目录查询边界`；`f3f195c refactor(desktop): 收敛自动化命令边界`；`91bad33 refactor(desktop): 收敛变更审阅边界`；`3924955 refactor(desktop): 收敛转录持久化边界`；`55d054a refactor(runtime): 显式划分运行阶段`；`b33fbae refactor(storage): 抽取运行时数据库迁移边界`；`e65b438 docs(architecture): 对齐当前 Runtime 与双壳架构`。
- 验证：各边界提交分别通过 `npm run lint`、`npm run typecheck`、`npm run build` 和适用的 `npm run desktop:typecheck`；临时 smoke 覆盖 Agent/Skill/MCP 查询、Automation 凭证与 trusted task、checkpoint 投影与 `Session.rewindBoth()`、Transcript RuntimeNotification append/重复事件幂等/tool start-completion 关联、RuntimeStore fresh→v6/幂等 reopen/preview v6 正规化/future version fail-closed；Node 22 storage capability 检查通过，架构文档通过 Prettier、11 份文档相对链接和过期描述 `rg` 检查。
- 说明：Transcript owner 不注入 callback，不复制 `transcriptPersistenceTail`；主服务继续持有 tail、Session 串行化、事件发布与 `run.finished` 队列衔接。Session 仍跨 metadata/settings/model/compaction/fork/send/事件协作，ProviderConfig 仍统一拥有 watcher/recovery queue/dependency lock/Vault/Journal 生命周期，继续拆分只会引入大型 Context、反向协作或状态复制。AgentEngine 的冲突属于执行控制流，Session 的冲突属于恢复、持久化和关闭生命周期，故均按停止条件保留；RuntimeStore 仅抽取具有独立输入输出的 schema migrator。

## 最终验证与交付

> 上述完成记录为各实现提交的局部验收证据；下列项必须在最终集成态重新执行，不因分支已验证而提前标记。

- [x] 在最终集成态运行 `npm run lint`。✔️
- [x] 在最终集成态运行 `npm run typecheck`。✔️
- [x] 在最终集成态运行 `npm run build`。✔️
- [x] 在最终集成态运行 `npm run desktop:typecheck` 和 `npm run desktop:package`。✔️
- [x] 使用不提交到仓库的临时 smoke 覆盖多 `PICO_HOME` 隔离、Artifact 回读、Desktop migration、daemon close race、双工作区订阅和打包启动/ping/退出。✔️
- [x] 检查最终 Git 差异，只提交本计划范围内的变更，并保护用户已有文件。✔️
- [ ] 将验收通过的集成分支合并到 `main`。
- [ ] 确认远程 `main` 未前移后推送，并确认无未提交或未推送内容。

### 最终验收记录

- 环境：Node `22.23.1`；系统 Node 26 不用于验收。
- 命令：`npm run lint`、`npm run typecheck`、`npm run build`、`npm run desktop:typecheck`、`npm run desktop:package`、`npm run format`、`npm run check:storage`、`npm pack --dry-run --json`、`npm audit --omit=dev --audit-level=high`、`git diff --check`，均通过；生产依赖审计为 0 漏洞。
- 产物：`app.asar` 中 `.map`、`node-pty`、`zustand` 与 `@radix-ui/react-tabs` 的匹配数均为 0。
- 临时 smoke：覆盖多 `PICO_HOME` 状态/凭证/endpoint 隔离、Artifact canonical root 与跨 Home 拒绝、v1→v2 migration 正常/orphan/失败保留、request/close 与 realpath/close 竞态、非法 subscription replay fail-closed、合法 replay/live 顺序、Renderer 销毁释放、双工作区订阅隔离，以及最新打包应用启动/schema ping/退出/socket 清理；临时文件与进程已清理。
- 最终只读复审：未发现可证实的 P0/P1/P2；`blob-garbage-collector.ts` 与 `retention-policy.ts` 相对计划基线保持零差异。

## 建议实施顺序

1. 第一部分：Runtime Context 边界。
2. 第二部分：Desktop 确定性缺陷。
3. 第三部分：协议、CI 与发布。
4. 第四部分：低风险清理。
5. 第五部分：局部拆分和文档更新。

每一部分独立提交。前一部分验证失败时，不进入下一部分，也不在同一提交中顺手扩大范围。
