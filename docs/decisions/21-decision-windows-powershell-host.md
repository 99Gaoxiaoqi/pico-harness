# 决策记录 21：Windows 宿主 shell 改用 PowerShell（2026-08-18）

> 提交：`ca7a3a64`（分支）/ `b940a51b`（合并 main）。本文记录决策动机与边界，
> 实现细节见 `src/os/shell.ts` 模块注释与 `tests/integration/windows/full-access-shell-hardline.test.ts`。

> 2026-09-12 复评：“PowerShell 无静态红线”和“受限子进程无 OS 沙箱”已不是当前实现。现行 Runtime 使用一层小而高置信的 PowerShell hardline，并通过 Windows AppContainer Broker 执行 managed 子进程；下文已按当前边界更新，历史调研动机仍保留。

## 背景与实证

**直接诱因：bash.exe 在企业环境不可依赖。** 2026-08-14 起，本机（华为 HDP 云桌面）
的 `D:\Git\usr\bin\bash.exe` 被安全软件删除——`usr\bin` 其余 375 个文件完好，单文件
消失是精准查杀的典型签名，而非安装损坏。`bin\bash.exe` 是 47KB 转发 stub，目标缺失
时以 msys 层 `not found` 拒绝执行，`existsSync` 探测不出这种半死态。重装 Git 后可能
再次被删，"修环境"不是可靠出路。

**行业调研：坚持 Git Bash 的产品在本机同样会坏。**

| 产品        | Windows 策略                       | bash.exe 被删时 |
| ----------- | ---------------------------------- | --------------- |
| maka        | pwsh > powershell > cmd，不用 bash | 免疫            |
| Claude Code | 强制 Git Bash，找不到直接退出进程  | 完全不可用      |
| kimi-code   | 强制 Git Bash，找不到抛错          | 完全不可用      |
| pico（旧）  | 强制 Git Bash，fail-closed         | 完全不可用      |

**安全层调研：Windows 上的 bash 静态红线是纸面承诺。** pico 旧模型依赖
bash-hardline 静态分类器作为不可绕过的拒绝地板。但调研确认：

1. maka 曾实现过更强的危险命令分类器，后在其 SECURITY.md 中明确降级立场——
   "agent 进程内对命令文本的任何分析，都是对攻击者可控字符串的启发式，不作为
   安全保证"，把强制性下沉到 OS 沙箱。
2. Windows 的 OS 沙箱现实：AppContainer 零能力下 `cmd.exe`/`pwsh.exe` 死于 DLL
   初始化失败（`0xC0000142`），**任意 shell 无法被沙箱化**。maka 只沙箱化
   专用 filesystem worker，shell 沙箱化（其 W2 里程碑）至今未交付。
3. 本决策落地时，pico 在 Windows 还没有可用的 OS 沙箱后端。
   换言之，pico 在 Windows 上的安全当时**完全押在静态分析上**，而静态分析的
   承诺在同行业中最激进的实现方都已放弃。

## 决策

1. **宿主链**：Windows 上 `pwsh.exe`（PATH → Program Files）优先，回退
   `powershell.exe`（PATH → System32），找不到 fail-closed。不再探测 Git Bash。
   Windows PowerShell 5.1 是系统必装组件（pwsh 7 需单独安装），宿主链不依赖
   第三方安装与安全软件脸色。
2. **安全语义按宿主方言分派**：bash 宿主（POSIX）沿用 bash-hardline 静态红线；
   PowerShell 宿主使用独立的高置信拒绝地板，目前覆盖强推、磁盘/系统破坏、
   受保护根目录删除与不透明执行入口。命中 hardline 在任何权限模式下都直接拒绝，
   不能审批绕过；未命中只表示“这层没有证明高危”，不表示命令已被证明安全。
3. **审批与只读分类分层**：`powershell-safety` 保留小 cmdlet 白名单、alias 归一与
   git 子命令复用，供受限委派和诊断路径判定只读能力。前台 `ask` / `auto` 对所有
   Shell 仍请求审批；字符串分类只改善原因与限权组装，不作为静默放行依据。
4. **模型提示面按方言条件化**：bash 工具描述、env 块、核心纪律、错误恢复习语
   在 Windows 明确引导写 PowerShell 语法（`&&` 仅 PowerShell 7+ 可用）。

## 放弃的备选及理由

- **坚持 bash 硬红线（Claude Code / kimi-code 路线）**：本机实证不可用；且在无 OS 沙箱的
  Windows 上，红线只对"恰好写 bash 语法"的命令有效，换 shell 即绕过，纸面安全。
- **sh.exe 回退链（Git Bash 同二进制的另一入口）**：曾作为当日修复落地
  （bash.exe 被删但 sh.exe 幸存时可用），但保留了对 Git 安装完整性的依赖，
  且 bash 语法提示面在 Windows 生态里始终是二等公民。被本决策取代。
- **移植 2400 行 bash-hardline 为 PowerShell 完整版**：PowerShell 对象管道/子表达式的静态
  可判定性更差，全量模仿会制造错误的安全承诺。后续只补了小而确定的 hardline 地板，
  并没有改变这个取舍。
- **cmd.exe 兜底**：模型被引导写 PowerShell 语法，cmd 执行不了，进候选链无意义。

## 已知接受的代价

1. **Windows hardline 只是有界拒绝地板**：它拦截已建模的高置信系统破坏，
   但不企图证明任意 PowerShell 安全。`ask` / `auto` 中 Shell 始终需审批；
   `full-access` 不需人工审批，但命中 PowerShell hardline 或显式 deny 仍会直接拒绝。
2. **写路径启发式退化**：`extractBashWritePaths` 系消费方（敏感路径检测、
   workspace 访问声明）对 PowerShell 文本返回空结果——与"启发式只是 UX"立场一致。
3. **bash 语义测试覆盖移位**：hardline 断言类测试 skip win32，由 POSIX 侧覆盖；
   Windows 行为由 `windows/full-access-shell-hardline.test.ts` 契约测试锁定。

## 复评条件

- 上述条件已部分满足：Windows managed 子进程现由一次性 AppContainer Broker、
  进程专属 capability SID、Job Object 和可恢复 ACL journal 承重；后端或校验资源不可用时
  fail closed，不回退到裸进程。`full-access` 依设计绕过 OS 沙箱，但仍经过 PowerShell hardline。
- 后续只在出现新的高置信、跨方言破坏语义，或 OS 沙箱无法表达的必要权限时扩展
  PowerShell hardline；不把它演变成静默放行的命令证明器。
