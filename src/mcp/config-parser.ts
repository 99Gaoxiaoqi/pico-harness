import type { McpConfig, McpServerConfig } from "./types.js";

/** Parse MCP definitions without starting a client or resolving credentials. */
export function parseMcpConfig(value: unknown, source: string): McpConfig {
  if (!isRecord(value)) throw new Error(`MCP 配置 ${source} 根结构必须是对象`);
  const rawServers = value["mcpServers"];
  if (!isRecord(rawServers)) throw new Error(`MCP 配置 ${source} 缺少 mcpServers 字段或非对象`);

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [rawName, rawConfig] of Object.entries(rawServers)) {
    const name = rawName.trim();
    if (!name || name !== rawName) throw new Error(`MCP 配置 ${source} 中 server 名称无效`);
    if (!isRecord(rawConfig)) {
      throw new Error(`MCP 配置 ${source} 中 server "${name}" 必须是对象`);
    }
    const transport = rawConfig["transport"] ?? "stdio";
    if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
      throw new Error(`MCP server "${name}" 的 transport 必须是 stdio/http/sse`);
    }
    const command = optionalString(rawConfig["command"], source, name, "command");
    const url = optionalString(rawConfig["url"], source, name, "url");
    if (transport === "stdio" && command === undefined) {
      throw new Error(`MCP server "${name}" 是 stdio 模式但缺少 command`);
    }
    if ((transport === "http" || transport === "sse") && url === undefined) {
      throw new Error(`MCP server "${name}" 是 ${transport} 模式但缺少 url`);
    }
    const enabled = rawConfig["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error(`MCP server "${name}" 的 enabled 必须是 boolean`);
    }
    mcpServers[name] = {
      name,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(url !== undefined ? { url } : {}),
      ...optionalStringArrayProperty(rawConfig, source, name, "args"),
      ...optionalStringMapProperty(rawConfig, source, name, "env"),
      ...optionalStringMapProperty(rawConfig, source, name, "headers"),
      ...optionalStringProperty(rawConfig, source, name, "cwd"),
      ...optionalPositiveIntegerProperty(rawConfig, source, name, "startupTimeoutMs"),
      ...optionalPositiveIntegerProperty(rawConfig, source, name, "toolTimeoutMs"),
      ...(enabled !== undefined ? { enabled } : {}),
    };
  }
  return { mcpServers };
}

function optionalString(
  value: unknown,
  source: string,
  server: string,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MCP 配置 ${source} 中 server "${server}" 的 ${field} 必须是非空字符串`);
  }
  return value;
}

function optionalStringProperty(
  value: Record<string, unknown>,
  source: string,
  server: string,
  field: "cwd",
): Partial<Pick<McpServerConfig, "cwd">> {
  const parsed = optionalString(value[field], source, server, field);
  return parsed === undefined ? {} : { [field]: parsed };
}

function optionalStringArrayProperty(
  value: Record<string, unknown>,
  source: string,
  server: string,
  field: "args",
): Partial<Pick<McpServerConfig, "args">> {
  const raw = value[field];
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error(`MCP 配置 ${source} 中 server "${server}" 的 ${field} 必须是字符串数组`);
  }
  return { [field]: [...raw] as string[] };
}

function optionalStringMapProperty(
  value: Record<string, unknown>,
  source: string,
  server: string,
  field: "env" | "headers",
): Partial<Pick<McpServerConfig, "env" | "headers">> {
  const raw = value[field];
  if (raw === undefined) return {};
  if (!isRecord(raw) || Object.values(raw).some((item) => typeof item !== "string")) {
    throw new Error(`MCP 配置 ${source} 中 server "${server}" 的 ${field} 必须是字符串对象`);
  }
  return { [field]: { ...raw } as Record<string, string> };
}

function optionalPositiveIntegerProperty(
  value: Record<string, unknown>,
  source: string,
  server: string,
  field: "startupTimeoutMs" | "toolTimeoutMs",
): Partial<Pick<McpServerConfig, "startupTimeoutMs" | "toolTimeoutMs">> {
  const raw = value[field];
  if (raw === undefined) return {};
  if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
    throw new Error(`MCP 配置 ${source} 中 server "${server}" 的 ${field} 必须是正整数`);
  }
  return { [field]: raw as number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
