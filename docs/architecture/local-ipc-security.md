# 本机 Runtime IPC 安全边界

## 平台边界

- macOS/Linux 使用 Unix domain socket。父目录固定为 `0700`，socket 与认证文件固定为
  `0600`，并在使用前验证不得有 group/world 权限。
- Windows 使用 Named Pipe。Pipe 名中的用户哈希只用于名称隔离，**不是身份认证**。
- Node.js `net.Server.listen()` 只提供 `readableAll` / `writableAll` 开关，默认均为
  `false`，但不提供 Win32 `SECURITY_DESCRIPTOR` 或 logon SID DACL 接口。Pico 显式保持这两个
  开关为 `false`，不能据此宣称 Pipe 已配置严格的每用户 ACL。
- Microsoft 说明，`CreateNamedPipe` 的默认安全描述符可能给予 Everyone 和 anonymous
  读取权限；若要隔离远程用户或不同登录会话，应在 DACL 中使用 logon SID。由于 Node API
  无法直接表达该 DACL，Pico 额外实施版本化应用层认证。

一手资料：

- [Node.js `server.listen(options)`](https://nodejs.org/docs/latest-v22.x/api/net.html#serverlistenoptions-callback)
- [Microsoft：Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

## 应用层认证

1. daemon 每次启动生成并轮换 256-bit 随机令牌。
2. 首个 IPC 帧必须是 `authVersion: 1` 的认证帧；认证前不能调用 `runtime.ping`、订阅事件或
   任何运行方法。
3. 服务端使用常量时间比较；失败只返回通用认证错误并立即关闭连接，令牌不会写入日志。
4. POSIX 令牌由文件权限保护。Windows 令牌存放于用户 LocalAppData，启动和连接时通过
   `whoami.exe` 获取当前 SID，并用无 shell 的 `icacls.exe` 参数调用移除继承、仅授予该 SID
   完全控制。SID 获取或 ACL 收紧失败时 fail-closed。
5. 认证令牌不取代 OS ACL：管理员权限、同一用户进程和已被攻陷的用户会话仍在信任边界内。
   如果未来引入能够传入 Win32 安全描述符的受审计原生传输，应继续保留握手作为纵深防御。
