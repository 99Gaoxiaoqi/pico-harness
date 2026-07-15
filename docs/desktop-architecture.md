# Pico Desktop 架构边界

Pico Desktop 是现有本地 Agent Runtime 的图形宿主，不是第二套 Agent 实现。CLI/TUI 与桌面端共享 `$PICO_HOME`（默认 `~/.pico`）数据、Runtime 协议和安全约束。

## 进程边界

```text
React Renderer
  │  window.pico（逐方法、可校验 API）
  ▼
Electron Preload（contextIsolation + sandbox）
  │  固定 IPC channel
  ▼
Electron Main
  │  认证后的本机 Runtime 协议
  ▼
Pico daemon ── Agent Runtime / Session / Rewind / Automations
```

- Renderer 不启用 Node.js，不读取文件、密钥或 daemon token。
- Preload 不暴露通用 `send`、`invoke`、Shell 或任意 channel。
- Main 只负责窗口、系统集成、更新和本机 daemon 连接，不复制业务状态机。
- daemon 保持当前用户本机 IPC；首次帧必须通过轮换 token 认证。

## 数据所有权

- `$PICO_HOME`：Session catalog、信任、daemon 注册等跨 CLI/App 的唯一真源。
- 工作区 `.pico` / `.claw`：项目配置和 Runtime 数据，仍受工作区信任边界约束。
- Electron `userData`：窗口尺寸、主题、更新通道等纯界面状态。
- Provider 密钥：协议和 Renderer 只接触状态与 `credentialRef`。发布构建默认禁用持久密钥；macOS `/usr/bin/security` 仅是显式开启的不安全本地开发兼容层，正式版本需由签名的 Pico Credential Broker/XPC 直接访问 Keychain。

## 平台边界

共享代码负责 React、协议、Agent Runtime 和数据格式。`platform/darwin` 与 `platform/win32` 分别实现系统通知、目录定位、自启动、凭证、PTY 与后台服务。安装、签名和更新流水线按平台分开，Windows 安全能力未与 macOS 对齐前不公开发布。

## 兼容与失败语义

- Runtime frame 保持版本号和 1 MiB 上限；协议不兼容时阻止连接，不做猜测性降级。
- 事件按工作区使用单调 `resourceVersion`；重连先 replay 再 subscribe。
- Approval 响应必须幂等；Pause 在当前不可中断工具结束后生效。
- Rewind 在文件指纹变化时 fail-closed，外部副作用不会伪装成可回滚。
- 未实现或不可用能力在 UI 中显示真实原因，不返回伪造成功状态。
