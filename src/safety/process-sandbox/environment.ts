import { mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
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
  if (command.includes("/") || command.includes("\\")) roots.add(canonicalize(dirname(command)));
  for (const path of (env.PATH ?? "").split(delimiter)) {
    if (path) roots.add(canonicalize(path));
  }
  return [...roots];
}

function canonicalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
