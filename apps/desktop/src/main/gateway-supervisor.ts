import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, delimiter, isAbsolute, join, normalize, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  readActiveGatewayRuntime,
  readGatewayServiceState,
  recordGatewayExit,
  type ActiveGatewayRuntime,
} from "@pico/remote-gateway/desktop";

const preservedEnvironment = [
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATHEXT",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "HOMEDRIVE",
  "HOMEPATH",
  "ALLUSERSPROFILE",
  "OS",
  "PROCESSOR_ARCHITECTURE",
];
export function captureGatewayPathEntries(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === "win32" ? win32 : { isAbsolute, normalize };
  const seen = new Set<string>();
  return (source.PATH ?? source.Path ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .flatMap((path) => {
      if (!pathApi.isAbsolute(path) || /[\0\r\n]/u.test(path)) return [];
      const normalized = pathApi.normalize(path);
      const key = platform === "win32" ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) return [];
      seen.add(key);
      return [normalized];
    });
}
export function gatewayProcessEnvironment(
  runtime: ActiveGatewayRuntime,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of preservedEnvironment) if (source[name]) env[name] = source[name];
  const systemRoot = source.SystemRoot ?? source.WINDIR ?? "C:\\Windows";
  const base =
    platform === "win32"
      ? [
          win32.join(systemRoot, "System32"),
          systemRoot,
          win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
        ]
      : [
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
          ...(platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
        ];
  const separator = platform === "win32" ? ";" : delimiter;
  const osPath = captureGatewayPathEntries(source, platform);
  env.PATH = captureGatewayPathEntries(
    { PATH: [...runtime.pathEntries, ...osPath, ...base].join(separator) },
    platform,
  ).join(separator);
  env.PICO_HOME = runtime.runtimeHome;
  env.ELECTRON_RUN_AS_NODE = "1";
  env.PICO_GATEWAY_BUILD_ID = runtime.buildId;
  if (platform === "win32" && runtime.shellPath) env.PICO_SHELL_PATH = runtime.shellPath;
  return env;
}

/** One task-owned foreground child; OS supervision owns restart and never needs a separate Node install. */
export async function runGatewaySupervisor(home: string): Promise<number> {
  for (;;) {
    let state = await readGatewayServiceState(home);
    while (state.desiredRunning && state.maintenance) {
      await delay(Math.min(1_000, Math.max(1, state.maintenance.expiresAt - Date.now())));
      state = await readGatewayServiceState(home);
    }
    if (!state.desiredRunning) return 0;
    const generation = state.generation;
    const runtime = await readActiveGatewayRuntime(home);
    if (!runtime) throw new Error("GATEWAY_INSTALLATION_MISSING");
    await Promise.all([
      access(runtime.executablePath),
      access(runtime.gatewayPath),
      access(join(dirname(runtime.gatewayPath), "daemon.cjs")),
    ]);
    const result = await supervisedChild(home, runtime, generation);
    await recordGatewayExit(home, {
      at: Date.now(),
      code: result.code,
      signal: result.signal,
      buildId: runtime.buildId,
    });
    state = await readGatewayServiceState(home);
    if (!state.desiredRunning) return 0;
    // A newer intent/maintenance generation must read the current manifest before restarting.
    if (!state.maintenance && state.generation === generation && !result.restartRequested) return 1;
  }
}
async function supervisedChild(
  home: string,
  runtime: ActiveGatewayRuntime,
  generation: number,
): Promise<{ code: number | null; signal: string | null; restartRequested: boolean }> {
  const observing = new AbortController();
  let exited = false;
  let terminationAt: number | undefined;
  let restartRequested = false;
  const child = spawn(runtime.executablePath, [runtime.gatewayPath, "--home", home], {
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...gatewayProcessEnvironment(runtime),
      PICO_GATEWAY_SUPERVISION_GENERATION: String(generation),
    },
  });
  const terminate = () => {
    terminationAt ??= Date.now();
    child.kill(Date.now() - terminationAt >= 2_000 ? "SIGKILL" : "SIGTERM");
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  const completed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("close", () => {
        exited = true;
        observing.abort();
        process.off("SIGTERM", terminate);
        process.off("SIGINT", terminate);
      });
    },
  );
  const monitor = (async () => {
    while (!exited) {
      try {
        const current = await readGatewayServiceState(home);
        const generationChanged = current.generation !== generation;
        if (current.maintenance || generationChanged) restartRequested = true;
        if (!current.desiredRunning || current.maintenance || generationChanged) terminate();
      } catch {
        terminate(); /* An unreadable running intent fails closed. */
      }
      if (terminationAt !== undefined) terminate();
      await delay(250, undefined, { signal: observing.signal });
    }
  })().catch((error: unknown) => {
    if (!observing.signal.aborted) {
      terminate();
      throw error;
    }
  });
  try {
    return { ...(await completed), restartRequested };
  } finally {
    observing.abort();
    await monitor.catch(() => undefined);
  }
}
