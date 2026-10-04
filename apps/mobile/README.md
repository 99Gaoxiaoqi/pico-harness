# Pico Mobile

React Native / Expo 原生 iOS、Android 客户端，支持电脑 HTTPS/WSS 直连及内置 Relay。使用 Relay 时电脑和手机都主动出站，业务数据在两端之间加密；模型、工具和会话历史仍由电脑处理和保存。

## 构建

在仓库根目录安装依赖并构建共享包：

```sh
npm install
npm run build --workspace @pico/core
npm run build --workspace @pico/protocol
npm run build --workspace @pico/transcript-replica
npm run build --workspace @pico/remote-client
npm run typecheck --workspace @pico/mobile
npm run bundle --workspace @pico/mobile
```

`bundle` 生成离线内置资源可用的双端 Hermes bundle，并先把 xterm.js 和 FitAddon 打包进本地终端页面。生成文件不加入 Git。

调试需要 development build。安装 Xcode / Android SDK 后：

```sh
npm run ios --workspace @pico/mobile
npm run android --workspace @pico/mobile
npm run start --workspace @pico/mobile
```

内测包需使用 Release 配置，不能把依赖 Metro 的 Debug 包当作离线交付。Android：

```sh
cd apps/mobile
node scripts/build-terminal.mjs
npx expo prebuild --no-install
cd android
./gradlew assembleRelease
```

iOS 使用 `ios/Pico.xcworkspace` 的 Release 配置。真机安装必须由本机 Apple 开发签名配置签发；本仓库不保存签名秘密。生成的 `ios/`、`android/` 工程和构建产物不加入 Git。

## 配对与使用

推荐在电脑「设置 → 手机连接」配置已部署的 HTTPS Relay，选择授权项目，开启连接后生成二维码。手机扫码、填写设备名称，然后回电脑核对权限并批准。Relay 的部署和邀请步骤见[部署说明](../../docs/remote/relay-deployment.md)，电脑后台行为见[桌面连接说明](../../docs/remote/desktop-relay.md)。

既有直连仍可使用 `pico remote pair`。令牌保存在 SecureStore；电脑列表保存端点、设备标识及二维码固定的电脑公钥。旧直连记录不会静默改为中继；新增配对保留独立设备身份，避免混用草稿和缓存。

选择授权工作区、进入会话。会话页面提供图片输入、运行控制、审批、计划和问答；工作栏包含任务、Graph、执行、追踪、上下文、用量、文件、终端、审查及会话设置。

终端、代码应用 / Rewind、电脑级配置需要额外授权。终端属于电脑用户 Shell，工作区权限不是 Shell 沙箱。其他客户端创建的终端仅可查看。手机退出、断网或切到后台只断开显示，电脑任务继续执行。

图片保持当前协议的最多 4 张、总量 256 KiB；不支持任意文档输入。生成文件下载至临时文件，按大小和 SHA-256 校验后才显示或分享。HTML 仅静态隔离预览，无法执行脚本、载入外部资源或使用终端桥。

`Provider` 密钥仅写入，提交后清空；`MCP` 的秘密字段显式选择保留、替换、删除；编辑已有连接时默认保留原 URL、命令和参数，脱敏显示不会覆盖原凭据。配置冲突刷新后重试，不覆盖他人更新。

手机后台不推送通知。恢复前台后重建订阅并补齐历史；写操作响应丢失显示“结果未确认”，终端输入按顺序提交，不会自动重发；响应丢失时暂停后续输入，用户检查输出后才恢复。

## 验证

```sh
node --import tsx --test tests/integration/remote/mobile-session.test.ts
```

集成覆盖 transcript 分页、增量补齐、序列间隙恢复、切换防迟到响应、终端串行轮询，以及附件预算 / 下载摘要校验。真机软键盘、系统分享、IPv4 / IPv6 跨网、签名和三种电脑系统的安装仍需实际环境验收。

## 发布校验与本轮候选

当前 Relay 内部候选为 `0.1.2`，iOS buildNumber `3`、Android versionCode `3`。正式发布前需核对目标渠道已有最高编号；本仓库不能证明渠道编号递增。主体、隐私政策和支持渠道集中配置在 `app.json` 的 `expo.extra.release`，当前为空，只可用于内部验证。

```sh
npm run verify:release --workspace @pico/mobile -- --internal
node apps/mobile/scripts/verify-release.mjs --internal --android-manifest /absolute/merged/AndroidManifest.xml --ios-plist /absolute/Pico.app/Info.plist --artifact /absolute/pico.apk
node apps/mobile/scripts/verify-release.mjs --store --signing-verified --android-manifest /absolute/merged/AndroidManifest.xml --ios-plist /absolute/Pico.app/Info.plist --artifact /absolute/release.apk
```

校验器拒绝麦克风声明、可调试 Android 包、缺失构建号和空产物；商店模式还要求完整发布资料和外部验签声明。`--signing-verified` 仅记录调用方声明，本脚本不验证正式签名、链接可达性或真机行为。正式资料尚缺时商店模式应失败，不能把内部模式通过视为可公开发布。

Android 通过本地 Expo config plugin 显式写入 `usesCleartextTraffic=false`；`android.blockedPermissions` 阻止依赖重新引入麦克风。不要仅修改 app.json 后复用旧原生包。

未配置 Apple Team 时，模拟器验收使用本地 ad hoc 签名，并在 Xcode 链接阶段嵌入仅供模拟器的 entitlement：

```sh
cd apps/mobile/ios
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace Pico.xcworkspace -scheme Pico -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /absolute/simulator-build ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_ENTITLEMENTS=/absolute/repo/apps/mobile/scripts/ios-simulator.entitlements.plist
```

`ios-simulator.entitlements.plist` 的 namespace 仅用于隔离模拟器 Keychain，不能用于真机、Archive、IPA 或商店签名。仅事后 codesign 无法替代模拟器链接阶段的 entitlement；完全禁用签名会使部分环境中的 SecureStore 不可用。真机使用真实 Apple Team 和对应签名配置。

Relay 本轮验证与交付状态见 [中继实施记录](../../docs/plans/2026-10-04-mobile-relay-implementation.md)。此前 UI 整改候选证据见 [历史交付记录](../../docs/plans/2026-10-04-mobile-release-delivery.md)，其原生验证不能代替本次 Relay 候选。正式签名和公网蜂窝验收须有相应资源后单独执行。
