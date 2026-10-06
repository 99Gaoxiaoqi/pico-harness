# Desktop 手机连接

Desktop 的「设置 → 手机连接」通过本机管理通道控制独立的 RemoteGateway。电脑与手机连接同一 HTTPS Relay，授权和任务执行继续由电脑负责。

## 使用与生命周期

1. 在本机注册并信任项目。
2. 部署时完成这台电脑与 Relay 的服务绑定。在桌面填写 Relay HTTPS origin，选择允许手机访问的项目并保存。
3. 开启手机连接，等待 Relay 在线，生成配对二维码。
4. 手机扫描后，在电脑核对设备、项目和权限，再批准配对。默认不授予终端或电脑管理权限。
5. 在设备列表撤销授权会关闭该设备连接；停止手机连接仅停止网关，不停止 Runtime 或取消电脑任务。

修改 Relay 地址或项目范围前先停止手机连接。已有直连配置不会自动转换；用户保存 Relay 设置时界面会明确确认切换。现有设备授权记录保留，实际访问仍受当前项目配置和设备授权双重约束。

日常连接只需开启连接、生成二维码、手机扫码、电脑批准。保存设置会创建或保留本机私有凭据，但不代表服务绑定已经完成；只有 Relay 在线时才能生成二维码。若显示「电脑尚未完成服务绑定或已解除」，需完成部署初始化后重新连接。普通设置不需要账号或一次性邀请。

关闭窗口及退出 Desktop 都不会停止已启动的网关。启用偏好保存在 Electron userData 下的 `mobile-connection.json`；下次 Desktop 启动时恢复连接。它不是独立的系统开机服务，仍依赖用户登录后启动 Pico。电脑休眠、关机、断网时手机不可用。Runtime 可达不等于 Desktop 的所有能力可用：Computer Use 要求桌面窗口可见，退出桌面后相应 capability 会被撤销。

## 进程与凭据边界

- Forge 同时打包 `main.cjs`、`preload.cjs`、`daemon.cjs` 和 `gateway.cjs`。Main 使用 Electron 的 Node 模式 detached 启动 gateway；网关自己的目录锁防止重复实例。
- 网关条目显式向 LocalRuntimeClient 提供旁边的 `daemon.cjs`，并沿用 `remote:<deviceId>` 的终端归属身份。
- Renderer 仅能调用白名单管理方法；Main 同时核对受信任主窗口与主 frame，验证严格参数后访问私有 socket/pipe。普通配置只接受 Relay 地址和项目范围，旧邀请字段会被 IPC 拒绝。
- 默认网关目录为 `~/.pico-remote`。Relay 主机身份和每个 Relay origin 的注册 token 只在该目录的私有 `relay-identity.json` 中保存。公开配置、状态、IPC 错误不返回长期秘密。
- 部署初始化将电脑身份与凭据哈希绑定到 Relay。私有凭据不会传给 Renderer；二维码只包含协议要求的短期配对信息，扫码后仍需在电脑审批项目与权限。
- 网关保留旧一次性邀请注册入口，兼容既有部署；普通 Desktop 设置不调用该入口。旧注册流程保持 TLS 校验、禁止重定向和 15 秒超时，并使用同一 token 重试响应丢失的请求。

## 统一 Runtime 接入边界

手机的 HTTPS/WSS 和加密 Relay 共用 `RuntimeAccessSession`。该服务在
`packages/remote-gateway` 中承载请求授权、工作区及资源归属检查、能力检查、结果脱敏、
会话订阅和事件生命周期；不依赖 HTTP、WebSocket、Electron 或第三方平台 SDK。
Gateway 继续负责设备配对、令牌验证、网络编码、IP 限流及本机管理。

后续微信、企微等适配器应先验证平台账号、租户及发送者身份，解析由电脑批准的授权，
再提供 `RuntimeAccessPrincipal` 与相应的 Runtime client。主体只含内部身份、权限、
工作区及终端 owner，不携带平台凭据；聊天 ID 只用于会话绑定，不能替代用户授权。
手机沿用 `remote:<deviceId>` 的终端 owner；其他接入方需使用独立、稳定的 owner。
`isCurrent` 必须核验授权仍有效；授权更新或撤销时调用 `close()` 清理所有订阅与资源。

适配器通过 `dispatch(request, publishResult)` 发起已审核的远程协议请求，通过
`attachEvents(sink)` 消费结构化事件，再按渠道能力生成回复。订阅答复须先发布，随后
才交付建链期间的帧。断开事件连接只清理订阅，不取消任务；执行结果未知时不得自动
重发命令。平台配对、聊天与 Pico 会话的持久绑定、平台消息去重及回复格式仍由适配器
处理。本次没有新增微信或企微连接器，也没有迁移设备凭据、修改公开 RPC 或合并 daemon。

## 验证

针对性检查：`tests/integration/desktop/desktop-remote-management.test.ts` 覆盖无邀请配置、唯一后台启动、服务未绑定提示、二维码、审批、撤销、关闭偏好、旧邀请字段及未授权调用拒绝和异常脱敏；配合既有 preload 与冷构建依赖检查。实际公网可用性需以手机蜂窝网络、受信任 TLS 的 Relay、电脑休眠恢复、断网恢复和发行包冷启动验证。
