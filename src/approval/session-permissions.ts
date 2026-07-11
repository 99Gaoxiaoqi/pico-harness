import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolCall } from "../schema/message.js";
import {
  setSessionAdditionalDirectories,
  setSessionMode,
  type InteractionMode,
  type SessionSettings,
} from "../input/session-settings.js";
import type { WorkspaceRoots } from "../tools/workspace-roots.js";
import { bashCommandFromArgs, extractBashWritePaths } from "./bash-paths.js";

export type PermissionAccess = "read" | "edit";

/** Claude Code 风格的 session permission update；不保存完整工具参数 JSON。 */
export type PermissionSessionScope =
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

export class SessionPermissionGrants {
  private readonly bySession = new Map<string, PermissionSessionScope[]>();

  allows(
    sessionId: string,
    call: ToolCall,
    workDir: string,
    workspaceRoots?: WorkspaceRoots,
  ): boolean {
    return (this.bySession.get(sessionId) ?? []).some((scope) =>
      scopeAllowsCall(scope, call, workDir, workspaceRoots),
    );
  }

  allowsSafetyOverride(
    sessionId: string,
    call: ToolCall,
    workDir: string,
    workspaceRoots?: WorkspaceRoots,
  ): boolean {
    return (this.bySession.get(sessionId) ?? []).some(
      (scope) =>
        (scope.type === "file" || scope.type === "bash-command") &&
        scope.safety === true &&
        scopeAllowsCall(scope, call, workDir, workspaceRoots),
    );
  }

  add(sessionId: string, scope: PermissionSessionScope): void {
    const current = this.bySession.get(sessionId) ?? [];
    if (current.some((item) => scopeKey(item) === scopeKey(scope))) return;
    this.bySession.set(sessionId, [...current, cloneScope(scope)]);
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.bySession.clear();
      return;
    }
    this.bySession.delete(sessionId);
  }
}

export const globalSessionPermissionGrants = new SessionPermissionGrants();

export interface PermissionRuntimeSettings {
  mode: InteractionMode;
  additionalDirectories?: readonly string[];
}

export async function applySessionPermissionScope(
  scope: PermissionSessionScope,
  options: {
    sessionId: string;
    settings: PermissionRuntimeSettings;
    workspaceRoots: WorkspaceRoots;
  },
): Promise<void> {
  if (scope.type === "directories") {
    const added: string[] = [];
    for (const directory of scope.directories) {
      const result = await options.workspaceRoots.addDirectory(directory);
      added.push(result.path);
    }
    if (options.settings.additionalDirectories !== undefined) {
      setSessionAdditionalDirectories(options.settings as SessionSettings, [
        ...options.settings.additionalDirectories,
        ...added,
      ]);
    }
    if (scope.enableAutoEdits) setSessionMode(options.settings as SessionSettings, "auto");
  } else if (scope.type === "all-edits") {
    setSessionMode(options.settings as SessionSettings, "auto");
  }
  // all-edits 由权威 mode=auto 表达，directory 由 WorkspaceRoots 表达；
  // 仅无法投影到这两者的规则进入结构化 grant store。
  if (scope.type !== "all-edits" && scope.type !== "directories") {
    globalSessionPermissionGrants.add(options.sessionId, scope);
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
  if (call.name === "bash") {
    return bashSessionScope(bashCommandFromArgs(call.arguments) ?? "");
  }
  return { type: "tool", toolName: call.name };
}

/** 非 YOLO 模式下必须显式确认的文件安全路径。 */
export function bypassImmuneSafetyPath(
  call: Pick<ToolCall, "name" | "arguments">,
  workDir: string,
  workspaceRoots?: WorkspaceRoots,
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
    .find(
      (path) => isSensitiveCredentialPath(path) || (!readAccess && isControlPlaneSafetyPath(path)),
    );
}

/** 可能包含密钥的路径：读写都必须显式授权。 */
export function isSensitiveCredentialPath(absolutePath: string): boolean {
  const normalized = absolutePath.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (
    /(?:^|\/)\.(?:ssh|gnupg|aws|kube|docker|azure)(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)gcloud(?:\/|$)/iu.test(normalized)
  ) {
    return true;
  }
  if (/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/iu.test(basename)) {
    return !/^\.env\.(?:example|sample|template|dist)$/iu.test(basename);
  }
  if (/(?:id_rsa|id_ed25519|id_ecdsa|credentials|\.pem$|\.key$)/iu.test(normalized)) {
    return !/(?:id_rsa|id_ed25519|id_ecdsa)\.pub$/iu.test(normalized);
  }
  return false;
}

/** 能改变 Agent/仓库行为的控制面文件：可读，但写入必须显式授权。 */
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

export function formatPermissionSessionScope(scope: PermissionSessionScope): string {
  switch (scope.type) {
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
      return `Yes, allow this file during this session`;
    case "bash-command":
      return scope.match === "prefix"
        ? `Yes, allow ${scope.command}:* during this session`
        : "Yes, allow this command during this session";
    case "tool":
      return `Yes, allow ${scope.toolName} during this session`;
  }
}

function scopeAllowsCall(
  scope: PermissionSessionScope,
  call: ToolCall,
  workDir: string,
  workspaceRoots?: WorkspaceRoots,
): boolean {
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
  if (scope.type === "file")
    return absolutePath === scope.path && accessMatches(scope.access, call);
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
