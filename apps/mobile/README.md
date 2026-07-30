# Pico Mobile

Pico 的 iOS / Android 共用开发预览客户端，基于 Expo SDK 57、React Native 与 Expo
Router。它通过带临时 Token 的本机 Mobile Gateway 读取 Desktop 已信任的项目、会话和实时
运行状态。

Mobile Gateway 固定监听回环地址，不是公开 REST/WebSocket API。当前只支持本机 iOS /
Android 模拟器，不支持真机、局域网访问或移动端发布包。

## 启动顺序

在仓库根目录安装依赖：

```bash
npm ci
```

先启动 Desktop，并保持进程运行。Desktop 会启动或连接当前 `PICO_HOME` 对应的本机
daemon：

```bash
npm run desktop:dev
```

在第二个终端启动 Mobile Gateway：

```bash
npm run mobile:gateway
```

Gateway 默认监听 `127.0.0.1:47831`，并在终端输出本次临时 Token。Desktop 与 Gateway
必须使用同一个 `PICO_HOME`。如需固定开发端口或 Token，可在启动 Gateway 前设置：

```bash
export PICO_MOBILE_GATEWAY_PORT=47831
export PICO_MOBILE_GATEWAY_TOKEN=replace-with-a-local-token-at-least-32-bytes
```

在第三个终端启动 Expo，或直接打开对应模拟器：

```bash
npm run start --workspace @pico/mobile
npm run ios --workspace @pico/mobile
npm run android --workspace @pico/mobile
```

在 Mobile 首页填写 Gateway 输出的临时 Token。默认地址为：

- iOS 模拟器：`http://127.0.0.1:47831`
- Android 模拟器：`http://10.0.2.2:47831`

连接成功后只会展示 daemon 已注册且已信任的工作区。Gateway 重启后，随机生成的临时
Token 会失效；只有显式设置 `PICO_MOBILE_GATEWAY_TOKEN` 才会在开发进程之间保持不变。
地址与 Token 由客户端保存在本机 SecureStore。

## 边界

- Gateway 只绑定 `127.0.0.1`。HTTP 请求使用 `Authorization: Bearer <token>`；WebSocket
  连接后必须在 5 秒内用首个 JSON 帧 `{"type":"authenticate","token":"..."}` 提交同一
  Token。
- Mobile 只接收不含工作区绝对路径的投影；项目使用 Gateway 会话内的 opaque ID。
- 当前能力面是项目与会话列表、会话记录、文本发送和实时运行投影，不代表公开移动端协议
  或跨版本兼容承诺。
- Gateway 连接失败时，先确认 Desktop/daemon 仍在运行，并检查两个进程的 `PICO_HOME`
  是否一致。

## 验证

```bash
npm run typecheck --workspace @pico/mobile
npm run lint --workspace @pico/mobile
npm run build:protocol
node --import tsx --import ./src/tui/preload-env.ts \
  --test tests/integration/mobile-*.test.ts
cd apps/mobile
npx expo-doctor
```
