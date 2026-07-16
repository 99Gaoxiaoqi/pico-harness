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

- Renderer 不启用 Node.js，不读取文件、daemon token 或已有 Provider 密钥。用户新输入的密钥只在 write-only 提交流程中短暂经过 Renderer。
- Preload 不暴露通用 `send`、`invoke`、Shell 或任意 channel。
- Main 只负责窗口、系统集成、更新和本机 daemon 连接，不复制业务状态机。
- daemon 保持当前用户本机 IPC；首次帧必须通过轮换 token 认证。

## 数据所有权

- `$PICO_HOME`：RuntimeEvent Session 账本、信任、daemon 注册等跨 CLI/App 的统一状态根。
- 工作区 `.pico`：项目配置，受工作区信任边界约束；`.claw` 仅是只读 legacy 来源。Runtime 数据不写入项目目录。
- Electron `userData`：窗口尺寸、主题、更新通道等纯界面状态。
- Provider 密钥：Runtime 只返回状态与 `credentialRef`；保存时原始值通过类型化 write-only 请求送到 daemon，不进入响应、事件、Renderer Store、持久配置或日志。发布构建默认禁用持久密钥；macOS `/usr/bin/security` 仅是显式开启的不安全本地开发兼容层，正式版本需由签名的 Pico Credential Broker/XPC 直接访问 Keychain。

## 平台边界

共享代码负责 React、协议、Agent Runtime 和数据格式。`platform/darwin` 与 `platform/win32` 分别实现系统通知、目录定位、自启动、凭证、PTY 与后台服务。安装、签名和更新流水线按平台分开，Windows 安全能力未与 macOS 对齐前不公开发布。

## 兼容与失败语义

- Runtime frame 保持版本号和 1 MiB 上限；协议不兼容时阻止连接，不做猜测性降级。
- daemon 先建立 live subscribe，再按工作区回放通知账本；首个回放页固定 `highWatermarkEventId`，后续页用 exclusive `eventId` cursor 补齐，期间 live 事件在客户端缓冲。`resourceVersion` 是资源局部版本，不是全局回放序号。
- Approval 响应必须幂等；Pause 在当前不可中断工具结束后生效。
- Rewind 在文件指纹变化时 fail-closed，外部副作用不会伪装成可回滚。
- 未实现或不可用能力在 UI 中显示真实原因，不返回伪造成功状态。
