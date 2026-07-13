import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname } from "node:path";
import type { LocalDaemonEndpoint } from "./endpoint.js";

const AUTH_TOKEN_BYTES = 32;
const AUTH_DIRECTORY_MODE = 0o700;
const AUTH_FILE_MODE = 0o600;

interface StoredIpcAuthToken {
  version: 1;
  token: string;
  createdAt: number;
}

export interface LocalIpcAuthTokenStore {
  /** Rotates the bearer token before a new daemon starts accepting connections. */
  rotate(): Promise<string>;
  /** Reads and validates the current token without ever including it in an error. */
  read(): Promise<string>;
}

export interface FileIpcAuthTokenStoreOptions {
  platform?: NodeJS.Platform;
  protectWindowsPath?: (path: string, kind: "directory" | "file") => Promise<void>;
}

/**
 * Stores the local IPC token outside the pipe namespace. On Windows Node does not expose a
 * per-pipe SECURITY_DESCRIPTOR, so the token is the application-layer authorization boundary.
 */
export class FileIpcAuthTokenStore implements LocalIpcAuthTokenStore {
  private readonly targetPlatform: NodeJS.Platform;
  private readonly protectWindowsPath: (path: string, kind: "directory" | "file") => Promise<void>;

  constructor(
    private readonly tokenPath: string,
    options: FileIpcAuthTokenStoreOptions = {},
  ) {
    this.targetPlatform = options.platform ?? platform();
    this.protectWindowsPath = options.protectWindowsPath ?? protectWindowsPathForCurrentUser;
  }

  async rotate(): Promise<string> {
    const directory = dirname(this.tokenPath);
    await mkdir(directory, { recursive: true, mode: AUTH_DIRECTORY_MODE });
    await this.protectDirectory(directory);

    const value: StoredIpcAuthToken = {
      version: 1,
      token: randomBytes(AUTH_TOKEN_BYTES).toString("base64url"),
      createdAt: Date.now(),
    };
    const temporaryPath = `${this.tokenPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: AUTH_FILE_MODE,
        flag: "wx",
      });
      await this.protectFile(temporaryPath);
      // Windows rename cannot replace an existing file. Rotation happens while the daemon owns
      // the singleton lock and before it listens, so a short no-token interval is fail-closed.
      await rm(this.tokenPath, { force: true });
      await rename(temporaryPath, this.tokenPath);
      await this.protectFile(this.tokenPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return value.token;
  }

  async read(): Promise<string> {
    try {
      const directory = dirname(this.tokenPath);
      await this.protectDirectory(directory);
      await this.protectFile(this.tokenPath);
      const parsed: unknown = JSON.parse(await readFile(this.tokenPath, "utf8"));
      if (!isStoredToken(parsed)) throw new Error("invalid auth material");
      return parsed.token;
    } catch {
      throw new Error("本机 Runtime IPC 认证材料不可用");
    }
  }

  private async protectDirectory(path: string): Promise<void> {
    if (this.targetPlatform === "win32") {
      await this.protectWindowsPath(path, "directory");
      return;
    }
    await chmod(path, AUTH_DIRECTORY_MODE);
    await assertNoGroupOrWorldAccess(path, "认证目录");
  }

  private async protectFile(path: string): Promise<void> {
    if (this.targetPlatform === "win32") {
      await this.protectWindowsPath(path, "file");
      return;
    }
    await chmod(path, AUTH_FILE_MODE);
    await assertNoGroupOrWorldAccess(path, "认证文件");
  }
}

export function createLocalIpcAuthTokenStore(
  endpoint: LocalDaemonEndpoint,
): LocalIpcAuthTokenStore {
  return new FileIpcAuthTokenStore(endpoint.authTokenPath);
}

async function assertNoGroupOrWorldAccess(path: string, label: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`本机 Runtime IPC ${label}权限不安全`);
}

/**
 * Uses only inbox Windows utilities and argv-based spawning (never a shell). Node's net API only
 * exposes readableAll/writableAll toggles and cannot supply the logon-SID DACL recommended by
 * Microsoft for named pipes. The protected token is therefore defense in depth, not a claim that
 * the named pipe object itself has an explicit per-user DACL.
 */
async function protectWindowsPathForCurrentUser(
  path: string,
  kind: "directory" | "file",
): Promise<void> {
  const identity = await runWindowsUtility("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = identity.match(/"(S-\d+(?:-\d+)+)"/u)?.[1];
  if (!sid) throw new Error("无法确定当前 Windows 用户 SID，IPC 认证已拒绝");
  const permission = kind === "directory" ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  await runWindowsUtility("icacls.exe", [path, "/inheritance:r", "/grant:r", permission]);
}

async function runWindowsUtility(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("保护本机 Runtime IPC 认证材料超时"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", () => finish(new Error("无法保护本机 Runtime IPC 认证材料")));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error("无法保护本机 Runtime IPC 认证材料"));
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function isStoredToken(value: unknown): value is StoredIpcAuthToken {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Partial<StoredIpcAuthToken>;
  return (
    stored.version === 1 &&
    typeof stored.token === "string" &&
    stored.token.length >= 43 &&
    typeof stored.createdAt === "number" &&
    Number.isFinite(stored.createdAt)
  );
}
