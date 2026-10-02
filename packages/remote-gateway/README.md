# Pico 公网直连网关

网关与 Pico daemon 运行在同一台电脑。手机经 HTTPS/WSS 直接连接，不提供中转、打洞或后台推送。

## 启动

电脑需要可达公网 IPv6，或公网 IPv4 与正确端口映射。准备域名匹配、系统信任链有效的 TLS 证书。

```sh
pico remote configure \
  --url https://pico.example.com:8443 \
  --cert /absolute/fullchain.pem \
  --key /absolute/privkey.pem \
  --workspace /absolute/registered-project
pico remote start
```

工作区必须已在本机 Pico 注册。默认监听 IPv4/IPv6 8443；可用 `--listen` 与 `--port` 修改。公网端口可与电脑监听端口不同。`--runtime-home` 指定已有 Pico 状态根，`--home` 指定网关私有状态根。证书更新后重启网关。

`configure` 不修改防火墙、路由器或 DNS。`doctor` 检查本机 DNS、TLS、监听与 Runtime，外网可达性仍需手机蜂窝网络验证。

## 配对与权限

另开电脑终端执行 `pico remote pair`，手机扫描二维码。二维码有效期为 5 分钟。电脑显示设备、配对编号和授权范围，输入 `yes` 后批准；手机保存设备凭据并 ACK 后授权才生效。批准后未 ACK 的授权在过期或重启时失效。

默认授予 `workspace.read,session.control`，授权范围限定为配置中的工作区。额外权限必须在本机明确授予：

```sh
pico remote devices list
pico remote devices grant DEVICE_ID \
  --permissions workspace.read,session.control,workspace.write,terminal.control \
  --workspaces WORKSPACE_ID
pico remote devices revoke DEVICE_ID
```

`terminal.control` 是电脑当前用户的 Shell 能力，工作区 ID 不构成 Shell 沙箱。`host.admin` 允许修改 Provider、MCP 等电脑配置。首版只允许手机控制自己创建的终端。旧 daemon 不支持终端 owner 隔离时，终端能力失败关闭，需要更新或重启 Pico。

撤销立即关闭该设备连接、下载和订阅。关闭网关不取消 Agent 任务、不停止 daemon、不结束终端进程。重新打开手机会补齐状态。

## 接口与验证

公网提供 `/v1/health`、配对与 ACK、`/v1/capabilities`、`/v1/workspaces`、`/v1/rpc`、授权产物下载、设备自撤销及 `/v1/events` WSS。业务令牌仅出现在认证头中。

本机管理走私有 socket/named pipe 与独立管理令牌。POSIX 状态目录/文件为 `0700`/`0600`；Windows 设置并核实当前用户的受保护 DACL。设备状态仅保存设备令牌哈希。禁止链接文件、目录与多硬链接状态文件；原子写入，并阻止重复实例。

执行包 typecheck/build 与 `tests/integration/remote/gateway.integration.test.ts`。测试创建本地 CA，仅测试客户端显式信任该 CA；生产客户端不提供关闭证书校验的开关。Windows DACL、三系统原生打包、公网与真机网络仍需在相应环境验收。
