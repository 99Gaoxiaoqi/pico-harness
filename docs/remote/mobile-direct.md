# Pico 手机公网直连

手机 App 通过 HTTPS/WSS 直接连接运行在你的电脑上的网关，网关通过私有本机通道复用 Pico daemon。手机与电脑不需要同一个局域网，也不需要租用额外业务服务器。至少一端电脑入口必须可从手机网络访问；没有公网入口时此方案无法连通，不会引入隧道、TURN、DERP 或其它中转。

## 公网准备

1. 在电脑本机启动 Pico，确认项目已信任并注册。
2. 准备域名以及系统信任的有效 TLS 证书。证书须包含该域名，私钥匹配；使用完整证书链。
3. 选择公网 IPv4 或 IPv6：IPv4 需要可入站的公网地址和路由器端口映射；IPv6 需要电脑可达的全局地址、域名 AAAA 和允许入站的 IPv6 防火墙规则。手机所在网络也要支持对应地址族。
4. 将域名 A/AAAA 指向公网入口。开放指定 TCP 端口（默认 8443），外部端口与 URL 一致。如外部 443 转发至电脑 8443，URL 不包含 8443。
5. 证书签发、续期、DNS 和端口映射由用户自行配置。更新证书后重启网关。

公网 IPv4、IPv6 都不是必然可用：运营商 CGNAT、入站封锁、地址族不匹配或防火墙都可能阻断。不要把本机 socket/named pipe 或现有 IPC 端口暴露公网。

## 安装和启动

要求与项目一致的受支持 Node.js 版本。源码安装：

```sh
npm ci
npm run build
npm run mobile:typecheck
npm run mobile:export
```

源码构建后可用 `node dist/cli/main.js remote ...` 运行以下命令。已提供 macOS 构建的 `pico-harness-0.1.0.tgz`；用 `npm install -g /absolute/pico-harness-0.1.0.tgz` 安装后使用 `pico remote ...`。该包经隔离解压的 CLI 启动验证，不能代替 Windows/Linux 的原生依赖和系统安全验证；这两个系统应在对应机器从源码构建。

在电脑本机配置，`--workspace` 可重复：

```sh
pico remote configure --url https://pico.example.com:8443 --cert /absolute/fullchain.pem --key /absolute/privkey.pem --workspace /absolute/registered-project
pico remote start
```

Windows 在 PowerShell 使用 Windows 绝对路径；网关的状态目录使用当前用户 DACL，不能用 chmod 替代。macOS/Linux 使用目录 0700、状态文件 0600。默认状态目录为用户主目录下 `.pico-remote`，也可在每个命令传 `--home`。TLS 文件保持当前用户可读取；配置拒绝关键状态文件的符号链接。

`start` 是前台进程。保持电脑唤醒和进程运行；首版不安装系统服务。按 Ctrl-C 关闭只撤回公网入口并释放网关连接，不取消电脑任务，不停止 daemon。配置目录同一时间只能一个实例。这里没有自动改防火墙、路由器、DNS 或全局系统设置。

## 配对和授权

另开本机终端：

```sh
pico remote pair
```

手机扫码后，检查电脑显示的手机名称、请求编号和权限，输入 `yes` 批准。一次性配对码有效期五分钟；设备凭据在手机安全存储保存后确认领取。不要把配对码截图或发给他人。

默认授予 `workspace.read,session.control`。如需要终端、应用变更或管理配置，先在电脑查看工作区 ID 和设备 ID，再明确修改：

```sh
pico remote status
pico remote devices list
pico remote devices grant DEVICE_ID --permissions workspace.read,session.control,workspace.write,terminal.control --workspaces WORKSPACE_ID
pico remote devices revoke DEVICE_ID
```

`host.admin` 可修改电脑 Provider、MCP、自动化和敏感设置，须另外显式授予。终端具有电脑当前用户的 Shell 权限，工作区 ID 不是 Shell 沙箱。新授权关闭旧连接，手机重新读取权限。撤销立即阻断设备后续请求并断开连接，不回滚既有操作或默认终止任务/终端。

设备令牌不放入二维码或 URL；电脑只保存令牌摘要，手机使用 SecureStore。设备管理只走本机私有控制通道，不能从公网批准配对、管理其它设备或读取管理令牌。

## 手机使用与构建

移动工程见 `apps/mobile`，React Native / Expo Router。调试用 development build；内测使用 Release 包，确保内置 JS bundle，离开 Metro 后可启动。具体构建步骤见该应用 README。iOS 真机包需要 Apple 签名配置，不能用模拟器 `.app` 替代可安装 `.ipa`。

手机只展示电脑授权的工作区；正式会话、模型、工具和数据留在电脑。首版会话历史为可重建的内存投影，生成文件进入可清理缓存。退出或切到后台后电脑继续运行，手机回前台重建订阅、补齐历史再恢复写操作。没有后台推送或云同步。

图片输入最多四张、总量 256 KiB，超限压缩后仍不满足就报错。不支持 PDF、视频和任意文档作为模型输入。生成文件必须按 ID 下载，校验大小和 SHA-256 后才展示/分享；断线重新下载，不支持 Range。HTML 预览禁脚本、外部资源和原生桥。

终端仅前台串行轮询；手机控制自己创建的终端，其它客户端终端只读。离开页面只 detach，结束进程需明确点击。桌面退出仅清理桌面 owner，不结束手机终端。旧 daemon 不支持 owner 隔离时终端请求会被拒绝，应更新并在本机重启 daemon。

删除会话或关闭侧聊不会替手机隐式停止终端；目标会话及其隐藏子会话仍有终端时，先显式停止终端再清理。升级后须在电脑重启旧 daemon；网关逐次检查会话清理隔离能力，旧宿主缺少标志时，列表、删除及侧聊创建/关闭能力不可用，不会调用旧版有副作用的清理逻辑。

## 排障

```sh
pico remote status
pico remote doctor
```

`doctor` 检查本机配置、DNS、证书、监听和 Runtime，不等于已从外网连通。最终公网验收应关闭手机 Wi-Fi，使用蜂窝网络进行配对和核心操作。

| 表现                      | 检查                                                        |
| ------------------------- | ----------------------------------------------------------- |
| 地址解析失败              | 域名 A/AAAA、DNS 是否更新、URL 是否有误                     |
| 连接超时/公网不可达       | 公网入口、CGNAT、端口映射、电脑和路由器防火墙、电脑是否休眠 |
| 证书失败                  | 主机名、完整证书链、证书期限；不使用忽略证书错误选项        |
| 配对过期                  | 在电脑重新运行 pair，旧秘密不会复用                         |
| 设备撤销                  | 重新配对；离线解除时还需在电脑撤销                          |
| 权限不足                  | 在电脑检查 grant；手机不能自行扩大授权                      |
| 协议不兼容                | 更新手机与电脑；旧终端能力不可不安全降级                    |
| Runtime 不可用            | 在电脑查看本机 Runtime 诊断，避免公网显示敏感内部错误       |
| revision/fingerprint 冲突 | 刷新配置或重新预览，再确认操作                              |
| 结果未确认                | 先查询电脑状态；只有已有幂等保护的输入可用原键重试          |

终端输入永不自动重发；请求超时不意味着任务取消。切换电脑或工作区后旧响应会被丢弃。

## 支持与验收边界

源码协议和网关面向 macOS、Windows、Linux；移动工程面向 iOS、Android。类型检查和 Hermes bundle 不能替代各系统的安装、DACL、原生分享/软键盘和蜂窝/IPv4/IPv6 真机验收。实际完成记录在 `docs/plans/2026-10-02-mobile-direct-implementation.md`，未运行的矩阵不能标为通过。

当前可交付 Android Release APK 和 iOS Simulator Release ZIP；Android APK 使用 Expo 生成的内测证书，尚未在 Android 真机启动。iOS ZIP 仅模拟器使用，不能安装到 iPhone；真机 IPA 需要 Apple 签名。公网准备条件尚未在本任务环境具备，不能宣称蜂窝直连已验收。

回退时关闭网关即可保留原本机 Pico。回退前在电脑显式处理仍运行的手机终端；不自动删除设备状态、会话或已有数据。
