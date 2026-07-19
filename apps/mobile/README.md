# Pico Mobile

Pico 的 iOS / Android 共用客户端，基于 Expo SDK 57、React Native 与 Expo Router。

## 本地开发

在仓库根目录安装依赖：

```bash
npm install
```

启动 Expo：

```bash
npm run start --workspace @pico/mobile
```

也可以分别打开模拟器：

```bash
npm run ios --workspace @pico/mobile
npm run android --workspace @pico/mobile
```

## 验证

```bash
npm run typecheck --workspace @pico/mobile
npm run lint --workspace @pico/mobile
cd apps/mobile && npx expo-doctor
```
