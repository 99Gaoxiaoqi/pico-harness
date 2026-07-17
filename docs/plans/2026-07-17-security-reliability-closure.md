# 安全与可靠性闭环计划

> 状态：实现、全平台验证与独立复审均已闭环
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
- `npm run test:integration`（独占运行，避免与 build/storage 争用平台 watcher 启动窗口）
- `npm run test:llm-e2e`
- `npm run check:storage`
- `npm run build`
- `npm pack --dry-run`
- `npm run desktop:package`
- `npm audit --omit=dev --audit-level=low`
- 完整 `npm audit --audit-level=low`，若上游仍无修复则保留准确风险记录与可复现依赖路径。
- 最终 `git diff --check`、工作区状态、与最新 `origin/main` 的关系检查。

## 验证证据

- macOS 最终状态使用 Node `22.23.0`、npm `10.9.8`：lint、全量格式检查、根项目与 Desktop 类型检查、build 均通过；本地与 macOS CI 的确定性集成测试均为 169 tests / 161 pass / 0 fail / 8 平台限定 skip，Desktop unsigned package 通过。
- Linux 使用 `node:22-bookworm`（Node `22.23.1`，`linux/arm64`）的两个独立 clean copy。root 在 `npm ci` 后、protocol dist 初始不存在时直接运行测试，为 168 / 162 pass / 0 fail / 6 skip；非 root `node` 用户使用独立可写 HOME/cache，为 168 / 163 / 0 / 5。两者均证明 `pretest:integration` 可从干净安装自举协议产物。
- Linux root 文件发布测试分两阶段常驻 CI：明确确认 `getfattr` 不存在时，新文件 default ACL/watcher 与 missing-file 最终复核 2/2 通过；安装 `attr` 后，已有文件 ACL/xattr 保真与 ACL-denied reader 2/2 通过。同一矩阵在 `linux/arm64` 与 CI 对齐的 `linux/amd64` 上都为 0 fail/0 skip。Linux storage、typecheck、lint、build 和完整依赖审计均通过。
- Hook 间接入口整文件回归为 80/80；stdin 提前关闭修复在 macOS 与 Docker Linux 的目标测试均为 3/3。Windows 专属 Hook 集成测试为 6 条，覆盖直接 `.exe`、大小写混合 `Path`/`PathExt`、含 `RUNNER~1` 的绝对入口、stdin 提前关闭，以及 timeout/cancellation 后的整棵进程树终止。最终 PR CI job `87795932983` 与 Windows Desktop job `87795933024` 均通过全部 6 条 Hook 场景，不再有被 readiness 超时掩盖的 fail-open。
- 多轮复审继续收口了静态 `cd` 后 YOLO cwd 传播、Shell 组合选项与启动注入、旧 OpenAI 直连猜测互斥输出字段、目录附件验证后按路径重开、关闭超时后过早释放 daemon 单例、Cron 注销失败丢失所有权、活动 Cron tick 阻塞 host stop、TaskHost runner 超时后提前关闭 store、不完整 Cron fence 被当作已释放，以及 Task pending 同步订阅者重入 close 的准入窗口。最终全量差异复审又发现 Windows 非 Bash host 仍使用 Bash hardline 分类器的 P1；代码改为 resolver、hardline 安全门和 argv 三层拒绝非 Bash，删除 `cmd.exe` fallback，并把真实 `ComSpec` 回归接入两个 Windows job。修复后非作者聚焦复审未发现 P0-P2；Windows 文件发布状态机和真实低权限/PInvoke 两路专项复审也未发现其他 P0-P2。
- 真实模型 E2E 使用临时 OpenRouter/Qwen 路由在最终代码态验证 3/3 通过，覆盖 Prompt Hook、RuntimeRun、SQLite 上下文与 Usage 恢复。第一次临时配置请求 4096 输出 tokens，被 OpenRouter 在生成前以余额上限 402 拒绝；将测试专用上限降到 768 后完整通过，并在 hardline 最终修复后再次 3/3。测试后 `.pico/config.json` 恢复到原始 SHA-256 `efa56dac6289c7cdf1938bbef273d9382e63cab070a70e24492e6558d1fb493c`，未进入差异。
- Storage capability 在 macOS Desktop 打包前后均通过：Node ABI 127、SQLite 3.53.2、原生 transaction/WAL。Linux clean copy 得到相同 ABI、SQLite 和事务/WAL 结论。
- `npm pack --dry-run --json` 为 1248 files、解包 7,811,409 bytes；macOS arm64 Desktop unsigned package 在新增 `prepackage` 自举协议产物后通过。Linux Desktop 不属于实现声明的支持平台，未把 Electron/native addon 的 Linux 打包失败记为成功。
- 完整依赖与生产依赖的 `npm audit --audit-level=low` 均为 0 漏洞。Desktop 打包只有 Vite `inlineDynamicImports` 弃用提示，没有失败或审计漏洞。
- 无 `.env`、无 protocol dist 的 clean copy 可通过 `npm run dev -- --help` 自动构建协议并正常输出帮助；Windows 与真实模型测试入口也各自具有显式协议前置构建，不再依赖 CI 命令偶然排序。
- 闭环文档 head `f46dd07` 的原始 CI run `29552144193` 暴露出唯一一条 Linux 测试失败：Hook reloader 路径替换用例在 watcher 已启动后写配置，同时又手动 `reload()`，debounce 自动 reload 与手动 reload 会把预期的两次 swap 放大为三次，并存在配置事件提前满足等待条件的假绿窗口。修复 `c14dae7` 在 watcher 启动前建立 initial snapshot 与磁盘配置的分叉，再以一次手动 reload 替换 callback 闭包，随后只由 `changed.js` 事件证明第二次 swap；目标用例压力复测 50/50、macOS 全量集成 169 / 161 pass / 0 fail / 8 skip、typecheck、lint、全量格式和 `git diff --check` 均通过，非作者复审未发现 P0-P2。
- 最终行为代码 head `c14dae7` 的 GitHub Actions run `29552480527` / `29552480548` 四项门禁全部通过：Ubuntu 全量 `test` 为 169 / 164 pass / 0 fail / 5 skip，两个 root 文件发布阶段各为 2/2；macOS Desktop 为 169 / 161 / 0 / 8。Windows 安全套件为 13/13 / 0 fail / 0 skip，覆盖 6 条文件安全、6 条 Hook 和 1 条真实 `ComSpec` hardline 场景；低权限本地用户在空暂存和有内容暂存阶段均无法持有或读取文件，用户清理成功。Windows Desktop 另确认 Node `22.23.1` / `win32-x64`、ABI 127、SQLite 3.53.2、原生 transaction/WAL 与 unsigned package，并通过根项目/Desktop typecheck、lint、相同 13/13 安全套件和 unsigned package。

## 已知边界

- Hook 信任不是进程沙箱：运行时动态加载的传递依赖、固定配置、子命令、系统级启动配置和动态库不会递归指纹化；同一用户进程仍可能利用复核到 `spawn` 之间的 OS 级 TOCTOU，Windows DLL 搜索也属于进程加载边界。
- Node 未提供覆盖当前实现所需的 `openat/renameat/linkat` dirfd/匿名 inode 发布组合，Windows Node/PowerShell 也没有当前流程所需的 handle/file-ID 相对 Replace/Move/Unlink API。文件发布通过重复 realpath、目录 inode、文件身份和版本复核缩小，但不能从 OS 层消除同一用户或同目录恶意写者在最后复核后替换父目录、目标路径或临时路径的窗口；完全消除需引入原生平台 API。具名临时 inode 恢复最终权限后，最终被授权的目录扫描者还可能在极短的 rename 前窗口看到它。
- Windows 文件安全契约精确覆盖 Access DACL、owner 与 group；SACL/audit ACL 不在本轮既定契约内。低权限 watcher 的身份由 `CreateProcessWithLogonW` 凭据语义和成功执行受限脚本共同证明，未额外让子进程回传 SID；其正常绿路径通常自然退出，不强制命中仍存活进程的 Kill/PID-reuse 清理分支。
- Linux 已有文件覆盖仍需要 procfs 与 GNU attr 才能证明当前身份可观察的 ACL/xattr 被保真；新建文件不依赖 attr。非特权身份看不到的特权 xattr 不能由用户态证明不存在。Docker Desktop bind/virtiofs 的不稳定文件版本字段可能触发严格复核并 fail-closed，Docker 不在当前支持范围。
- Node 也未跨平台公开目录句柄枚举 API；目录附件只在带 procfs 的 Linux 展开，macOS、Windows 和无 procfs 环境会明确 fail-closed 为“未展开”，不把缺少安全能力伪装成空目录。
- macOS/Node `fs.watch` 在高并发启动瞬间可能漏首个事件。当前 reloader 生命周期与停止路径均已收口，验证矩阵以独占运行排除资源争用；若产品要求启动瞬间的外部改动也绝不遗漏，需要单独实现 read-watch-read 对账。
- YOLO hardline 是可见命令文本和已建模执行入口的保守拒绝器，不是任意 executable 的 OS 能力沙箱；少量无法证明安全的 Shell 启动配置会按设计产生 fail-closed 误拒绝。`PICO_SHELL_PATH` 属于可信启动配置，当前以 Bash 可执行文件名绑定语法模型；能控制父进程环境或替换已选 `bash`/`bash.exe` 本体的主体已处于 arbitrary-executable 信任域。Windows runner 直接验证了现存 `ComSpec` override；托管 runner 总是预装 Git Bash，因此“机器完全未安装 Git Bash”的分支未做环境级模拟，但 resolver 的明确抛错和 argv 二次拒绝共同覆盖该路径。
- 忽略 abort 的 executor 若永不 settle，或 daemon/Cron/service/fence 关闭失败，活进程会按设计持续保留相关资源和单例锁，拒绝同进程重启与第二个 daemon；只有执行排空或进程退出后的 PID stale recovery 才能交出所有权。
- 以上均为明确记录的平台或信任模型边界；本计划范围内没有未解释的失败，最终复审只接受无未解决 P1/P2 的状态。

## 回退

- 每个行为切片独立提交；集成分支按提交反向回退，不改写共享历史。
- 不执行持久化 Schema 迁移；Runtime 事务接口若回退，旧数据库仍保持可读。
- CI/依赖变更与运行时代码分离提交，便于单独撤回。

## 完成条件

- [x] 所有已确认问题有实现引用和回归证据。
- [x] 每批集成检查通过，最终验证矩阵无未说明失败。
- [x] 独立复审无未解决的高/中风险问题。
- [x] 最终差异仅包含本计划范围，主工作区用户内容未被纳入。
