import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "node:net";
import {
  createRuntimeRequest,
  encodeRuntimeFrame,
  isJsonObject,
  RuntimeFrameDecoder,
} from "./protocol.js";
import type { LocalDaemonEndpoint } from "./endpoint.js";

const LOCK_MODE = 0o700;
const OWNER_MODE = 0o600;

export class LocalDaemonAlreadyRunningError extends Error {
  constructor(message = "当前用户的 Pico Runtime daemon 已在运行") {
    super(message);
    this.name = "LocalDaemonAlreadyRunningError";
  }
}

export interface LocalDaemonInstanceLockOptions {
  endpoint: LocalDaemonEndpoint;
  lockPath?: string;
  pid?: number;
  ping?: (endpoint: LocalDaemonEndpoint) => Promise<boolean>;
  isProcessAlive?: (pid: number) => boolean;
}

interface LockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAt: number;
}

/**
 * Current-user singleton guard. A live socket or live lock owner is never removed.
 * Stale endpoints are cleaned only after this atomic directory lock is acquired.
 */
export class LocalDaemonInstanceLock {
  readonly lockPath: string;
  private released = false;

  private constructor(
    lockPath: string,
    private readonly owner: LockOwner,
  ) {
    this.lockPath = lockPath;
  }

  static async acquire(options: LocalDaemonInstanceLockOptions): Promise<LocalDaemonInstanceLock> {
    const lockPath = options.lockPath ?? resolveLocalDaemonLockPath(options.endpoint);
    const ping = options.ping ?? pingLocalRuntimeDaemon;
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    const owner: LockOwner = {
      version: 1,
      pid: options.pid ?? process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    };

    await mkdir(dirname(lockPath), { recursive: true, mode: LOCK_MODE });
    if (await ping(options.endpoint)) throw new LocalDaemonAlreadyRunningError();

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await mkdir(lockPath, { mode: LOCK_MODE });
        await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          mode: OWNER_MODE,
          flag: "wx",
        });
        const lock = new LocalDaemonInstanceLock(lockPath, owner);
        // Protect users upgrading from a daemon version that predates the lock.
        if (await ping(options.endpoint)) {
          await lock.release();
          throw new LocalDaemonAlreadyRunningError();
        }
        return lock;
      } catch (error) {
        if (error instanceof LocalDaemonAlreadyRunningError) throw error;
        if (!isErrno(error, "EEXIST")) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }

      if (await ping(options.endpoint)) throw new LocalDaemonAlreadyRunningError();
      const current = await readOwner(lockPath);
      if (current && isProcessAlive(current.pid)) {
        throw new LocalDaemonAlreadyRunningError(
          `Pico Runtime daemon 正在启动或运行（PID ${current.pid}）`,
        );
      }
      await rm(lockPath, { recursive: true, force: true });
    }
    throw new LocalDaemonAlreadyRunningError("无法取得 Pico Runtime daemon 单例锁");
  }

  async release(): Promise<void> {
    if (this.released) return;
    const current = await readOwner(this.lockPath);
    if (current?.token === this.owner.token) {
      await rm(this.lockPath, { recursive: true, force: true });
    }
    this.released = true;
  }
}

export function resolveLocalDaemonLockPath(endpoint: LocalDaemonEndpoint): string {
  return endpoint.transport === "unix"
    ? `${endpoint.address}.lock`
    : join(tmpdir(), `pico-runtime-${Buffer.from(endpoint.address).toString("base64url")}.lock`);
}

export async function pingLocalRuntimeDaemon(
  endpoint: LocalDaemonEndpoint,
  timeoutMs = 500,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(endpoint.address);
    const request = createRuntimeRequest("runtime.ping", {});
    const decoder = new RuntimeFrameDecoder();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => socket.write(encodeRuntimeFrame(request)));
    socket.once("error", () => finish(false));
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (message.kind !== "response" || message.requestId !== request.requestId) continue;
          finish(message.ok && isJsonObject(message.result) && message.result.pong === true);
        }
      } catch {
        finish(false);
      }
    });
  });
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (!isLockOwner(value)) return undefined;
    return value;
  } catch (error) {
    if (isErrno(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Partial<LockOwner>;
  return (
    owner.version === 1 &&
    typeof owner.pid === "number" &&
    Number.isSafeInteger(owner.pid) &&
    typeof owner.token === "string" &&
    typeof owner.createdAt === "number"
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
