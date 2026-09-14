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

/**
 * 为自动启动的工具子进程构建最小环境。
 * API key、云凭据等变量默认不会继承；调用方必须显式授权例外。
 */
export function buildMinimalChildProcessEnv(
  explicitEnv: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && shouldInheritEnvironmentVariable(name)) childEnv[name] = value;
  }
  for (const [name, value] of Object.entries(explicitEnv)) {
    setExplicitEnvironmentVariable(childEnv, name, value);
  }
  return childEnv;
}

function shouldInheritEnvironmentVariable(name: string): boolean {
  const normalized = process.platform === "win32" ? name.toUpperCase() : name;
  return (
    PORTABLE_ENV_NAMES.has(normalized) ||
    normalized.startsWith("LC_") ||
    (process.platform === "win32" && WINDOWS_ENV_NAMES.has(normalized))
  );
}

function setExplicitEnvironmentVariable(
  childEnv: NodeJS.ProcessEnv,
  name: string,
  value: string,
): void {
  if (process.platform === "win32") {
    const normalized = name.toUpperCase();
    const duplicate = Object.keys(childEnv).find((key) => key.toUpperCase() === normalized);
    if (duplicate !== undefined && duplicate !== name) delete childEnv[duplicate];
  }
  childEnv[name] = value;
}
