# Pico Desktop 发布手册

首版使用 Developer ID 站外分发。macOS 与 Windows 的签名、凭证和更新产物彼此独立；Windows 在凭证库、后台任务、ConPTY 与沙箱达到 macOS 对等前不进入公开发布工作流。

## macOS 发布环境

发布必须在受控的 macOS arm64/x64 Runner 上分别构建，并预装 Developer ID Application 证书。仓库只读取下列环境变量，不保存明文凭证：

- `PICO_MAC_SIGN_IDENTITY`：Developer ID Application 证书身份。
- `PICO_APPLE_ID`、`PICO_APPLE_ID_PASSWORD`、`PICO_APPLE_TEAM_ID`：`notarytool` 公证凭证。
- `PICO_UPDATE_BASE_URL`：Forge 生成更新 manifest 时使用的 HTTPS 静态发布根地址。
- `PICO_UPDATE_FEED_URL`：构建时验证并写入应用的 Squirrel HTTPS 更新源，安装后不再依赖用户运行环境变量。

缺少任一签名/公证变量时，只能生成本地无签名 smoke 包，不能标记为 Release。正式发布缺少任一更新地址、地址非 HTTPS，或 tag/手工输入版本与 `apps/desktop/package.json` 不一致时，工作流直接失败。本地未配置更新地址的 smoke 包保持禁用自动更新。

## 验证顺序

1. `npm ci`，然后运行生产依赖审计、Desktop typecheck 与全仓 lint。当前仓库不包含自动化测试代码，发布流程不声称存在 test gate。
2. 分别执行 `npm run desktop:make -- --arch=arm64` 与 `--arch=x64`。
3. 用 `codesign --verify --deep --strict` 验证 `.app`，用 `spctl --assess --type execute` 验证 Gatekeeper。
4. 用 `xcrun stapler validate` 验证公证票据已装订。
5. 在没有开发证书和仓库源码的干净机器上安装 DMG，完成首次启动、工作区信任、任务审批、退出与重启。
6. 从上一正式版本执行一次 ZIP 自动更新，验证下载、延后安装和重新启动安装。

## 依赖审计边界

`npm audit --omit=dev --audit-level=high` 必须为 0。当前 Electron Forge 7 的构建期依赖仍包含上游 `tar/tmp` 告警，且 Forge 可用版本没有完整修复；它不进入应用生产依赖，但发布 Runner 不应处理不受信任的源码或制品。上游出现修复版本后升级 Forge，并在全量审计归零前保留这一已知风险。
