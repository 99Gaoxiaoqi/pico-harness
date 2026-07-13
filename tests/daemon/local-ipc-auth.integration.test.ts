import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeRequest,
  encodeRuntimeFrame,
  FileIpcAuthTokenStore,
  LocalRuntimeClient,
  LocalRuntimeDaemon,
  resolveLocalDaemonEndpoint,
  RuntimeFrameDecoder,
  type JsonValue,
  type LocalIpcAuthTokenStore,
  type LocalRuntimeService,
  type RuntimeRequest,
} from "../../src/daemon/index.js";

describe("local Runtime IPC authentication integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("requires the versioned token handshake before every daemon method and rotates the token", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "ipc-auth-test-user",
    });
    const service = new CountingPingService();
    const daemon = new LocalRuntimeDaemon({ endpoint, service });

    await daemon.start();
    try {
      if (endpoint.transport === "unix") {
        expect((await stat(endpoint.authTokenPath)).mode & 0o777).toBe(0o600);
      }

      await expect(unauthenticatedPing(endpoint.address)).resolves.toBe(false);
      expect(service.handled).toBe(0);

      const invalidClient = new LocalRuntimeClient(endpoint, {
        authTokenStore: fixedTokenStore("x".repeat(43)),
      });
      await expect(invalidClient.request("runtime.ping", {})).rejects.toThrow(
        "本机 Runtime IPC 认证失败",
      );
      invalidClient.close();
      expect(service.handled).toBe(0);

      const client = new LocalRuntimeClient(endpoint);
      await expect(client.request("runtime.ping", {})).resolves.toEqual({ pong: true });
      client.close();
      expect(service.handled).toBe(1);
    } finally {
      await daemon.stop();
    }

    const staleToken = await new FileIpcAuthTokenStore(endpoint.authTokenPath).read();
    const restarted = new LocalRuntimeDaemon({ endpoint, service });
    await restarted.start();
    try {
      const rotatedToken = await new FileIpcAuthTokenStore(endpoint.authTokenPath).read();
      expect(rotatedToken).not.toBe(staleToken);
      const staleClient = new LocalRuntimeClient(endpoint, {
        authTokenStore: fixedTokenStore(staleToken),
      });
      await expect(staleClient.request("runtime.ping", {})).rejects.toThrow(
        "本机 Runtime IPC 认证失败",
      );
      staleClient.close();
    } finally {
      await restarted.stop();
    }
  });

  it("derives a private Windows token location and fail-closes through the injectable SID ACL guard", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveLocalDaemonEndpoint({
      platform: "win32",
      runtimeDir: join(root, "runtime"),
      userIdentity: "windows-user",
    });
    const protectedPaths: Array<{ path: string; kind: "directory" | "file" }> = [];
    const store = new FileIpcAuthTokenStore(endpoint.authTokenPath, {
      platform: "win32",
      protectWindowsPath: async (path, kind) => {
        protectedPaths.push({ path, kind });
      },
    });

    expect(endpoint.transport).toBe("pipe");
    expect(endpoint.address).toMatch(/^\\\\\.\\pipe\\pico-runtime-[a-f0-9]{16}-v1$/u);
    expect(endpoint.authTokenPath.startsWith(join(root, "runtime"))).toBe(true);
    expect(endpoint.authTokenPath).toMatch(/\.auth$/u);
    const token = await store.rotate();
    await expect(store.read()).resolves.toBe(token);
    expect(protectedPaths).toEqual(
      expect.arrayContaining([
        { path: join(root, "runtime"), kind: "directory" },
        { path: endpoint.authTokenPath, kind: "file" },
      ]),
    );

    const denied = new FileIpcAuthTokenStore(join(root, "denied", "runtime.auth"), {
      platform: "win32",
      protectWindowsPath: async () => {
        throw new Error("ACL denied");
      },
    });
    await expect(denied.rotate()).rejects.toThrow("ACL denied");
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pico-ipc-auth-"));
    cleanup.push(root);
    return root;
  }
});

class CountingPingService implements LocalRuntimeService {
  handled = 0;

  async handle(request: RuntimeRequest): Promise<JsonValue> {
    this.handled += 1;
    if (request.method !== "runtime.ping") throw new Error("unexpected method");
    return { pong: true };
  }

  async replayEvents() {
    return [];
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

function fixedTokenStore(token: string): LocalIpcAuthTokenStore {
  return {
    rotate: async () => token,
    read: async () => token,
  };
}

async function unauthenticatedPing(address: string): Promise<boolean> {
  const socket = await openSocket(address);
  const decoder = new RuntimeFrameDecoder();
  const response = new Promise<boolean>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === "auth_result") resolve(message.ok);
      }
    });
  });
  socket.write(encodeRuntimeFrame(createRuntimeRequest("runtime.ping", {})));
  try {
    return await response;
  } finally {
    socket.destroy();
  }
}

async function openSocket(address: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect(address);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
