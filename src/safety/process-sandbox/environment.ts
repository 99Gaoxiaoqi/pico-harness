import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import type { SandboxPolicy } from "./types.js";

export const WINDOWS_RESTRICTED_NODE_OPTIONS = "--preserve-symlinks --preserve-symlinks-main";

const CACHE_ENV_NAMES = [
  "XDG_CACHE_HOME",
  "npm_config_cache",
  "YARN_CACHE_FOLDER",
  "PIP_CACHE_DIR",
] as const;

const PORTABLE_ENV_NAMES = new Set([
  "HOME",
  "LANG",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

const WINDOWS_ENV_NAMES = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

const BLOCKED_RESTRICTED_ENV_NAMES = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "BASH_XTRACEFD",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
  "ZDOTDIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LIBPATH",
  "SHLIB_PATH",
  "LDR_PRELOAD",
  "LDR_PRELOAD64",
  "OPENSSL_CONF",
  "OPENSSL_CONF_INCLUDE",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "RUBYOPT",
  "RUBYLIB",
  "RUBYGEMS_GEMDEPS",
  "GEM_HOME",
  "GEM_PATH",
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "LOCPATH",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
]);

export function buildSandboxEnvironment(
  base: NodeJS.ProcessEnv,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
  explicitEnvKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  if (policy.profile === "danger-full-access") return { ...base };

  const home = resolve(policy.scratchRoot, "home");
  const temp = resolve(policy.scratchRoot, "tmp");
  const cache = resolve(policy.scratchRoot, "cache");
  for (const path of [policy.scratchRoot, home, temp, cache]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && shouldInheritRestrictedEnvironmentName(name, platform)) {
      setEnvironmentVariable(env, name, value, platform);
    }
  }
  for (const requestedName of explicitEnvKeys) {
    if (isBlockedRestrictedEnvironmentName(requestedName)) continue;
    const entry = findEnvironmentEntry(base, requestedName, platform);
    if (entry?.[1] !== undefined) {
      setEnvironmentVariable(env, requestedName, entry[1], platform);
    }
  }
  setEnvironmentVariable(env, "HOME", home, platform);
  setEnvironmentVariable(env, "TMPDIR", temp, platform);
  setEnvironmentVariable(env, "TMP", temp, platform);
  setEnvironmentVariable(env, "TEMP", temp, platform);
  if (platform !== "win32") env.OPENSSL_CONF = "/dev/null";
  if (platform === "win32") {
    const localAppData = resolve(home, "AppData", "Local");
    const appData = resolve(home, "AppData", "Roaming");
    setEnvironmentVariable(env, "USERPROFILE", home, platform);
    setEnvironmentVariable(env, "LOCALAPPDATA", localAppData, platform);
    setEnvironmentVariable(env, "APPDATA", appData, platform);
    mkdirSync(localAppData, { recursive: true });
    mkdirSync(appData, { recursive: true });
  }
  for (const name of CACHE_ENV_NAMES) setEnvironmentVariable(env, name, cache, platform);
  return env;
}

function shouldInheritRestrictedEnvironmentName(name: string, platform: NodeJS.Platform): boolean {
  const normalized = name.toUpperCase();
  if (isBlockedRestrictedEnvironmentName(normalized)) return false;
  return (
    PORTABLE_ENV_NAMES.has(normalized) ||
    normalized.startsWith("LC_") ||
    (platform === "win32" && WINDOWS_ENV_NAMES.has(normalized))
  );
}

function isBlockedRestrictedEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return (
    BLOCKED_RESTRICTED_ENV_NAMES.has(normalized) ||
    normalized.startsWith("DYLD_") ||
    normalized.startsWith("LD_") ||
    normalized.startsWith("LDR_") ||
    normalized.startsWith("BASH_FUNC_")
  );
}

function findEnvironmentEntry(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): [string, string | undefined] | undefined {
  if (platform !== "win32") {
    return Object.hasOwn(environment, name) ? [name, environment[name]] : undefined;
  }
  const normalized = name.toUpperCase();
  return Object.entries(environment).find(([key]) => key.toUpperCase() === normalized);
}

function setEnvironmentVariable(
  environment: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    const normalized = name.toUpperCase();
    const duplicate = Object.keys(environment).find((key) => key.toUpperCase() === normalized);
    if (duplicate !== undefined && duplicate !== name) delete environment[duplicate];
  }
  environment[name] = value;
}

export function runtimeReadRoots(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const roots = new Set<string>();
  const standard =
    platform === "darwin"
      ? [
          "/System",
          "/usr",
          "/bin",
          "/sbin",
          "/Library",
          "/private/etc",
          "/private/var/db/dyld",
          "/private/var/select",
        ]
      : platform === "linux"
        ? [
            "/usr",
            "/bin",
            "/sbin",
            "/lib",
            "/lib64",
            "/etc/ld.so.cache",
            "/etc/ld.so.conf",
            "/etc/ld.so.conf.d",
          ]
        : [process.env.SystemRoot, process.env.ProgramFiles].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          );
  for (const path of standard) roots.add(canonicalize(path));
  const executable = resolveTrustedExecutable(command, env, platform);
  if (executable) {
    roots.add(canonicalize(dirname(executable)));
    for (const root of toolchainRoots(executable)) roots.add(root);
  }
  return [...roots];
}

export function shellRuntimeReadRoots(
  shellCommand: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const roots = new Set<string>();
  for (const segment of shellCommand.split(/(?:&&|\|\||[;|\n])/u)) {
    const candidate = segment
      .trim()
      .replace(/^&\s+/u, "")
      .match(/^(?:env\s+)?(?:'([^']+)'|"([^"]+)"|([^\s]+))/u);
    const executable = candidate?.[1] ?? candidate?.[2] ?? candidate?.[3];
    if (!executable || /^(?:if|then|else|fi|for|while|do|done|case|esac)$/u.test(executable)) {
      continue;
    }
    // 模型提供的绝对/相对路径不能成为新增 authority。工作区和显式授权目录已经在
    // SandboxPolicy 中；这里只解析宿主 PATH 中真实存在且可执行的裸命令。
    if (executable.includes("/") || executable.includes("\\")) continue;
    for (const root of runtimeReadRoots(executable, env, platform)) roots.add(root);
  }
  return [...roots];
}

function toolchainRoots(executable: string): string[] {
  const canonical = canonicalize(executable);
  const normalized = canonical.replaceAll("\\", "/");
  const cellar = homebrewFormulaRoot(normalized);
  if (cellar) {
    return [canonicalize(cellar), ...macosLinkedLibraryAccess(canonical).roots];
  }
  const nix = normalized.match(/^(\/nix\/store\/[^/]+)(?:\/|$)/u)?.[1];
  if (nix) return [canonicalize(nix)];
  return [canonicalize(dirname(canonical))];
}

const MACOS_LINKED_LIBRARY_LIMIT = 128;
interface MacosLinkedLibraryAccess {
  readonly roots: readonly string[];
  readonly aliases: readonly string[];
}

const macosLinkedLibraryAccessCache = new Map<string, MacosLinkedLibraryAccess>();

function macosLinkedLibraryAccess(executable: string): MacosLinkedLibraryAccess {
  if (process.platform !== "darwin" || !accessExecutable("/usr/bin/otool")) {
    return { roots: [], aliases: [] };
  }
  const cached = macosLinkedLibraryAccessCache.get(executable);
  if (cached) return cached;

  const roots = new Set<string>();
  const aliases = new Set<string>();
  const inspected = new Set<string>();
  const pending = [executable];
  while (pending.length > 0 && inspected.size < MACOS_LINKED_LIBRARY_LIMIT) {
    const candidate = pending.shift();
    if (!candidate || inspected.has(candidate)) continue;
    inspected.add(candidate);
    const result = spawnSync("/usr/bin/otool", ["-L", candidate], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    if (result.status !== 0 || typeof result.stdout !== "string") continue;
    for (const line of result.stdout.split("\n").slice(1)) {
      const normalizedLine = line.trim();
      const metadataStart = normalizedLine.indexOf(" (");
      const linkedPath = metadataStart > 0 ? normalizedLine.slice(0, metadataStart) : "";
      if (!linkedPath.startsWith("/")) continue;
      const linked = canonicalize(linkedPath);
      const formula = homebrewFormulaRoot(linked.replaceAll("\\", "/"));
      if (!formula) continue;
      const canonicalFormula = canonicalize(formula);
      roots.add(canonicalFormula);
      const alias = homebrewOptFormulaRoot(linkedPath);
      if (alias && canonicalize(alias) === canonicalFormula) aliases.add(alias);
      if (!inspected.has(linked)) pending.push(linked);
    }
  }
  const resolved = { roots: [...roots], aliases: [...aliases] };
  macosLinkedLibraryAccessCache.set(executable, resolved);
  return resolved;
}

function homebrewFormulaRoot(normalizedPath: string): string | undefined {
  return normalizedPath.match(/^(.*\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/u)?.[1];
}

function homebrewOptFormulaRoot(normalizedPath: string): string | undefined {
  return normalizedPath.match(/^(.*\/opt\/[^/]+)(?:\/|$)/u)?.[1];
}

export function runtimeReadAliases(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  readRoots: readonly string[] = [],
): string[] {
  if (platform !== "darwin") return [];
  const aliases = new Set<string>();
  const executable = resolveTrustedExecutable(command, env, platform);
  if (executable) {
    for (const alias of macosLinkedLibraryAccess(canonicalize(executable)).aliases) {
      aliases.add(alias);
    }
  }
  // Shell command 内的子进程依赖已被 shellRuntimeReadRoots 收录为真实
  // Cellar 根；动态加载器仍会按 /opt/<formula> 词法路径访问。只为已授权
  // 且实时指向同一 Cellar 根的单个 formula 补充 alias，不开放整个 opt。
  for (const root of readRoots) {
    const canonicalRoot = canonicalize(root);
    const normalized = canonicalRoot.replaceAll("\\", "/");
    const match = normalized.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+(?:\/|$)/u);
    const formulaRoot = homebrewFormulaRoot(normalized);
    if (!match || !formulaRoot) continue;
    const alias = resolve(match[1]!, "opt", match[2]!);
    if (canonicalize(alias) === canonicalize(formulaRoot)) aliases.add(alias);
  }
  return [...aliases];
}

function accessExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveTrustedExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const pathValue = findEnvironmentEntry(env, "PATH", platform)?.[1] ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // 继续检查其他 PATH 候选。
      }
    }
  }
  return undefined;
}

function canonicalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
