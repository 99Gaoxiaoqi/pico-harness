# 默认权限 Graph 与桌面状态同步修复

基线：`d5dd2792`。来源：新一轮 Computer Use 验收，详见本机 `pico-cu-final-20260917-9iWfrd` 验收记录。

## 范围与分工

- 后端独立任务：为已登记 Graph isolated-worktree 提供绑定当前运行的受控 Git 状态、差异和提交能力；不向普通 shell 开放父项目或共享 `.git` 写权限。保持根监督工具边界和现有 shared 整合流程。
- 前端独立任务：可靠 Run 终态收敛全局普通审批/提问，防止迟到事件复活；首次信任成功后重载当前工作区，处理切换项目的请求竞态。两项涉及同一 runtime 文件，由单一任务负责。
- 主代理：独立集成、真实模型 ask 验证、最终构建与 Computer Use 复测。公共 Git 工具契约归后端单一所有者。

## 风险与约束

受控 Git 属于 Host 权限边界：不接受任意命令/路径/分支，绑定 Host 已登记资源与 activation，校验归属与当前运行；防止仓库配置、hooks、filters 隐式执行和重复/过期提交。停止或无法确认身份时拒绝写入。旧方案通过 revert 回退，不更改用户配置、迁移数据库或改写 Git 历史。

前端不能全清审批，不能将列表缺失/请求失败视为 Run 终态；保留 Plan、其他活跃和未知运行的交互。信任后的刷新复用现有查询与请求代际保护，不通过隐藏错误伪造成功。

## 验收清单

- [x] 默认 managed/ask 两隔离任务各自写入并真实提交，最终整合至合成 main；根保持仅监督工具（真实 DeepSeek E2E）。
- [x] Git 路径/分支越权、失效 activation、停止后调用、过期 HEAD 拒绝；原始仓库权限不放宽（集成测试）。
- [x] Run 终态后清除对应待处理、迟到请求不复活，其他活跃/未知/Plan 交互保留；同 Run 新版本恢复后可再次交互（真实 React runtime 浏览器集成）。
- [ ] 两子任务待审批时通过新包界面停止，无刷新清除对应待处理（本轮 GUI 模型调用返回 HTTP 402，未派发子任务，不能计为通过）。
- [x] 首次信任后定时任务页无需刷新恢复（Computer Use）；切换项目不被旧请求覆盖（浏览器集成）。
- [x] 针对性集成、类型检查、构建以及新包 Computer Use 部分复测；限制见下。
- [x] 隔离凭证和测试进程清理；未修改用户原始配置。

只记录实际完成的验证；不将本机验收声明为全平台通过。

## 实施与验证结果（2026-09-17）

- 后端提交 `daab1bd5`，前端最终提交 `caee3345`，在独立集成分支合并。Host 绑定 `graph_git` 的资源、运行和分支，只提供 status/diff/commit；commit 校验 expected_head。临时元数据保存在宿主 Git 目录，普通 shell 权限不变。
- 前端按 Run 版本/时间收敛交互，失败或缺失快照不当作终态；信任成功后重载当前工作区，并检查请求代际。
- 最终针对性验证 36 项通过，另有审批预览/连续性竞态回归通过；根及桌面类型检查、lint/架构检查、packages 构建通过。
- `tests/e2e/agent-graph-integration.real-llm.test.ts` 的 ask 场景使用 `deepseek/deepseek-v4-flash` 通过，耗时约 181 秒。两隔离子任务真实提交，经 shared 整合后原始提交可从 main 到达，验证文件内容和根监督工具边界；审批仅 allow_once，shell 仅允许完整命令匹配。本轮未重复 full-access 场景。
- 新 macOS arm64 包通过 Computer Use 验证首次信任恢复、定时任务创建/立即运行/结果查看/暂停。定时任务使用本地匿名模型 fixture，输出 `AUTOMATION_FIXED_OK`，不是外部模型验证。
- 标准打包过程下载 GitHub 校验清单遇到 TLS ECONNRESET；使用已安装 Electron 43.1.0 自带 checksums.json 经 Forge 打包成功，未关闭校验、未修改仓库打包配置。
- GUI Graph 使用同一有效 DeepSeek 凭证，但首个模型请求返回 HTTP 402，无子任务/工作树资源。因此 GUI 的停止及完整交付场景未完成，未继续重试或充值。
- 新观察到的后续问题：上述模型失败时，界面没有明确展示错误，Graph 面板显示“已完成”。这是错误呈现问题，不属于本次三项修复，需独立定位和回归。

## 使用边界与本机证据

受控提交要求仓库本地设置 `user.name`/`user.email`；不继承全局/系统配置，不执行 hooks、filters 或签名；不支持子模块、嵌套仓库和空提交。它是隔离任务的最小提交能力，不是任意 Git CLI 替代。

本机产物根目录：`/Users/anxuan/.codex/artifacts/pico-ask-fixes-20260917-UD3htb`。新包为 `Pico.app`，隔离验收记录位于 `acceptance/evidence.md` 和 `acceptance/evidence.json`。测试应用、专用 daemon 和 fixture 已停止，定时任务已暂停；清理扫描 84 个文件无已知凭证残留，用户原配置在清理前后完全一致。
