import Constants from "expo-constants";
import { Platform } from "react-native";

const config = Constants.expoConfig;
const release = config?.extra?.release as Record<string, unknown> | undefined;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const https = (value: unknown) => {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
};
export const releaseInfo = {
  version: Constants.nativeAppVersion ?? config?.version ?? "未知",
  build:
    Constants.nativeBuildVersion ??
    (Platform.OS === "ios"
      ? config?.ios?.buildNumber
      : String(config?.android?.versionCode ?? "未知")),
  publisher: text(release?.publisher),
  privacyPolicyUrl: https(release?.privacyPolicyUrl),
  supportUrl: https(release?.supportUrl),
  supportEmail: /^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(text(release?.supportEmail))
    ? text(release?.supportEmail)
    : "",
};
export function safeDiagnostic(phase: string, code?: string) {
  return JSON.stringify(
    {
      app: "Pico",
      version: releaseInfo.version,
      build: releaseInfo.build,
      platform: Platform.OS,
      phase,
      errorCode: code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "NONE_OR_OTHER",
    },
    null,
    2,
  );
}
