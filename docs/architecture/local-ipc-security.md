# 本机 Runtime IPC 安全边界

> 文档类型：当前安全边界。这里描述 `packages/runtime-host` 承载的生产传输；
> `src/daemon/ipc-auth.ts`、旧 socket server 和 instance-lock token 只服务退役传输的升级守卫，
> 不是当前 TUI/Desktop 握手协议。

## 信任模型

Runtime Host 面向同一台机器、同一个 OS 用户下的 TUI 与 Desktop。它不是多租户服务，也不把
本机 IPC 暴露为网络 API。当前连接主体统一建模为 `local_os_user`；安全边界由以下机制共同组成：

1. 私有 endpoint 与当前用户的文件/进程权限；
2. 持久 registration 中的 `rootId`、`hostEpoch` 和协议兼容范围；
3. storage root capability、读写 lease 与物理目录身份绑定；
4. 类型化 operation registry、参数校验与 Desktop Preload allowlist；
5. workspace trust、Permission/Approval、Hardline 和 Hook 安全链。

这套边界不防御已经取得同一 OS 用户权限的恶意进程，也不等同于 OS sandbox。

## 平台 endpoint

### macOS / Linux

- 使用 Unix domain socket。
- endpoint 位于 `mkdtemp` 创建的当前 UID 私有目录；目录强制为 `0700`。
- listen 后 socket 强制为 `0600`，并复核它是 socket、owner UID 等于当前用户且没有
  group/world 权限。
- endpoint 名包含 storage root identity 和 owner pid；启动时只清理能够证明 owner 已死亡的
  同 root 遗留目录，不猜测删除未知目录。

### Windows

- 使用 Named Pipe，名称包含 `rootId` 前缀与 `hostEpoch`，用于实例隔离而不是密码认证。
- Node 的 `net` API 不能在这里表达完整的 logon-SID `SECURITY_DESCRIPTOR`；因此文档不能宣称
  pipe 已配置显式的每用户 DACL。
- 当前产品边界仍是同一 OS 用户的本机工作台。若未来需要抵抗其他登录会话或更强的本机对手，
  应引入可审计的 Win32 peer/DACL 能力，而不是把名称随机性当作认证。

## 握手与协议

当前第一帧是 `ClientHello`，包含：

- client instance ID 与 surface；
- client 支持的 protocol min/max；
- compatibility epoch。

Host 返回 accepted、incompatible 或 draining。握手用于版本协商与生命周期收敛，**不携带
bearer token**。后续帧使用 4 字节长度前缀 JSON，单帧上限 1 MiB；未知 operation、非法参数、
不兼容版本和越界帧都会被拒绝。

## Root authority

Runtime Host 启动时取得绑定到 canonical path、`rootId` 和物理 dev/ino 的 capability，并通过
OS handle/lease 维持读写所有权。业务 handler 只能拿到经过认证的 typed owner/reader，不能用
任意字符串路径伪造另一个 storage root。根目录被替换、复制或移动后必须 fail-closed；显式
adopt/repair 是独立流程。

## Renderer 边界

- Desktop Renderer 开启 context isolation、关闭 Node integration。
- Preload 只暴露逐方法、可校验 API，不暴露通用 `send`、`invoke`、Shell 或任意 channel。
- Renderer 不读取 host registration、Runtime 文件或已有 Provider secret。
- write-only secret 只在明确的配置请求中短暂经过 Renderer，不进入响应、事件或 UI store。

## 不承诺的能力

- 不防御管理员/root、同一用户下的恶意进程或已被攻陷的用户会话。
- 不把协议版本协商描述为身份认证。
- 不把 Windows Named Pipe 名称或默认 ACL 描述为严格的每用户隔离。
- 不用 IPC 边界替代 workspace trust、工具权限、Hardline、审批或 OS sandbox。
