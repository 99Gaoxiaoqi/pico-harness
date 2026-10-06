import { publicEndpoint } from "./policy.js";

/** Remote projections additionally remove executable configuration and credential-bearing endpoints. */
export function projectRemoteResult(method: string, result: unknown): unknown {
  if (method === "provider.test" && result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    return {
      ...value,
      message: value["ok"] ? "Provider 验证成功" : "Provider 验证失败，请查看电脑本机诊断",
    };
  }
  if (
    method.startsWith("config.") ||
    method.startsWith("provider.") ||
    method.startsWith("mcp.") ||
    method === "hooks.manage" ||
    method === "plugin.manage"
  )
    return publicConfiguration(
      result,
      method.startsWith("config.") || method === "hooks.manage" || method === "plugin.manage",
    );
  return result;
}
function publicConfiguration(value: unknown, hideExecutableText: boolean): unknown {
  if (Array.isArray(value))
    return value.map((entry) => publicConfiguration(entry, hideExecutableText));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (
      [
        "env",
        "headers",
        "apikey",
        "secret",
        "password",
        "token",
        "accesstoken",
        "refreshtoken",
        "clientsecret",
        "credential",
        "raw",
        "content",
        "script",
        "code",
        "manifest",
      ].includes(normalized)
    )
      continue;
    if (hideExecutableText && ["command", "args", "commands"].includes(normalized)) continue;
    if (["baseurl", "url", "endpoint"].includes(normalized) && typeof item === "string")
      output[key] = publicEndpoint(item);
    else if (["error", "loaderror", "message"].includes(normalized) && typeof item === "string")
      output[key] = "请查看电脑本机诊断";
    else output[key] = publicConfiguration(item, hideExecutableText);
  }
  return output;
}
