import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join, normalize } from "node:path";
import { resolvePicoHome } from "../paths/pico-paths.js";

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
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  picoHome?: string;
}

export function resolveLocalDaemonEndpoint(
  options: LocalDaemonEndpointOptions = {},
): LocalDaemonEndpoint {
  const targetPlatform = options.platform ?? platform();
  const env = options.env ?? process.env;
  const identity = options.userIdentity ?? currentUserIdentity();
  const picoHome = canonicalPicoHome(
    resolvePicoHome({ env, homeDir: options.homeDir, picoHome: options.picoHome }),
    targetPlatform,
  );
  const namespaceHash = createHash("sha256")
    .update("pico-runtime-v1")
    .update("\0")
    .update(identity)
    .update("\0")
    .update(picoHome)
    .digest();
  const digest = namespaceHash.toString("hex").slice(0, 16);
  const compactDigest = namespaceHash.toString("base64url").slice(0, 11);
  if (targetPlatform === "win32") {
    const runtimeDir =
      options.runtimeDir ??
      join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Pico", "runtime");
    return {
      transport: "pipe",
      address: `\\\\.\\pipe\\pico-runtime-${digest}-v1`,
      authTokenPath: join(runtimeDir, `runtime-${digest}-v1.auth`),
    };
  }
  const configuredRuntimeDir = options.runtimeDir ?? env["XDG_RUNTIME_DIR"];
  const runtimeDir = configuredRuntimeDir ?? join(tmpdir(), `pico-${digest}`);
  // Keep macOS Unix socket paths below the ~104-byte kernel limit. The default directory
  // already carries the full digest; shared/overridden runtime directories use a short suffix.
  // The protocol generation is part of the digest input, so the compact name remains versioned.
  const endpointName = configuredRuntimeDir === undefined ? "runtime-v1" : compactDigest;
  return {
    transport: "unix",
    address: join(runtimeDir, `${endpointName}.sock`),
    authTokenPath: join(runtimeDir, `${endpointName}.auth`),
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

function canonicalPicoHome(picoHome: string, targetPlatform: NodeJS.Platform): string {
  let physical = picoHome;
  try {
    physical = realpathSync.native(picoHome);
  } catch {
    // The directory may not exist before first launch; the normalized absolute path is stable.
  }
  const canonical = normalize(physical).normalize("NFC");
  return targetPlatform === "win32" ? canonical.toLowerCase() : canonical;
}
