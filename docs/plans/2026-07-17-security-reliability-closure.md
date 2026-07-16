# 安全与可靠性闭环计划

> 状态：执行中  
> 建立日期：2026-07-17  
> 基线：`origin/main@3d64139`  
> 集成分支：`codex/security-closure-integration`  
> 工作流：standard + high risk；授权终点为实现、验证和交付准备，不包含生产部署。

## 目标与边界

- 修复已复现的 YOLO hardline 绕过、工作区符号链接越界读取、Hook 间接脚本信任失效、同仓库 Runtime 身份分裂、Run 投影与终态事件非原子、OpenAI SSE CRLF/EOF 丢事件、关闭无界等待、Hook watcher 停止竞态、非原子文件写入和大文件编辑问题。
- 将确定性集成测试、格式检查和适用的依赖审计接入 CI；修正文档失效命令和 Node 22 类型边界。
- 调查 Electron Forge 开发依赖审计项；只采用兼容且验证通过的修复，不以强制升级或忽略审计伪造通过。
- 不做无关架构重写，不改变 Provider 公开协议，不部署生产，不触碰主工作区既有未跟踪文件。

## 高风险控制与验收

- 破坏性命令验证只调用判定/沙箱逻辑，绝不执行真实删除命令。
- 越界读取测试只使用临时目录和无敏感标记内容，完成后清理。
- 每个缺陷至少有一条失败前、成功后的集成回归；崩溃窗口使用临时 SQLite 或注入式故障验证。
- 安全边界默认 fail closed；兼容性变化必须有原行为回归。
- 最终状态由非作者子代理独立复审；发现问题后只复查受影响范围并重跑最终门禁。

## 并行任务与文件所有权

1. 第一批安全边界
   - YOLO：`src/approval/manager.ts`、前台安全装配及专属测试。
   - 路径：`src/input/context-attachments.ts`、`src/code-intelligence/repo-map.ts` 及专属测试。
   - Hook 信任：`src/hooks/trust/store.ts` 及专属测试。
2. 第二批 Runtime/Provider
   - Workspace 身份：registry/runtime/service 规范化及测试。
   - Run/Event 原子性：`RuntimeStore` 与 service 的单一事务接口及故障测试。
   - OpenAI SSE：Provider parser 与流边界测试。
3. 第三批可靠性与工程门禁
   - Runtime 关闭、Hook reloader 生命周期。
   - `write_file`/`edit_file` 原子提交与大小限制。
   - CI、文档、Node 类型和依赖审计处置；锁文件由单一所有者修改。

共享 Schema、锁文件、工作流和本计划只由集成所有者修改。子任务不得更新 `main`。

## 最终验证矩阵

- `npm run lint`
- `npm run format`
- `npm run typecheck`
- `npm run desktop:typecheck`
- `npm run test:integration`
- `npm run test:llm-e2e`
- `npm run check:storage`
- `npm run build`
- `npm pack --dry-run`
- `npm run desktop:package`
- `npm audit --omit=dev --audit-level=high`
- 完整 `npm audit --audit-level=high`，若上游仍无修复则保留准确风险记录与可复现依赖路径。
- 最终 `git diff --check`、工作区状态、与最新 `origin/main` 的关系检查。

## 回退

- 每个行为切片独立提交；集成分支按提交反向回退，不改写共享历史。
- 不执行持久化 Schema 迁移；Runtime 事务接口若回退，旧数据库仍保持可读。
- CI/依赖变更与运行时代码分离提交，便于单独撤回。

## 完成条件

- [ ] 所有已确认问题有实现引用和回归证据。
- [ ] 每批集成检查通过，最终验证矩阵无未说明失败。
- [ ] 独立复审无未解决的高/中风险问题。
- [ ] 最终差异仅包含本计划范围，主工作区用户内容未被纳入。
