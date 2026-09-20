# Windows Desktop 构建与验收

Windows 当前仍是未签名测试产物，不因打包成功而自动满足公开发布条件。
Windows 安装标识为 `pico_desktop`，默认安装到 `%LOCALAPPDATA%/pico_desktop`；
运行时宿主目录仍使用 `%LOCALAPPDATA%/Pico/runtime-hosts`，用户配置仍使用原有
`PICO_HOME` 或 `~/.pico`；不得将安装目录与数据目录合并。
旧测试安装标识 `pico` 不再作为更新目标；不要自动卸载该目录，因为其中可能存有数据。

## 本机确定性检查

使用 Node.js 22.15+、Git，以及 Rust 的 `x86_64-pc-windows-msvc` 工具链和 MSVC/Windows SDK：

```powershell
npm ci
npm run build:sandbox:windows
npm run verify:sandbox:resources -- --require-current
npm run build
npm run typecheck
npm run desktop:typecheck
npm run lint
node scripts/run-integration-tests.mjs desktop/ temporary-workspace workspace-runtime-registry-release workspace-runtime-consistency
npm run desktop:package
npm run desktop:make
```

桌面打包前检查当前目标的沙箱二进制及 SHA-256；打包后检查实际复制的资源。即使
使用 Forge `make --skip-package`，生成安装器前也会重新检查已有 Windows/Linux 包。
缺少组件或摘要不匹配必须停止，不能通过禁用沙箱继续验收。

测试里的 `DesktopRuntimeService` 不拥有进程级 SessionManager；独立构造服务的测试
必须像生产 daemon 一样在删除 fixture 之前排空全局会话。Windows 文件锁会暴露
遗漏的关闭步骤，不能用忽略 EBUSY 的方式绕过。

## 专用 Windows 环境

沙箱宿主预配置需要管理员权限，应在专用测试机或可还原虚拟机中按
`docs/guides/process-sandbox.md` 和 `.github/workflows/desktop.yml` 执行。
不要为通过测试而在日常电脑上关闭安全功能或随意修改系统设备 ACL。

1. 构建并校验沙箱组件；完成 null-device 宿主预配置及幂等验证。
2. 运行 `npm run test:integration:windows`。跨用户 ACL 测试仅在可销毁环境中设置
   `PICO_WINDOWS_LOW_PRIVILEGE_TEST=1`；它会创建本地测试用户。
   再运行 `node scripts/run-integration-tests.mjs process-sandbox-native.integration`；文件符号链接
   用例需要宿主允许创建符号链接，不能用跳过或只测目录 junction 代替。
3. 使用最终安装包测试全新安装、首次启动、退出与重启。
4. 验证沙箱内允许的工作区访问，以及外部文件、凭据目录、子进程和网络的限制。
5. 验证升级、卸载及数据保留策略。已有 Pico 数据的日常环境不用于破坏性安装测试。

安装器的 install、updated、uninstall、obsolete 回调必须在加载主程序及 Runtime
依赖前完成并退出；不得打开窗口或创建运行时数据目录。检查实际快捷方式和卸载项，
开始菜单厂商目录应为 Pico，而非 Electron 的默认厂商。升级后验证历史内容再执行卸载。

在已有数据的本机做补充测试时，不要直接运行默认安装路径的 Setup。可从最终安装器
提取 Squirrel 载荷，在独立临时目录核对 Update.exe 的实际安装根目录后执行安装、
本地测试版本升级和卸载，并使用仓库外的专用 PICO_HOME 和 Electron profile。
此检查不替代 Setup 引导程序默认路径、签名和管理员权限验收。

## 实际应用验收

- 正常数据目录，以及位于 Git 仓库内部的数据目录，都能新建独立无项目任务。
  外层仓库不能因此被自动信任；旧任务重启后仍可打开。
- Windows 新任务提示为 `Ctrl+N`，快捷键有效；健康页不出现 macOS 专属说明。
- 使用明确授权的真实 Provider 验证回复、流式显示、取消、恢复发送和历史保存。
  模拟服务通过不能替代真实 Provider 验收。
- API key 仅保存在测试用户的本机配置中，不进入源码、日志、安装包或验收报告。
- Windows 工具链 PATH 中的 nvm 符号链接或 junction 应解析为相同的物理运行目录，
  不应因此获得额外目录权限；覆盖裸命令调用、混合大小写 Path 键和进程树取消。
- 报告应区分通过、失败、环境阻塞、未执行，不能把跳过视为通过。
