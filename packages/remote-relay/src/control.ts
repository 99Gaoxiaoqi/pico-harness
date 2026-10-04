import { createServer, createConnection, type Socket } from "node:net";
import { chmod, open, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  isMissing,
  matches,
  readPrivate,
  RelayError,
  secret,
  digest,
  writePrivate,
} from "./state.js";

interface Registration {
  version: 1;
  pid: number;
  endpoint: string;
  token: string;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code !== "ESRCH";
  }
}
export async function lockHome(home: string): Promise<() => Promise<void>> {
  const path = join(home, "relay.lock");
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
      throw error;
    const prior = await readPrivate<{ pid: number; lease: string }>(path);
    if (!prior || !Number.isSafeInteger(prior.pid) || alive(prior.pid))
      throw new RelayError("ALREADY_RUNNING");
    await unlink(path);
    file = await open(path, "wx", 0o600);
  }
  const lease = secret();
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, lease }));
    await file.sync();
  } finally {
    await file.close();
  }
  return async () => {
    if ((await readPrivate<{ lease: string }>(path))?.lease === lease) await unlink(path);
  };
}
export async function startControl(
  home: string,
  handler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<() => Promise<void>> {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\pico-relay-${createHash("sha256").update(home).digest("hex").slice(0, 20)}`
      : join(home, "admin.sock");
  if (process.platform !== "win32")
    await unlink(endpoint).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  const token = secret(),
    tokenHash = digest(token),
    sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 5000);
    timer.unref();
    socket.once("close", () => {
      sockets.delete(socket);
      clearTimeout(timer);
    });
    socket.on("error", () => undefined);
    let input = Buffer.alloc(0),
      received = false;
    socket.on("data", (chunk: Buffer) => {
      if (received) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      received = true;
      void (async () => {
        try {
          const request = JSON.parse(input.subarray(0, newline).toString("utf8")) as Record<
            string,
            unknown
          >;
          if (
            !request ||
            Array.isArray(request) ||
            typeof request !== "object" ||
            typeof request.token !== "string" ||
            !matches(request.token, tokenHash) ||
            typeof request.method !== "string" ||
            Object.keys(request).some((key) => !["token", "method", "params"].includes(key))
          )
            throw new RelayError("ADMIN_AUTH_FAILED");
          const params = request.params ?? {};
          if (!params || typeof params !== "object" || Array.isArray(params))
            throw new RelayError("INVALID_PARAMS");
          const value = await handler(request.method, params as Record<string, unknown>);
          socket.end(`${JSON.stringify({ ok: true, value })}\n`);
        } catch (error) {
          socket.end(
            `${JSON.stringify({ ok: false, code: error instanceof RelayError ? error.code : "ADMIN_FAILED" })}\n`,
          );
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    await writePrivate(join(home, "admin.json"), { version: 1, pid: process.pid, endpoint, token });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if ((await readPrivate<Registration>(join(home, "admin.json")))?.token === token)
      await unlink(join(home, "admin.json"));
    if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
  };
}
export async function requestRelayControl(
  home: string,
  method: "invite" | "revoke",
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const registration = await readPrivate<Registration>(join(home, "admin.json"));
  if (!registration || registration.version !== 1 || !alive(registration.pid))
    throw new RelayError("NOT_RUNNING");
  return new Promise((resolve, reject) => {
    const socket = createConnection(registration.endpoint);
    let input = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RelayError("ADMIN_TIMEOUT"));
    }, 10_000);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
    socket.on("error", () => reject(new RelayError("ADMIN_UNAVAILABLE")));
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ token: registration.token, method, params })}\n`),
    );
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.length > 4096) {
        socket.destroy();
        reject(new RelayError("ADMIN_RESPONSE_TOO_LARGE"));
        return;
      }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      socket.end();
      try {
        const response = JSON.parse(input.subarray(0, newline).toString("utf8")) as {
          ok: boolean;
          value?: unknown;
          code?: string;
        };
        if (response.ok) resolve(response.value);
        else reject(new RelayError(response.code ?? "ADMIN_FAILED"));
      } catch {
        reject(new RelayError("ADMIN_INVALID_RESPONSE"));
      }
    });
    socket.once("end", () => {
      if (!input.includes(10)) reject(new RelayError("ADMIN_UNAVAILABLE"));
    });
  });
}
