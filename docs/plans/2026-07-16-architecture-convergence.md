# Pico Harness 架构收敛计划

> 状态：待实施  
> 建立日期：2026-07-16  
> 基线：`main@260dbac`  
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

- [ ] 统一 Session scope，将 `picoHome` 派生的 workspace identity 纳入 Session Settings、CLI semantics 和 Approval Grants 的键。
- [ ] 断开 `session-settings.ts` 与 `session-permissions.ts` 的运行时循环，把跨 store 操作移动到小型上层协调函数。
- [ ] 移除进程级 CredentialPool，由 AgentRuntime 根据显式 `runtimeEnv` 创建并持有凭证池。
- [ ] 补齐 Artifact、Slash Session 命令、WebSearch 和 Bash 的 `picoHome/env` 显式传播。
- [ ] 验证同一进程、相同 cwd/sessionId、不同 `PICO_HOME` 时状态、授权、凭证和路径完全隔离。

### 实现约束

- 优先复用 SessionManager 已有 workspace identity 和 `resolvePicoPaths`。
- 能通过增加 `picoHome`、`env`、`artifactBaseDir` 等明确参数解决时，不新增通用框架。
- 删除 provider factory 的全局凭证池、reset 入口和隐式 `process.env` 初始化。

### 完成记录

- 提交：待填写
- 验证：待填写
- 说明：待填写

## 第二部分：Desktop 确定性缺陷

- [ ] 实现 Desktop session metadata v1 → v2 一次性、幂等迁移。
- [ ] 将旧 title 迁移为 RuntimeEvent，并保留 archive metadata。
- [ ] 保证迁移成功后正常路径只读写 v2，不保留长期 v1 fallback。
- [ ] 修复 daemon client 中 `request()` 与 `close()` 同 tick 竞争导致 Promise 永久 pending 的问题。
- [ ] 验证迁移失败不会删除旧数据，client 关闭竞争只会成功或明确 reject。

### 实现约束

- 迁移必须先完成 RuntimeEvent 写入，再原子发布 v2 文件。
- client 使用最小 closed/generation fence，不重写 transport 层。

### 完成记录

- 提交：待填写
- 验证：待填写
- 说明：待填写

## 第三部分：协议、CI 与发布

- [ ] 为 Desktop bootstrap 增加最小 daemon build/schema capability 校验。
- [ ] 为 Desktop 主路径关键 result 增加必要的运行时结构校验，不建设全协议代码生成系统。
- [ ] 让 Desktop CI 在 `main` 上运行，并覆盖实际打包依赖的 `src/**`、Desktop 与 protocol 变更。
- [ ] 将 package/tag 设为应用版本单一来源，workflow version 输入只负责校验。
- [ ] 将 updater feed 作为经过 HTTPS 校验的构建期配置写入安装包，缺失时发布流程 fail-closed。

### 完成记录

- 提交：待填写
- 验证：待填写
- 说明：待填写

## 第四部分：低风险清理

- [ ] 删除未使用的 `node-pty` 依赖及 Vite external、Forge copy/unpack/prune 配置。
- [ ] 删除 Desktop 未使用的 `@radix-ui/react-tabs` 和 `zustand`。
- [ ] 将实际使用的 `string-width` 声明为直接依赖，或在确认可读性更好时删除该引用。
- [ ] 关闭 production sourcemap，或确保上传后不进入安装包。
- [ ] 删除 deprecated `RuntimeEvent` alias，并将协议通知命名收敛为 `RuntimeNotification` 或同等明确名称。
- [ ] 再次执行产品入口可达性分析，只删除证据明确、无动态入口的代码。

### 完成记录

- 提交：待填写
- 验证：待填写
- 说明：待填写

## 第五部分：局部拆分合并热点

- [ ] 先按 Session、ProviderConfig、Transcript、Changes/Rewind、Automation 所有权拆分 `DesktopRuntimeService`，原类只保留协议路由和生命周期协调。
- [ ] 将 AgentRuntime 收敛为 resolve context/config、acquire session、build capabilities、execute、finalize 五个可读阶段，优先抽纯函数。
- [ ] 复查 AgentEngine、Session、RuntimeStore 的实际合并冲突；只有存在独立状态 owner 时才继续拆分。
- [ ] 更新 `ARCHITECTURE.md`、`docs/architecture/00-overview.md` 和相关数据流文档，删除 Feishu、eval、`.claw` 等过期描述。

### 拆分停止条件

- 新模块没有独立状态、生命周期或清晰输入输出时，不拆。
- 拆分只是在不同文件间转发同一批参数时，回退为原地整理。
- 单次提交只处理一个状态边界，不夹带功能扩展。

### 完成记录

- 提交：待填写
- 验证：待填写
- 说明：待填写

## 验证与交付

- [ ] 每个行为改动完成后运行最小相关 smoke 验证。
- [ ] 每部分完成后运行 `npm run lint`。
- [ ] 每部分完成后运行 `npm run typecheck`。
- [ ] 每部分完成后运行 `npm run build`。
- [ ] 涉及 Desktop 时运行 `npm run desktop:typecheck` 和 `npm run desktop:package`。
- [ ] 使用不提交到仓库的临时 smoke 覆盖多 `PICO_HOME` 隔离、Artifact 回读、Desktop migration、daemon close race、双工作区订阅和打包启动/ping/退出。
- [ ] 检查最终 Git 差异，只提交本计划范围内的变更，并保护用户已有未跟踪文件。

## 建议实施顺序

1. 第一部分：Runtime Context 边界。
2. 第二部分：Desktop 确定性缺陷。
3. 第三部分：协议、CI 与发布。
4. 第四部分：低风险清理。
5. 第五部分：局部拆分和文档更新。

每一部分独立提交。前一部分验证失败时，不进入下一部分，也不在同一提交中顺手扩大范围。
