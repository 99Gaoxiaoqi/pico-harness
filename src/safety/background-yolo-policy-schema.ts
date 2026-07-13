import { domainToASCII } from "node:url";
import { isIP } from "node:net";

export type ToolNetworkPolicy = "disabled" | "allowlist";

/**
 * 后台 Job 创建时冻结的工具网络边界。
 *
 * 这里只约束 Agent 工具（fetch_url/web_search/Bash/Hook/MCP）的出站访问；
 * Provider 调用模型所需的网络连接不属于该策略。
 */
export interface BackgroundYoloPolicySnapshotData {
  mode: "yolo";
  backgroundEnabled: true;
  trustedWorkspace: true;
  toolNetworkPolicy: ToolNetworkPolicy;
  allowedToolNetworkHosts?: string[];
  allowedTools: string[];
  hardlineVersion: string;
  hookVersion: string;
  createdAt: number;
}

/** 读取旧版账本时接受的历史字段；新写入一律使用 toolNetwork* 字段。 */
interface LegacyToolNetworkPolicyFields {
  networkPolicy?: unknown;
  allowedNetworkHosts?: unknown;
}

export class BackgroundYoloPolicySnapshotError extends Error {
  override readonly name = "BackgroundYoloPolicySnapshotError";
}

/**
 * Job 创建与后台执行共用的严格解析器，避免“保存成功、执行时才 blocked”。
 * 返回值始终是规范化的新字段形态，可直接持久化。
 */
export function parseBackgroundYoloPolicySnapshot(
  value: unknown,
): BackgroundYoloPolicySnapshotData {
  if (!isRecord(value)) throw invalid("policySnapshot 必须是对象");

  const legacy = value as LegacyToolNetworkPolicyFields;
  const canonicalPolicy = value["toolNetworkPolicy"];
  const legacyPolicy = legacy.networkPolicy;
  if (
    canonicalPolicy !== undefined &&
    legacyPolicy !== undefined &&
    canonicalPolicy !== legacyPolicy
  ) {
    throw invalid("toolNetworkPolicy 与旧版 networkPolicy 冲突");
  }
  const toolNetworkPolicy = canonicalPolicy ?? legacyPolicy;
  const canonicalHosts = value["allowedToolNetworkHosts"];
  const legacyHosts = legacy.allowedNetworkHosts;
  if (canonicalHosts !== undefined && legacyHosts !== undefined) {
    throw invalid("不得同时声明 allowedToolNetworkHosts 与旧版 allowedNetworkHosts");
  }
  const rawHosts = canonicalHosts ?? legacyHosts;
  const allowedTools = value["allowedTools"];

  if (
    value["mode"] !== "yolo" ||
    value["backgroundEnabled"] !== true ||
    value["trustedWorkspace"] !== true ||
    (toolNetworkPolicy !== "disabled" && toolNetworkPolicy !== "allowlist") ||
    !Array.isArray(allowedTools) ||
    !allowedTools.every(isNonEmptyString) ||
    typeof value["hardlineVersion"] !== "string" ||
    typeof value["hookVersion"] !== "string" ||
    typeof value["createdAt"] !== "number" ||
    !Number.isFinite(value["createdAt"])
  ) {
    throw invalid("只接受完整的 trusted workspace + yolo policySnapshot");
  }

  if (toolNetworkPolicy === "disabled" && rawHosts !== undefined) {
    throw invalid("toolNetworkPolicy=disabled 时不得声明工具网络 allowlist");
  }

  let allowedToolNetworkHosts: string[] | undefined;
  if (toolNetworkPolicy === "allowlist") {
    if (!Array.isArray(rawHosts) || rawHosts.length === 0) {
      throw invalid("toolNetworkPolicy=allowlist 时必须提供非空 allowedToolNetworkHosts");
    }
    allowedToolNetworkHosts = rawHosts.map((host) => {
      if (typeof host !== "string") throw invalid("工具网络 allowlist 只能包含 hostname");
      return normalizeExactHostname(host);
    });
    allowedToolNetworkHosts = [...new Set(allowedToolNetworkHosts)];
  }

  return {
    mode: "yolo",
    backgroundEnabled: true,
    trustedWorkspace: true,
    toolNetworkPolicy,
    ...(allowedToolNetworkHosts ? { allowedToolNetworkHosts } : {}),
    allowedTools: [...new Set(allowedTools)],
    hardlineVersion: value["hardlineVersion"],
    hookVersion: value["hookVersion"],
    createdAt: value["createdAt"],
  };
}

/** 只接受精确 hostname；不接受 scheme、端口、路径或通配符。 */
export function normalizeExactHostname(value: string): string {
  if (value !== value.trim() || value.length === 0 || value.includes("*")) {
    throw invalid(`非法 hostname: ${JSON.stringify(value)}`);
  }
  const withoutTrailingDot = value.replace(/\.$/, "").toLowerCase();
  if (
    withoutTrailingDot.length === 0 ||
    withoutTrailingDot.includes("://") ||
    withoutTrailingDot.includes("/") ||
    withoutTrailingDot.includes("?") ||
    withoutTrailingDot.includes("#")
  ) {
    throw invalid(`非法 hostname: ${JSON.stringify(value)}`);
  }
  if (isIP(withoutTrailingDot) !== 0) return withoutTrailingDot;

  const ascii = domainToASCII(withoutTrailingDot);
  if (
    ascii.length === 0 ||
    ascii.length > 253 ||
    ascii.split(".").some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  ) {
    throw invalid(`非法 hostname: ${JSON.stringify(value)}`);
  }
  return ascii;
}

function invalid(message: string): BackgroundYoloPolicySnapshotError {
  return new BackgroundYoloPolicySnapshotError(message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
