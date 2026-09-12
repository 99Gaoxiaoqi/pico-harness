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

- Renderer 不启用 Node.js，不读取文件、Runtime registration 或已有 Provider 密钥。用户新输入的密钥只在 write-only 提交流程中短暂经过 Renderer。
- Preload 不暴露通用 `send`、`invoke`、Shell 或任意 channel。
- Main 只负责窗口、系统集成、更新和本机 daemon 连接，不复制业务状态机。
- daemon 保持当前用户本机 IPC。POSIX endpoint 位于当前 UID 的 0700 私有目录且 socket 为
  0600；协议把连接主体限定为 `local_os_user`，业务操作还必须通过 typed root authority 与
  方法级校验。当前 runtime-host 握手不包含 bearer token。

## Renderer 代码组织

- `App.tsx` 装配路由、共享 RuntimeContext 与页面，`AppShell.tsx` 管理导航外壳。
- `pages/` 按路由收纳会话、设置、审核、自动化和扩展页面；`conversation/`、`usage/`、`workbar/` 收纳对应领域组件和投影。已有任务只使用 `/session/:sessionId`，不保留 Run 页面回退。
- `runtime.ts` 继续拥有唯一 `useRuntimeStore`，包括连接、订阅、会话切换、代次校验和异步操作生命周期。
- `runtime-projections/` 只转换协议数据与配置值；会话和用量投影放在各自领域目录。投影不创建订阅或另一份 Store。

页面拆分共用原 Runtime 数据，不改变会话身份和重连边界。

`workbar-panels/WorkbarPanelHost.tsx` 只负责面板选择及 workspace/session/instance 挂载
身份。Graph、Tasks、Files、Inspector、Review、Terminal 各自的 PanelController 持有
对应查询、投影和资源生命周期；共享 RPC 调用及资源帧订阅由窄模块复用。终端绑定表与
stop/list/attach 保持在同一个 Terminal 控制器模块，关闭标签仍先等待终端停止。
公开面板入口保留兼容导出，页面无需重建另一份资源状态。

Workbar 只持久化 v2 双 Dock 结构。Renderer State 只暴露 `docks`、`focusedDock`、
`rightWidth` 和 `bottomHeight`；v1 单 Dock payload 不再迁移，读取时按损坏状态回退到安全默认值。

## 数据所有权

- `$PICO_HOME`：RuntimeEvent Session 账本、信任、daemon 注册等跨 CLI/App 的统一状态根。
- 工作区 `.pico`：项目配置，受工作区信任边界约束。Runtime 数据不写入项目目录。
- Electron `userData`：当前只持久化窗口 bounds 与 maximized 状态；主题和更新通道不在该
  store 的已实现范围内。
- Provider 密钥：Runtime 只返回状态与 `credentialRef`；保存时原始值通过类型化 write-only 请求送到 daemon，不进入响应、事件、Renderer Store、持久配置或日志。发布构建默认禁用持久密钥；macOS `/usr/bin/security` 仅是显式开启的不安全本地开发兼容层，正式版本需由签名的 Pico Credential Broker/XPC 直接访问 Keychain。

## 平台边界

共享代码负责 React、协议、Agent Runtime 和数据格式。当前 `platform/darwin` 与
`platform/win32` 适配系统通知、目录打开和 login item；凭证 broker、PTY 与独立后台服务不是
这层现有接口。安装、签名和更新流水线按平台分开，Windows 安全能力未与 macOS 对齐前不公开发布。

## 兼容与失败语义

- Runtime frame 保持版本号和 1 MiB 上限；协议不兼容时阻止连接，不做猜测性降级。
- daemon 先建立 live subscribe，再按工作区回放通知账本；首个回放页固定 `highWatermarkEventId`，后续页用 exclusive `eventId` cursor 补齐，期间 live 事件在客户端缓冲。`resourceVersion` 是资源局部版本，不是全局回放序号。
- Approval 响应必须幂等；Pause 在当前不可中断工具结束后生效。
- Rewind 在文件指纹变化时 fail-closed，外部副作用不会伪装成可回滚。
- 子代理导航只接受显式 `childSessionId`；Usage 投影只暴露 canonical `cacheReadTokens`，不从
  `activityId` 推断会话，也不生成旧 `cachedTokens` 别名。
- 未实现或不可用能力在 UI 中显示真实原因，不返回伪造成功状态。

## daemon 配置所有权

`DesktopRuntimeService` 负责协议装配和跨领域宿主协作；`DesktopProviderConfigService`
统一拥有用户配置、有效配置解析、凭证 vault、operation journal、恢复和文件监视生命周期。
Provider 写入、Automation 与 Session/Run 准入委托给同一条 dependency lock 队列，
避免配置变化与依赖它的任务启动交叉。协议 handler 只映射请求，不持有另一份配置状态。
