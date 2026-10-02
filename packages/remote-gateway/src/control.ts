import { scheduleUnrefDeadline } from "@pico/runtime/deadline";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { open, unlink } from "node:fs/promises";
import {
  assertSafePath,
  hashSecret,
  isErrno,
  newSecret,
  readPrivateJson,
  secretMatches,
  writePrivateJson,
} from "./state.js";

interface ControlRegistration {
  readonly version: 1;
  readonly pid: number;
  readonly endpoint: string;
  readonly token: string;
}
const MAX_BYTES = 1024 * 1024;
export async function acquireGatewayLock(home: string): Promise<() => Promise<void>> {
  const path = join(home, "gateway.lock");
  await assertSafePath(path);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    const prior = await readPrivateJson<{ pid: number; lease: string }>(path);
    if (!prior || !Number.isSafeInteger(prior.pid) || isAlive(prior.pid))
      throw new Error("该目录已有远程网关或锁状态无法确认", { cause: error });
    await unlink(path);
    handle = await open(path, "wx", 0o600);
  }
  const lease = newSecret();
  await handle.writeFile(JSON.stringify({ pid: process.pid, lease }));
  await handle.sync();
  await handle.close();
  return async () => {
    const current = await readPrivateJson<{ lease: string }>(path);
    if (current?.lease === lease) await unlink(path);
  };
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}
export async function startControlServer(
  home: string,
  handler: (method: string, params: unknown) => Promise<unknown>,
): Promise<{ readonly close: () => Promise<void> }> {
  const suffix = createHash("sha256").update(home).digest("hex").slice(0, 20);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\pico-remote-${suffix}`
      : join(home, "control.sock");
  if (process.platform !== "win32")
    await unlink(endpoint).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  const token = newSecret();
  const tokenHash = hashSecret(token);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const timeout = scheduleUnrefDeadline(() => socket.destroy(), 5_000);
    socket.once("close", () => timeout.cancel());
    let input = Buffer.alloc(0);
    let received = false;
    socket.on("data", (chunk: Buffer) => {
      if (received) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_BYTES) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      received = true;
      void (async () => {
        try {
          const request: unknown = JSON.parse(input.subarray(0, newline).toString("utf8"));
          if (
            !request ||
            typeof request !== "object" ||
            !("token" in request) ||
            typeof request.token !== "string" ||
            !secretMatches(request.token, tokenHash) ||
            !("method" in request) ||
            typeof request.method !== "string"
          )
            throw new Error("本机管理认证失败");
          const value = await handler(
            request.method,
            "params" in request ? request.params : undefined,
          );
          socket.end(`${JSON.stringify({ ok: true, value })}\n`);
        } catch (error) {
          socket.end(
            `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "本机管理失败" })}\n`,
          );
        }
      })();
    });
    socket.on("error", () => undefined);
  });
  await listen(server, endpoint);
  const registrationPath = join(home, "control.json");
  await writePrivateJson(registrationPath, {
    version: 1,
    pid: process.pid,
    endpoint,
    token,
  } satisfies ControlRegistration);
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await readPrivateJson<ControlRegistration>(registrationPath);
      if (current?.token === token) await unlink(registrationPath).catch(() => undefined);
      if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
    },
  };
}
function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
export async function requestGatewayControl(
  home: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const registration = await readPrivateJson<ControlRegistration>(join(home, "control.json"));
  if (!registration || registration.version !== 1 || !isAlive(registration.pid))
    throw new Error("远程网关未运行");
  return new Promise((resolve, reject) => {
    const socket = createConnection(registration.endpoint);
    let input = Buffer.alloc(0);
    const timeout = scheduleUnrefDeadline(() => {
      socket.destroy();
      reject(new Error("本机管理请求超时"));
    }, 10_000);
    socket.once("close", () => timeout.cancel());
    socket.on("error", () => reject(new Error("无法连接远程网关本机管理通道")));
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ token: registration.token, method, params })}\n`),
    );
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_BYTES) {
        socket.destroy();
        reject(new Error("本机管理响应超限"));
        return;
      }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      socket.destroy();
      try {
        const response = JSON.parse(input.subarray(0, newline).toString("utf8")) as {
          ok: boolean;
          value?: unknown;
          error?: string;
        };
        if (response.ok) resolve(response.value);
        else reject(new Error(response.error ?? "本机管理请求失败"));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("end", () => {
      if (!input.includes(10)) reject(new Error("本机管理连接提前关闭"));
    });
  });
}
