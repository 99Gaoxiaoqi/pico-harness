# Desktop 手机连接

Desktop 的「设置 → 手机连接」通过本机管理通道控制独立的 RemoteGateway。电脑与手机连接同一 HTTPS Relay，授权和任务执行继续由电脑负责。

## 使用与生命周期

1. 在本机注册并信任项目。
2. 填写 Relay HTTPS origin、首次注册所需的一次性内测邀请，选择允许手机访问的项目并保存。
3. 开启手机连接，等待 Relay 在线，生成配对二维码。
4. 手机扫描后，在电脑核对设备、项目和权限，再批准配对。默认不授予终端或电脑管理权限。
5. 在设备列表撤销授权会关闭该设备连接；停止手机连接仅停止网关，不停止 Runtime 或取消电脑任务。

修改 Relay 地址或项目范围前先停止手机连接。已有直连配置不会自动转换；用户保存 Relay 设置时界面会明确确认切换。现有设备授权记录保留，实际访问仍受当前项目配置和设备授权双重约束。

关闭窗口及退出 Desktop 都不会停止已启动的网关。启用偏好保存在 Electron userData 下的 `mobile-connection.json`；下次 Desktop 启动时恢复连接。它不是独立的系统开机服务，仍依赖用户登录后启动 Pico。电脑休眠、关机、断网时手机不可用。Runtime 可达不等于 Desktop 的所有能力可用：Computer Use 要求桌面窗口可见，退出桌面后相应 capability 会被撤销。

## 进程与凭据边界

- Forge 同时打包 `main.cjs`、`preload.cjs`、`daemon.cjs` 和 `gateway.cjs`。Main 使用 Electron 的 Node 模式 detached 启动 gateway；网关自己的目录锁防止重复实例。
- 网关条目显式向 LocalRuntimeClient 提供旁边的 `daemon.cjs`，并沿用 `remote:<deviceId>` 的终端归属身份。
- Renderer 仅能调用白名单管理方法；Main 同时核对受信任主窗口与主 frame，验证严格参数后访问私有 socket/pipe。
- 默认网关目录为 `~/.pico-remote`。Relay 主机身份和每个 Relay origin 的注册 token 只在该目录的私有 `relay-identity.json` 中保存。公开配置、状态、IPC 错误不返回长期秘密。
- 一次性邀请不持久化、不写日志，提交后清空；二维码只包含协议要求的短期配对信息。
- 注册先持久化待确认 token，再向 `/v1/enroll` 提交哈希；TLS 校验保持启用，禁止重定向，注册请求有 15 秒超时，仅接受 `{ "version": 1, "enrolled": true }` 确认。响应丢失时使用相同 token 重试。

## 验证

针对性检查：`tests/integration/desktop/desktop-remote-management.test.ts` 覆盖配置、唯一后台启动、二维码、审批、撤销、关闭偏好和未授权调用拒绝；配合既有 preload 与冷构建依赖检查。实际公网可用性需以手机蜂窝网络、受信任 TLS 的 Relay、电脑休眠恢复、断网恢复和发行包冷启动验证。
