import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const help = `Pico 发布输入校验（不执行签名、上传或真机验收）
用法：node apps/mobile/scripts/verify-release.mjs [--internal | --store]
  --app-json FILE          默认 apps/mobile/app.json
  --android-manifest FILE  可选：实际构建产物导出的 XML Manifest
  --ios-plist FILE         可选：实际构建产物的 Info.plist（XML、JSON；macOS 支持二进制）
  --artifact FILE          可重复：非空 APK/AAB/IPA/ZIP/TGZ，输出大小与 SHA-256
  --signing-verified       调用方声明指定产物已完成外部验签；商店模式必需
内部模式允许发布主体、隐私政策、支持渠道暂缺；两种模式都要求明确版本和构建号。
`;

try {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        internal: { type: "boolean" },
        store: { type: "boolean" },
        help: { type: "boolean" },
        "app-json": { type: "string" },
        "android-manifest": { type: "string" },
        "ios-plist": { type: "string" },
        artifact: { type: "string", multiple: true },
        "signing-verified": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new Error("参数无效，请使用 --help 查看支持的参数");
  }
  if (values.help) {
    process.stdout.write(help);
  } else {
    if (values.internal && values.store) throw new Error("--internal 与 --store 不能同时使用");
    const mode = values.store ? "store" : "internal";
    const configPath = await safeFile(
      values["app-json"] ?? resolve(appRoot, "app.json"),
      [".json"],
      "app.json",
    );
    let config;
    try {
      config = JSON.parse(await readFile(configPath, "utf8")).expo;
    } catch {
      throw new Error("app.json 不是有效 JSON 配置");
    }
    requireText(config?.name, "expo.name");
    if (!/^\d+\.\d+\.\d+$/.test(config?.version ?? ""))
      throw new Error("expo.version 须明确为三段数字版本");
    requireText(config?.ios?.bundleIdentifier, "ios.bundleIdentifier");
    requireText(config?.android?.package, "android.package");
    if (
      typeof config?.ios?.buildNumber !== "string" ||
      !/^\d+(?:\.\d+){0,2}$/.test(config.ios.buildNumber)
    )
      throw new Error("ios.buildNumber 须显式配置为数字构建号");
    if (!Number.isSafeInteger(config?.android?.versionCode) || config.android.versionCode < 1)
      throw new Error("android.versionCode 须显式配置为正整数");

    const release = config.extra?.release ?? {};
    const missing = [];
    for (const [field, check] of [
      [
        "publisher",
        (value) =>
          typeof value === "string" &&
          value.trim() &&
          !/待配置|未配置|TODO|placeholder/i.test(value),
      ],
      ["privacyPolicyUrl", httpsUrl],
    ]) {
      if (!check(release[field])) {
        if (release[field] || mode === "store")
          throw new Error(`expo.extra.release.${field} 缺失或无效`);
        missing.push(field);
      }
    }
    const hasSupportUrl = httpsUrl(release.supportUrl);
    const hasSupportEmail =
      typeof release.supportEmail === "string" &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(release.supportEmail.trim());
    if (release.supportUrl && !hasSupportUrl)
      throw new Error("expo.extra.release.supportUrl 须为有效 HTTPS 地址");
    if (release.supportEmail && !hasSupportEmail)
      throw new Error("expo.extra.release.supportEmail 无效");
    if (!hasSupportUrl && !hasSupportEmail) {
      if (mode === "store") throw new Error("商店模式需要支持 HTTPS 地址或支持邮箱");
      missing.push("supportUrl/supportEmail");
    }
    if (mode === "store" && !values["signing-verified"])
      throw new Error(
        "商店模式须提供 --signing-verified，声明已在外部完成正式签名验签；本脚本不验证签名",
      );

    const nativePermissions = { android: "not-provided", ios: "not-provided" };
    if (values["android-manifest"]) {
      const path = await safeFile(values["android-manifest"], [".xml"], "Android Manifest");
      const xml = (await readFile(path, "utf8")).replace(/<!--[\s\S]*?-->/g, "");
      const manifest = xml.match(/<manifest\b([^>]*)>/)?.[1];
      const application = xml.match(/<application\b([^>]*)>/)?.[1];
      if (!manifest || !application) throw new Error("Android Manifest 缺少 manifest/application");
      const permissions = [...xml.matchAll(/<uses-permission(?:-sdk-\d+)?\b([^>]*)>/g)].map(
        (match) => xmlAttribute(match[1], "android:name"),
      );
      if (permissions.includes("android.permission.RECORD_AUDIO"))
        throw new Error("Android Manifest 仍声明多余 RECORD_AUDIO 权限");
      for (const permission of ["android.permission.CAMERA", "android.permission.INTERNET"])
        if (!permissions.includes(permission))
          throw new Error("Android Manifest 缺少相机或网络权限");
      for (const [attribute, expected] of [
        ["package", config.android.package],
        ["android:versionName", config.version],
        ["android:versionCode", String(config.android.versionCode)],
      ])
        if (xmlAttribute(manifest, attribute) !== expected)
          throw new Error(`Android Manifest 的 ${attribute} 缺失或与 app.json 不一致`);
      if (xmlAttribute(application, "android:usesCleartextTraffic") !== "false")
        throw new Error("Android Manifest 必须禁用明文网络");
      if (xmlAttribute(application, "android:debuggable") === "true")
        throw new Error("Android Manifest 是可调试构建");
      nativePermissions.android = "passed";
    }
    if (values["ios-plist"]) {
      const path = await safeFile(
        values["ios-plist"],
        [".plist", ".xml", ".json"],
        "iOS Info.plist",
      );
      const plist = await loadPlist(path);
      if (Object.hasOwn(plist, "NSMicrophoneUsageDescription"))
        throw new Error("iOS Info.plist 仍声明多余 NSMicrophoneUsageDescription");
      for (const [key, expected] of [
        ["CFBundleIdentifier", config.ios.bundleIdentifier],
        ["CFBundleShortVersionString", config.version],
        ["CFBundleVersion", config.ios.buildNumber],
      ])
        if (plist[key] !== expected)
          throw new Error(`iOS Info.plist 的 ${key} 缺失或与 app.json 不一致`);
      requireText(plist.NSCameraUsageDescription, "iOS NSCameraUsageDescription");
      requireText(plist.NSPhotoLibraryUsageDescription, "iOS NSPhotoLibraryUsageDescription");
      nativePermissions.ios = "passed";
    }
    const artifacts = [];
    for (const supplied of values.artifact ?? []) {
      const path = await safeFile(supplied, [".apk", ".aab", ".ipa", ".zip", ".tgz"], "产物");
      const info = await stat(path);
      if (!info.size) throw new Error("产物为空文件");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      artifacts.push({ path, bytes: info.size, sha256: hash.digest("hex") });
    }
    process.stdout.write(
      JSON.stringify(
        {
          status: "passed",
          mode,
          version: config.version,
          iosBuildNumber: config.ios.buildNumber,
          androidVersionCode: config.android.versionCode,
          missingReleaseInfo: missing,
          nativePermissions,
          artifacts,
          signing: {
            externallyVerifiedDeclared: !!values["signing-verified"],
            verifiedByThisScript: false,
          },
          limitation:
            "仅校验给定配置、原生声明及产物摘要；不验证正式签名、资料真实性/链接可达性、版本递增、真机行为或商店审核。未提供的原生文件标为 not-provided。",
        },
        null,
        2,
      ) + "\n",
    );
  }
} catch (error) {
  // Never echo raw configuration, native files, tool output or arbitrary filesystem errors.
  const message = error instanceof Error ? error.message : "发布输入校验失败";
  process.stderr.write(`发布输入校验失败：${message}\n`);
  process.exitCode = 1;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 缺失`);
}
function httpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}
async function safeFile(supplied, extensions, label) {
  try {
    const path = await realpath(resolve(supplied));
    const parts = path.split(/[/\\]/);
    const output = parts.indexOf("output");
    if (output >= 0 && parts.slice(output + 1).includes("private"))
      throw new Error("private input");
    if (!extensions.includes(extname(path).toLowerCase()) || !(await stat(path)).isFile())
      throw new Error("unsupported file");
    return path;
  } catch {
    throw new Error(`${label} 输入不存在、格式不受支持或属于禁止读取的私有目录`);
  }
}
function xmlAttribute(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`))?.[2];
}
async function loadPlist(path) {
  const contents = await readFile(path);
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) throw new Error("iOS Info.plist 无法解析");
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error("iOS Info.plist 无法解析");
    }
  }
  const text = contents.toString("utf8").replace(/<!--[\s\S]*?-->/g, "");
  try {
    if (text.trim().startsWith("{")) return JSON.parse(text);
    if (!/<plist\b[^>]*>\s*<dict>/.test(text) || !/<\/dict>\s*<\/plist>\s*$/.test(text))
      throw new Error("invalid XML plist");
    const plist = {};
    for (const match of text.matchAll(/<key>([^<]+)<\/key>\s*<(string|integer)>([^<]*)<\/\2>/g)) {
      plist[decodeXml(match[1])] = decodeXml(match[3]);
    }
    if (/<key>\s*NSMicrophoneUsageDescription\s*<\/key>/.test(text))
      plist.NSMicrophoneUsageDescription ??= "";
    return plist;
  } catch {
    throw new Error("iOS Info.plist 无法解析；非 macOS 平台请提供 XML 或 JSON");
  }
}
function decodeXml(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (entity) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    return (
      named[entity] ??
      String.fromCodePoint(
        Number(entity.startsWith("&#x") ? "0x" + entity.slice(3, -1) : entity.slice(2, -1)),
      )
    );
  });
}
