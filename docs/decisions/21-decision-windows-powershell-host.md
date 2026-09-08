# 决策记录 21：Windows 宿主 shell 改用 PowerShell（2026-08-18）

> 提交：`ca7a3a64`（分支）/ `b940a51b`（合并 main）。本文记录决策动机与边界，
> 实现细节见 `src/os/shell.ts` 模块注释与 `tests/integration/windows/yolo-shell-hardline.test.ts`。

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
3. pico 在 Windows 本来就没有 OS 沙箱后端（`yolo-sandbox` 检测返回 unavailable）。
   换言之，pico 在 Windows 上的安全此前**完全押在静态分析上**，而静态分析的
   承诺在同行业中最激进的实现方都已放弃。

## 决策

1. **宿主链**：Windows 上 `pwsh.exe`（PATH → Program Files）优先，回退
   `powershell.exe`（PATH → System32），找不到 fail-closed。不再探测 Git Bash。
   Windows PowerShell 5.1 是系统必装组件（pwsh 7 需单独安装），宿主链不依赖
   第三方安装与安全软件脸色。
2. **安全语义按宿主方言分派**：bash 宿主（POSIX）沿用 bash-hardline 静态红线；
   PowerShell 宿主**无静态红线**（`classifyHardlineCommand` 返回 undefined），
   由审批层把关。哲学对齐"进程内文本分析不是安全边界，承重边界是 OS 沙箱"。
3. **审批体验兜底**：新增 `powershell-safety` 保守只读分类（小 cmdlet 白名单 +
   alias 归一 + git 子命令复用），保证普通模式只读命令免审批、explore 子代理
   只读校验在 Windows 仍可用。
4. **模型提示面按方言条件化**：bash 工具描述、env 块、核心纪律、错误恢复习语
   在 Windows 明确引导写 PowerShell 语法（`&&` 仅 PowerShell 7+ 可用）。

## 放弃的备选及理由

- **坚持 bash 硬红线（Claude Code / kimi-code 路线）**：本机实证不可用；且在无 OS 沙箱的
  Windows 上，红线只对"恰好写 bash 语法"的命令有效，换 shell 即绕过，纸面安全。
- **sh.exe 回退链（Git Bash 同二进制的另一入口）**：曾作为当日修复落地
  （bash.exe 被删但 sh.exe 幸存时可用），但保留了对 Git 安装完整性的依赖，
  且 bash 语法提示面在 Windows 生态里始终是二等公民。被本决策取代。
- **移植 2400 行 bash-hardline 为 PowerShell 版**：在"文本分析不是边界"的哲学
  下，投入产出不成立；且 PowerShell 对象管道/子表达式的静态可判定性更差。
- **cmd.exe 兜底**：模型被引导写 PowerShell 语法，cmd 执行不了，进候选链无意义。

## 已知接受的代价

1. **Windows 无静态拒绝地板**：`Remove-Item -Recurse` 指向受保护目标等不再被
   无条件硬拒。分层看：普通模式下 pico 仍有人工审批门（maka 已删除逐命令
   审批，此档 pico 更保守）；**YOLO 模式下两者等价，均为裸跑**——不要误读为
   pico 在 YOLO 下还有任何进程内防线。
2. **写路径启发式退化**：`extractBashWritePaths` 系消费方（敏感路径检测、
   workspace 访问声明）对 PowerShell 文本返回空结果——与"启发式只是 UX"立场一致。
3. **bash 语义测试覆盖移位**：hardline 断言类测试 skip win32，由 POSIX 侧覆盖；
   Windows 行为由 `windows/yolo-shell-hardline.test.ts` 契约测试锁定。

## 复评条件

- OS 沙箱在 Windows 落地（可行路线已验证：AppContainer broker + 一次性
  manifest/digest + 原子 Job + esbuild 打包的 Node filesystem worker，先沙箱化
  文件操作）后，复评两件事：PowerShell 静态红线是否值得补、bash-hardline 在
  POSIX 侧的整体存废。
