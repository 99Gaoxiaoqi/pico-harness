import { accessSync, constants, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import type { SandboxPolicy } from "./types.js";

const CACHE_ENV_NAMES = [
  "XDG_CACHE_HOME",
  "npm_config_cache",
  "YARN_CACHE_FOLDER",
  "PIP_CACHE_DIR",
] as const;

export function buildSandboxEnvironment(
  base: NodeJS.ProcessEnv,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (policy.profile === "danger-full-access") return { ...base };

  const home = resolve(policy.scratchRoot, "home");
  const temp = resolve(policy.scratchRoot, "tmp");
  const cache = resolve(policy.scratchRoot, "cache");
  for (const path of [policy.scratchRoot, home, temp, cache]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
  };
  if (platform !== "win32") env.OPENSSL_CONF = "/dev/null";
  if (platform === "win32") {
    env.USERPROFILE = home;
    env.LOCALAPPDATA = resolve(home, "AppData", "Local");
    env.APPDATA = resolve(home, "AppData", "Roaming");
    mkdirSync(env.LOCALAPPDATA, { recursive: true });
    mkdirSync(env.APPDATA, { recursive: true });
  }
  for (const name of CACHE_ENV_NAMES) env[name] = cache;
  return env;
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
  const cellarMatch = normalized.match(/^(.*)\/Cellar\/[^/]+\/[^/]+(?:\/|$)/u);
  const cellar = normalized.match(/^(.*\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/u)?.[1];
  if (cellar && cellarMatch?.[1]) {
    const opt = canonicalize(`${cellarMatch[1]}/opt`);
    let linkedDependencies: string[] = [];
    try {
      linkedDependencies = readdirSync(opt).map((entry) => canonicalize(resolve(opt, entry)));
    } catch {
      // Homebrew opt 不存在时仅保留已解析的主工具链根。
    }
    return [canonicalize(cellar), opt, ...linkedDependencies];
  }
  const nix = normalized.match(/^(\/nix\/store\/[^/]+)(?:\/|$)/u)?.[1];
  if (nix) return [canonicalize(nix)];
  return [canonicalize(dirname(canonical))];
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
  for (const directory of (env.PATH ?? "").split(delimiter)) {
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
