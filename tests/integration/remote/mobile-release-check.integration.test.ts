import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../../apps/mobile/scripts/verify-release.mjs", import.meta.url),
);
const config = () => ({
  expo: {
    name: "Pico",
    version: "0.1.0",
    ios: { bundleIdentifier: "dev.pico.mobile", buildNumber: "1" },
    android: { package: "dev.pico.mobile", versionCode: 1 },
    extra: { release: { publisher: "", privacyPolicyUrl: "", supportUrl: "", supportEmail: "" } },
  },
});
const androidXml = (microphone = false) => `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.pico.mobile" android:versionName="0.1.0" android:versionCode="1">
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-permission android:name="android.permission.INTERNET" />
  ${microphone ? '<uses-permission android:name="android.permission.RECORD_AUDIO" />' : ""}
  <application android:usesCleartextTraffic="false" android:debuggable="false" />
</manifest>`;
const iosXml = (microphone = false) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.pico.mobile</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSCameraUsageDescription</key><string>扫码和拍摄图片</string>
  <key>NSPhotoLibraryUsageDescription</key><string>选择图片</string>
  ${microphone ? "<key>NSMicrophoneUsageDescription</key><string></string>" : ""}
</dict></plist>`;

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "pico-mobile-release-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appJson = join(root, "app.json");
  const manifest = join(root, "AndroidManifest.xml");
  const plist = join(root, "Info.plist");
  const artifact = join(root, "pico.apk");
  await Promise.all([
    writeFile(appJson, JSON.stringify(config())),
    writeFile(manifest, androidXml()),
    writeFile(plist, iosXml()),
    writeFile(artifact, "opaque package fixture"),
  ]);
  return {
    root,
    appJson,
    manifest,
    plist,
    artifact,
    run(...args: string[]) {
      return spawnSync(process.execPath, [script, "--app-json", appJson, ...args], {
        encoding: "utf8",
        timeout: 10000,
      });
    },
    async saveConfig(value: ReturnType<typeof config>) {
      await writeFile(appJson, JSON.stringify(value));
    },
  };
}

test("发布校验内部模式允许资料暂缺，校验 XML 原生声明并输出产物摘要与验签边界", async (t) => {
  const f = await fixture(t);
  const result = f.run(
    "--internal",
    "--android-manifest",
    f.manifest,
    "--ios-plist",
    f.plist,
    "--artifact",
    f.artifact,
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "internal");
  assert.deepEqual(report.missingReleaseInfo, [
    "publisher",
    "privacyPolicyUrl",
    "supportUrl/supportEmail",
  ]);
  assert.deepEqual(report.nativePermissions, { android: "passed", ios: "passed" });
  assert.equal(report.iosBuildNumber, "1");
  assert.equal(report.androidVersionCode, 1);
  assert.equal(report.artifacts[0].bytes, Buffer.byteLength("opaque package fixture"));
  assert.equal(
    report.artifacts[0].sha256,
    createHash("sha256").update("opaque package fixture").digest("hex"),
  );
  assert.equal(report.signing.verifiedByThisScript, false);
  const defaults = f.run();
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout).nativePermissions, {
    android: "not-provided",
    ios: "not-provided",
  });
});

test("商店模式拒绝缺失发布资料或外部验签声明，两端麦克风和错误构建字段阻止验收", async (t) => {
  const f = await fixture(t);
  assert.match(f.run("--store").stderr, /publisher 缺失或无效/);
  const ready = config();
  ready.expo.extra.release.publisher = "测试用发布主体";
  await f.saveConfig(ready);
  assert.match(f.run("--store").stderr, /privacyPolicyUrl 缺失或无效/);
  ready.expo.extra.release.privacyPolicyUrl = "https://pico.example.test/privacy";
  await f.saveConfig(ready);
  assert.match(f.run("--store").stderr, /支持 HTTPS 地址或支持邮箱/);
  ready.expo.extra.release.supportEmail = "support@example.test";
  await f.saveConfig(ready);
  assert.match(f.run("--store").stderr, /--signing-verified/);
  const declared = f.run("--store", "--signing-verified");
  assert.equal(declared.status, 0, declared.stderr);
  assert.deepEqual(JSON.parse(declared.stdout).signing, {
    externallyVerifiedDeclared: true,
    verifiedByThisScript: false,
  });
  await writeFile(f.manifest, androidXml(true));
  const androidRejected = f.run("--store", "--signing-verified", "--android-manifest", f.manifest);
  assert.equal(androidRejected.status, 1);
  assert.match(androidRejected.stderr, /RECORD_AUDIO/);
  await writeFile(f.plist, iosXml(true));
  const iosRejected = f.run("--internal", "--ios-plist", f.plist);
  assert.equal(iosRejected.status, 1);
  assert.match(iosRejected.stderr, /NSMicrophoneUsageDescription/);
  ready.expo.ios.buildNumber = "";
  await f.saveConfig(ready);
  assert.match(f.run("--internal").stderr, /buildNumber/);
  await f.saveConfig(config());
  await writeFile(f.artifact, "");
  assert.match(f.run("--artifact", f.artifact).stderr, /产物为空/);
  const privateRoot = join(f.root, "output", "mobile", "private");
  await mkdir(privateRoot, { recursive: true });
  const privateInput = join(privateRoot, "app.json");
  await writeFile(privateInput, "not-a-secret-test-fixture");
  const privateRejected = spawnSync(process.execPath, [script, "--app-json", privateInput], {
    encoding: "utf8",
  });
  assert.equal(privateRejected.status, 1);
  assert.match(privateRejected.stderr, /禁止读取的私有目录/);
  assert.equal(privateRejected.stderr.includes("not-a-secret-test-fixture"), false);
});
