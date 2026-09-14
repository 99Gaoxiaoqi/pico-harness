import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolCall } from "@pico/core";
import { bashCommandFromArgs, extractBashWritePaths } from "./bash-paths.js";
import { isSensitiveCredentialPath } from "./sensitive-path-policy.js";

export type PermissionAccess = "read" | "edit";

/** Claude Code 风格的 session permission update；不保存完整工具参数 JSON。 */
export type PermissionSessionScope =
  | { type: "network" }
  | { type: "all-edits" }
  | {
      type: "directories";
      directories: readonly string[];
      access: PermissionAccess;
      enableAutoEdits: boolean;
    }
  | { type: "file"; path: string; access: PermissionAccess; safety?: boolean }
  | { type: "bash-command"; command: string; match: "prefix" | "exact"; safety?: boolean }
  | { type: "tool"; toolName: string };

/** 运行时只需要的工作区路径授权能力；宿主可用自己的 WorkspaceRoots 实现。 */
export interface PermissionWorkspaceRoots {
  resolveUnchecked(path: string): string;
  isAllowedPath(path: string, access: "read" | "write"): boolean;
}

/** 将 session/workspace 标识投影为进程内授权存储键的宿主策略。 */
export type PermissionSessionKey = (
  sessionId: string,
  workDir: string,
  picoHome?: string,
) => string;

/**
 * 仅保存结构化且进程内有效的会话授权。持久化和 workspace 归一化属于宿主职责。
 */
export class SessionPermissionGrants {
  private readonly bySession = new Map<
    string,
    { sessionId: string; scopes: PermissionSessionScope[] }
  >();
  /** Session-wide process-network expansion, mirroring a managed ExecutionBoundary grant. */
  private readonly networkBySession = new Map<string, string>();
  private readonly oneShotNetworkBySession = new Map<
    string,
    { sessionId: string; calls: Set<string> }
  >();

  constructor(private readonly sessionKey: PermissionSessionKey = defaultPermissionSessionKey) {}

  allows(
    sessionId: string,
    call: ToolCall,
    workDir: string,
    workspaceRoots?: PermissionWorkspaceRoots,
    picoHome?: string,
  ): boolean {
    return (this.bySession.get(this.key(sessionId, workDir, picoHome))?.scopes ?? []).some(
      (scope) => scopeAllowsCall(scope, call, workDir, workspaceRoots),
    );
  }

  allowsSafetyOverride(
    sessionId: string,
    call: ToolCall,
    workDir: string,
    workspaceRoots?: PermissionWorkspaceRoots,
    picoHome?: string,
  ): boolean {
    return (this.bySession.get(this.key(sessionId, workDir, picoHome))?.scopes ?? []).some(
      (scope) =>
        (scope.type === "file" || scope.type === "bash-command") &&
        scope.safety === true &&
        scopeAllowsCall(scope, call, workDir, workspaceRoots),
    );
  }

  add(sessionId: string, workDir: string, scope: PermissionSessionScope, picoHome?: string): void {
    const key = this.key(sessionId, workDir, picoHome);
    const current = this.bySession.get(key)?.scopes ?? [];
    if (current.some((item) => scopeKey(item) === scopeKey(scope))) return;
    this.bySession.set(key, { sessionId, scopes: [...current, cloneScope(scope)] });
  }

  allowsNetwork(sessionId: string, workDir: string, picoHome?: string): boolean {
    return this.networkBySession.has(this.key(sessionId, workDir, picoHome));
  }

  addNetwork(sessionId: string, workDir: string, picoHome?: string): void {
    this.networkBySession.set(this.key(sessionId, workDir, picoHome), sessionId);
  }

  authorizeNetworkOnce(
    sessionId: string,
    workDir: string,
    toolCallId: string,
    picoHome?: string,
  ): void {
    const key = this.key(sessionId, workDir, picoHome);
    const entry = this.oneShotNetworkBySession.get(key) ?? { sessionId, calls: new Set<string>() };
    entry.calls.add(toolCallId);
    this.oneShotNetworkBySession.set(key, entry);
  }

  consumeNetworkAuthorization(
    sessionId: string,
    workDir: string,
    toolCallId: string | undefined,
    picoHome?: string,
  ): boolean {
    const key = this.key(sessionId, workDir, picoHome);
    if (this.networkBySession.has(key)) return true;
    if (!toolCallId) return false;
    const entry = this.oneShotNetworkBySession.get(key);
    if (!entry?.calls.delete(toolCallId)) return false;
    if (entry.calls.size === 0) this.oneShotNetworkBySession.delete(key);
    return true;
  }

  clear(sessionId?: string, workDir?: string, picoHome?: string): void {
    if (sessionId === undefined) {
      this.bySession.clear();
      this.networkBySession.clear();
      this.oneShotNetworkBySession.clear();
      return;
    }
    if (workDir !== undefined) {
      const key = this.key(sessionId, workDir, picoHome);
      this.bySession.delete(key);
      this.networkBySession.delete(key);
      this.oneShotNetworkBySession.delete(key);
      return;
    }
    for (const [key, entry] of this.bySession) {
      if (entry.sessionId === sessionId) this.bySession.delete(key);
    }
    for (const [key, entrySessionId] of this.networkBySession) {
      if (entrySessionId === sessionId) this.networkBySession.delete(key);
    }
    for (const [key, entry] of this.oneShotNetworkBySession) {
      if (entry.sessionId === sessionId) this.oneShotNetworkBySession.delete(key);
    }
  }

  private key(sessionId: string, workDir: string, picoHome?: string): string {
    return this.sessionKey(sessionId, workDir, picoHome);
  }
}

export function permissionScopeForCall(
  call: ToolCall,
  options: {
    externalDirectories?: readonly string[];
    safetyPath?: string;
    autoEditsAlreadyEnabled?: boolean;
  } = {},
): PermissionSessionScope {
  const access =
    call.name === "read_file" || call.name === "glob" || call.name === "grep" ? "read" : "edit";
  if (options.externalDirectories && options.externalDirectories.length > 0) {
    return {
      type: "directories",
      directories: [...new Set(options.externalDirectories)],
      access,
      enableAutoEdits: access === "edit" && options.autoEditsAlreadyEnabled !== true,
    };
  }
  if (options.safetyPath) {
    return call.name === "bash"
      ? { ...bashSessionScope(bashCommandFromArgs(call.arguments) ?? ""), safety: true }
      : { type: "file", path: resolve(options.safetyPath), access, safety: true };
  }
  if (call.name === "write_file" || call.name === "edit_file") return { type: "all-edits" };
  if (call.name === "bash") return bashSessionScope(bashCommandFromArgs(call.arguments) ?? "");
  return { type: "tool", toolName: call.name };
}

/** 非 `full-access` 模式下必须显式确认的文件安全路径。 */
export function bypassImmuneSafetyPath(
  call: Pick<ToolCall, "name" | "arguments">,
  workDir: string,
  workspaceRoots?: PermissionWorkspaceRoots,
): string | undefined {
  const readAccess = call.name === "read_file" || call.name === "grep";
  const paths =
    call.name === "bash"
      ? extractBashWritePaths(bashCommandFromArgs(call.arguments) ?? "")
      : call.name === "read_file" ||
          call.name === "grep" ||
          call.name === "write_file" ||
          call.name === "edit_file"
        ? [filePathFromCall(call)].filter((path): path is string => path !== undefined)
        : [];
  return paths
    .map((path) => workspaceRoots?.resolveUnchecked(path) ?? resolve(workDir, path))
    .find((path) => {
      const insideAuthorizedWorkspace = workspaceRoots
        ? workspaceRoots.isAllowedPath(path, readAccess ? "read" : "write")
        : isWithinDirectory(resolve(workDir), path);
      if (insideAuthorizedWorkspace) return false;
      return isSensitiveCredentialPath(path) || (!readAccess && isControlPlaneSafetyPath(path));
    });
}

export function formatPermissionSessionScope(scope: PermissionSessionScope): string {
  switch (scope.type) {
    case "network":
      return "Yes, allow network access during this session";
    case "all-edits":
      return "Yes, allow all edits during this session";
    case "directories": {
      const label =
        scope.directories.length === 1
          ? `${scope.directories[0]!.split(/[\\/]/u).at(-1) ?? scope.directories[0]}/`
          : `${scope.directories.length} directories`;
      return scope.access === "read"
        ? `Yes, allow reading from ${label} during this session`
        : `Yes, allow all edits in ${label} during this session`;
    }
    case "file":
      return "Yes, allow this file during this session";
    case "bash-command":
      return scope.match === "prefix"
        ? `Yes, allow ${scope.command}:* during this session`
        : "Yes, allow this command during this session";
    case "tool":
      return `Yes, allow ${scope.toolName} during this session`;
  }
}

function defaultPermissionSessionKey(sessionId: string, workDir: string): string {
  return JSON.stringify([resolve(workDir), sessionId]);
}

function isControlPlaneSafetyPath(absolutePath: string): boolean {
  const normalized = absolutePath.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return (
    /(?:^|\/)\.(?:git|claude|vscode|pico)(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)\.claw\/(?:settings(?:\.[^/]*)?\.json|mcp\.json|agents\.ya?ml|skills(?:\/|$))/iu.test(
      normalized,
    ) ||
    /^AGENTS\.md$/iu.test(basename)
  );
}

function scopeAllowsCall(
  scope: PermissionSessionScope,
  call: ToolCall,
  workDir: string,
  workspaceRoots?: PermissionWorkspaceRoots,
): boolean {
  if (scope.type === "network") return false;
  if (scope.type === "all-edits") return call.name === "write_file" || call.name === "edit_file";
  if (scope.type === "tool") return call.name === scope.toolName;
  if (scope.type === "bash-command") {
    if (call.name !== "bash") return false;
    if (bashBackgroundFromArgs(call.arguments)) return false;
    const rawCommand = (bashCommandFromArgs(call.arguments) ?? "").trim();
    if (scope.match === "exact") return rawCommand === scope.command;
    if (!isSingleSimpleShellCommand(rawCommand)) return false;
    const normalized = normalizeCommand(rawCommand);
    return normalized === scope.command || normalized.startsWith(`${scope.command} `);
  }

  const path = filePathFromCall(call);
  if (!path) return false;
  const absolutePath = workspaceRoots?.resolveUnchecked(path) ?? resolve(workDir, path);
  if (scope.type === "file") {
    return absolutePath === scope.path && accessMatches(scope.access, call);
  }
  return (
    scope.directories.some((directory) => isWithinDirectory(directory, absolutePath)) &&
    accessMatches(scope.access, call)
  );
}

function bashBackgroundFromArgs(args: string): boolean {
  try {
    return (JSON.parse(args) as { background?: unknown }).background === true;
  } catch {
    return false;
  }
}

function accessMatches(access: PermissionAccess, call: ToolCall): boolean {
  if (access === "edit") return call.name === "write_file" || call.name === "edit_file";
  return call.name === "read_file" || call.name === "glob" || call.name === "grep";
}

function filePathFromCall(call: Pick<ToolCall, "arguments">): string | undefined {
  try {
    const input = JSON.parse(call.arguments) as { path?: unknown };
    return typeof input.path === "string" ? input.path : undefined;
  } catch {
    return undefined;
  }
}

function isWithinDirectory(directory: string, path: string): boolean {
  const rel = relative(resolve(directory), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ");
}

function scopeKey(scope: PermissionSessionScope): string {
  switch (scope.type) {
    case "network":
      return scope.type;
    case "all-edits":
      return scope.type;
    case "directories":
      return `${scope.type}:${scope.access}:${[...scope.directories].sort().join("|")}`;
    case "file":
      return `${scope.type}:${scope.access}:${scope.safety === true ? "safety:" : ""}${scope.path}`;
    case "bash-command":
      return `${scope.type}:${scope.match}:${scope.safety === true ? "safety:" : ""}${scope.command}`;
    case "tool":
      return `${scope.type}:${scope.toolName}`;
  }
}

function cloneScope(scope: PermissionSessionScope): PermissionSessionScope {
  return scope.type === "directories"
    ? { ...scope, directories: [...scope.directories] }
    : { ...scope };
}

function bashSessionScope(
  command: string,
): Extract<PermissionSessionScope, { type: "bash-command" }> {
  const rawCommand = command.trim();
  if (!isSingleSimpleShellCommand(rawCommand)) {
    return { type: "bash-command", command: rawCommand, match: "exact" };
  }
  const normalized = normalizeCommand(rawCommand);
  const firstSegment = normalized.split(/&&|\|\||;|\n/u, 1)[0] ?? normalized;
  const tokens = [...firstSegment.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  const executableIndex = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
  const executable = tokens[executableIndex]?.split(/[\\/]/u).at(-1);
  const subcommand = tokens.slice(executableIndex + 1).find((token) => !token.startsWith("-"));
  if (executable && subcommand && SAFE_PREFIX_COMMANDS.has(executable)) {
    return { type: "bash-command", command: `${executable} ${subcommand}`, match: "prefix" };
  }
  return { type: "bash-command", command: rawCommand, match: "exact" };
}

/** Prefix grant 只能覆盖单个静态 shell 命令，不得吸收后续链、重定向或命令替换。 */
function isSingleSimpleShellCommand(command: string): boolean {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char === "`" || (char === "$" && (next === "(" || next === "{"))) return false;
      if (char === "\\") index++;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (
      char === "`" ||
      char === "\\" ||
      char === ";" ||
      char === "\n" ||
      char === "|" ||
      char === "&" ||
      char === ">" ||
      char === "<" ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === "}" ||
      (char === "$" && (next === "(" || next === "{"))
    ) {
      return false;
    }
  }
  return quote === undefined && command.length > 0;
}

const SAFE_PREFIX_COMMANDS = new Set([
  "bun",
  "cargo",
  "docker",
  "go",
  "gradle",
  "mvn",
  "npm",
  "pnpm",
  "pytest",
  "yarn",
]);
