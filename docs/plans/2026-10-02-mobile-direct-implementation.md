# Pico 移动端与公网直连实施记录

用户批准 React Native / Expo 移动端、用户电脑 HTTPS/WSS 网关和既有 daemon 的直连架构。不接中转；公网入口、可信证书及真机签名是验收前提。原工作区已有修改独立保留，开发在隔离 worktree 进行。

## 交付清单

- [x] 移动端安全协议入口、UTF-8 预算、显式远程方法与权限契约。
- [x] Node-free 远程客户端：配对、认证、RPC、订阅、前后台连接恢复。
- [x] 可信终端 owner、按客户端清理、兼容旧客户端、旧 daemon 隔离能力探测。
- [x] 电脑 TLS 网关、私有状态、本机控制 CLI、配对授权、下载与脱敏。
- [x] RN 页面、会话历史与恢复、终端、文件、审查和宿主管理能力。
- [x] CLI 装配、依赖锁定、移动依赖边界、构建和部署说明。
- [x] 受影响集成、包类型检查、构建、真实模型验证。
- [x] 可用环境下 Android APK 和 iOS Simulator 打包；缺少环境的验收如下标注。
- [x] 最终差异检查、远端检查与隔离集成验证；交付时更新 main 并清理临时分支。

## 实施边界

网关不会暴露本机 socket、shutdown、全局终端清理、工作区信任或能力凭据。手机只能通过白名单方法和授权工作区 ID 操作。终端 shell 不是工作区沙箱。关闭网关不停止任务或 daemon。请求关联 ID 不能替代业务幂等；未确认的写操作先查询状态，终端输入不自动重发。

## 环境记录

macOS arm64，Node 26.7.0。默认开发目录为 Command Line Tools，但发现已安装 Xcode 26.6，构建时仅为该命令指定 `DEVELOPER_DIR`，未修改全局配置。Expo 57.0.26 / RN 0.86.3 / React 19.2.3 锁定兼容补丁版本。新增依赖未改变既有包的版本。

## 已完成验证

- `npm ci`、根项目 `npm run build`（包含各 workspace 包和 Worker 资源）。
- 移动端 typecheck；桌面 main/preload/renderer 三份 typecheck；移动端共享图无 Node/Electron 依赖，架构门禁无逆依赖。
- 60 条受影响集成测试：HTTPS/WSS 配对/授权/撤销、历史恢复、移动会话/文件/终端、安全配置与生产 daemon 的终端 owner/递归清理隔离。另 32 条 CLI 和架构契约测试通过。
- 最终状态真实模型 E2E：独立生产 daemon 经 TLS 网关返回中文回复；相同业务幂等键仅产生一次运行；WSS 推送和正式历史分页一致；关闭网关后 daemon 可继续查询。
- 双端 Hermes export，Android `assembleRelease` 及 `apksigner verify`；iOS Simulator Release `xcodebuild`，在 iPhone 17 Pro / iOS 26.5 模拟器中无 Metro 启动。
- macOS 网关发布 tarball 包含新包与运行资源，经独立临时目录解压后 `pico remote --help` 启动检查。
- 针对最终安全修改的独立只读复查通过：LSP 命令参数脱敏、递归会话清理预检与创建锁、旧 Host 清理能力拒绝。

根级 `tsc --noEmit` 仍有既存桌面/测试 fixture 类型错误；基线也失败，最终错误未涉及本次新增移动端、远程包或测试。不能将根级全量 typecheck 标为通过。已通过的包构建和独立桌面/移动配置检查如上。

## 交付及待验收项

交付保存在原仓库 `output/mobile/direct-2026-10-02/`（忽略 Git）：Android Release APK、iOS Simulator ZIP、网关 tarball、启动截图、脱敏日志、构建元数据和 SHA-256。模拟器 ZIP 不能作为 iOS 真机 IPA。APK 为内测签名，不是商店生产签名。

| 场景                                       | 状态                        |
| ------------------------------------------ | --------------------------- |
| macOS 网关和本机可信 TLS 链路              | 已自动化验证                |
| iOS Simulator 无 Metro 启动                | 已验证                      |
| Android APK 编译/签名校验                  | 已验证；无设备，未安装启动  |
| iOS 真机 IPA 签名/安装                     | 缺少 Apple 签名配置，未验证 |
| Windows/Linux 网关原生打包及 DACL/进程行为 | 未在对应系统执行            |
| 蜂窝、IPv4 端口映射、可达 IPv6             | 缺少可达公网入口，未验证    |
| 真机软键盘、系统分享和网络切换完整矩阵     | 未验证                      |

部署和回退见 `docs/remote/mobile-direct.md`。旧 daemon 必须在本机更新/重启才能启用清理隔离；关闭网关不会取消任务或终止 daemon。
