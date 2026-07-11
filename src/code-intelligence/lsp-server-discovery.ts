import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

export interface LspServerConfig {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly languages?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface LspServerDiscoveryOptions {
  readonly rootDir: string;
  /** 项目/宿主显式配置永远优先于 PATH 自动发现。 */
  readonly configuredServers?: readonly LspServerConfig[];
  readonly pathEnv?: string;
}

export interface LspServerDiscoveryResult {
  readonly config?: LspServerConfig;
  readonly source: "configured" | "path" | "none";
  readonly reason: string;
}

interface KnownServer {
  readonly markers: readonly string[];
  readonly command: string;
  readonly args: readonly string[];
  readonly languages: readonly string[];
}

const KNOWN_SERVERS: readonly KnownServer[] = [
  {
    markers: ["tsconfig.json", "jsconfig.json", "package.json"],
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  },
  {
    markers: ["pyproject.toml", "requirements.txt", "setup.py"],
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: ["python"],
  },
  {
    markers: ["Cargo.toml"],
    command: "rust-analyzer",
    args: [],
    languages: ["rust"],
  },
  {
    markers: ["go.mod", "go.work"],
    command: "gopls",
    args: [],
    languages: ["go"],
  },
] as const;

export async function discoverLspServer(
  options: LspServerDiscoveryOptions,
): Promise<LspServerDiscoveryResult> {
  for (const configured of options.configuredServers ?? []) {
    const executable = await resolveExecutable(configured.command, options.pathEnv);
    if (executable) {
      return {
        config: { ...configured, command: executable },
        source: "configured",
        reason: `使用显式配置的 LSP server: ${configured.id}`,
      };
    }
  }

  const entries = new Set(await safeDirectoryEntries(options.rootDir));
  for (const known of KNOWN_SERVERS) {
    if (!known.markers.some((marker) => entries.has(marker))) continue;
    const executable = await resolveExecutable(known.command, options.pathEnv);
    if (!executable) continue;
    return {
      config: {
        id: known.command,
        command: executable,
        args: known.args,
        languages: known.languages,
      },
      source: "path",
      reason: `从 PATH 发现 LSP server: ${known.command}`,
    };
  }

  return {
    source: "none",
    reason: "未发现可用 LSP server，已降级为 Repo Map 静态代码理解",
  };
}

async function resolveExecutable(
  command: string,
  pathEnv = process.env.PATH ?? "",
): Promise<string | undefined> {
  if (command.includes(path.sep) || path.isAbsolute(command)) {
    return (await isExecutable(command)) ? path.resolve(command) : undefined;
  }
  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) return candidate;
    if (process.platform === "win32" && (await isExecutable(`${candidate}.cmd`))) {
      return `${candidate}.cmd`;
    }
  }
  return undefined;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeDirectoryEntries(rootDir: string): Promise<string[]> {
  try {
    return await readdir(rootDir);
  } catch {
    return [];
  }
}
