import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export interface LocalDaemonEndpoint {
  readonly transport: "pipe" | "unix";
  readonly address: string;
  /** Private bearer-token file used by the versioned IPC authentication handshake. */
  readonly authTokenPath: string;
}

export interface LocalDaemonEndpointOptions {
  runtimeDir?: string;
  platform?: NodeJS.Platform;
  userIdentity?: string;
}

export function resolveLocalDaemonEndpoint(
  options: LocalDaemonEndpointOptions = {},
): LocalDaemonEndpoint {
  const targetPlatform = options.platform ?? platform();
  const identity = options.userIdentity ?? currentUserIdentity();
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if (targetPlatform === "win32") {
    const runtimeDir =
      options.runtimeDir ??
      join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Pico", "runtime");
    return {
      transport: "pipe",
      address: `\\\\.\\pipe\\pico-runtime-${digest}-v1`,
      authTokenPath: join(runtimeDir, `runtime-${digest}-v1.auth`),
    };
  }
  const runtimeDir =
    options.runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `pico-${digest}`);
  return {
    transport: "unix",
    address: join(runtimeDir, "runtime-v1.sock"),
    authTokenPath: join(runtimeDir, "runtime-v1.auth"),
  };
}

/** Prepares a current-user-only POSIX socket parent. No-op for Windows named pipes. */
export async function prepareLocalDaemonEndpoint(endpoint: LocalDaemonEndpoint): Promise<void> {
  if (endpoint.transport !== "unix") return;
  await mkdir(dirname(endpoint.address), { recursive: true, mode: 0o700 });
  await chmod(dirname(endpoint.address), 0o700);
}

export async function secureLocalDaemonEndpoint(endpoint: LocalDaemonEndpoint): Promise<void> {
  if (endpoint.transport === "unix") await chmod(endpoint.address, 0o600);
}

export async function removeLocalDaemonEndpoint(endpoint: LocalDaemonEndpoint): Promise<void> {
  if (endpoint.transport === "unix") await rm(endpoint.address, { force: true });
}

function currentUserIdentity(): string {
  try {
    return `${userInfo().username}:${homedir()}`;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown-user";
  }
}
