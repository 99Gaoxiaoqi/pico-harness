import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  createRuntimeAuthRequest,
  createRuntimeRequest,
  encodeRuntimeFrame,
  RuntimeFrameDecoder,
  type RuntimeEvent,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResponse,
  type RuntimeResult,
} from "@pico/protocol";

const CONNECT_TIMEOUT_MS = 5_000;

export class RuntimeClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeClientError";
  }
}

export interface RuntimeClientAdapter {
  request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>>;
  subscribe(
    params: RuntimeParams<"events.subscribe">,
    listener: (event: RuntimeEvent) => void,
  ): Promise<{
    readonly replay: RuntimeResult<"events.subscribe">;
    readonly dispose: () => void;
  }>;
  close(): void;
}

interface DaemonEndpoint {
  readonly address: string;
  readonly authTokenPath: string;
}

interface StoredToken {
  readonly version: 1;
  readonly token: string;
}

export class LocalDaemonRuntimeClientAdapter implements RuntimeClientAdapter {
  private socket: Socket | undefined;
  private decoder = new RuntimeFrameDecoder();
  private readonly pending = new Map<
    string,
    { resolve: (response: RuntimeResponse) => void; reject: (error: RuntimeClientError) => void }
  >();
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private connecting: Promise<void> | undefined;
  private authentication:
    | { resolve: () => void; reject: (error: RuntimeClientError) => void }
    | undefined;

  constructor(private readonly endpoint: DaemonEndpoint = resolveDaemonEndpoint()) {}

  async request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>> {
    await this.ensureConnected();
    const request = createRuntimeRequest(method, params);
    const response = await new Promise<RuntimeResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
      this.socket?.write(encodeRuntimeFrame(request));
    });
    if (!response.ok) {
      throw new RuntimeClientError(response.error.code, response.error.message, false);
    }
    // The protocol package validates the response envelope. Method/result correlation is preserved
    // by requestId and by the generic request factory, so this is the transport boundary cast.
    return response.result as RuntimeResult<Method>;
  }

  async subscribe(
    params: RuntimeParams<"events.subscribe">,
    listener: (event: RuntimeEvent) => void,
  ): Promise<{
    readonly replay: RuntimeResult<"events.subscribe">;
    readonly dispose: () => void;
  }> {
    this.eventListeners.add(listener);
    try {
      const replay = await this.request("events.subscribe", params);
      return {
        replay,
        dispose: () => this.eventListeners.delete(listener),
      };
    } catch (error) {
      this.eventListeners.delete(listener);
      throw error;
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.eventListeners.clear();
    this.rejectAll(
      new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true),
    );
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.connectAuthenticated().finally(() => {
        this.connecting = undefined;
      });
    }
    return await this.connecting;
  }

  private async connectAuthenticated(): Promise<void> {
    const token = await readAuthToken(this.endpoint.authTokenPath);
    this.decoder = new RuntimeFrameDecoder();
    const socket = await connectWithTimeout(this.endpoint.address);
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.once("error", (error) => this.handleDisconnect(toUnavailableError(error)));
    socket.once("close", () =>
      this.handleDisconnect(
        new RuntimeClientError("RUNTIME_DISCONNECTED", "本机 Runtime daemon 连接已断开", true),
      ),
    );
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          this.authentication = { resolve, reject };
          socket.write(encodeRuntimeFrame(createRuntimeAuthRequest(token)));
        }),
        CONNECT_TIMEOUT_MS,
        "本机 Runtime IPC 认证超时",
      );
    } catch (error) {
      socket.destroy();
      this.socket = undefined;
      throw normalizeClientError(error);
    }
  }

  private handleData(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        if (message.kind === "auth_result") {
          const authentication = this.authentication;
          this.authentication = undefined;
          if (!authentication) continue;
          if (message.ok) authentication.resolve();
          else
            authentication.reject(
              new RuntimeClientError(
                "RUNTIME_AUTH_FAILED",
                "本机 Runtime IPC 认证失败",
                false,
              ),
            );
        } else if (message.kind === "event") {
          for (const listener of this.eventListeners) listener(message.event);
        } else if (message.kind === "response") {
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          this.pending.delete(message.requestId);
          pending.resolve(message);
        }
      }
    } catch (error) {
      this.handleDisconnect(normalizeClientError(error));
      this.socket?.destroy();
    }
  }

  private handleDisconnect(error: RuntimeClientError): void {
    this.socket = undefined;
    this.rejectAll(error);
  }

  private rejectAll(error: RuntimeClientError): void {
    this.authentication?.reject(error);
    this.authentication = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function resolveDaemonEndpoint(
  targetPlatform: NodeJS.Platform = platform(),
): DaemonEndpoint {
  const identity = currentUserIdentity();
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if (targetPlatform === "win32") {
    const runtimeDir = join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Pico",
      "runtime",
    );
    return {
      address: `\\\\.\\pipe\\pico-runtime-${digest}-v1`,
      authTokenPath: join(runtimeDir, `runtime-${digest}-v1.auth`),
    };
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `pico-${digest}`);
  return {
    address: join(runtimeDir, "runtime-v1.sock"),
    authTokenPath: join(runtimeDir, "runtime-v1.auth"),
  };
}

async function readAuthToken(path: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isStoredToken(parsed)) throw new Error("invalid auth material");
    return parsed.token;
  } catch (error) {
    throw new RuntimeClientError(
      "RUNTIME_UNAVAILABLE",
      "本机 Runtime daemon 未运行或认证材料不可用",
      true,
      { cause: error },
    );
  }
}

async function connectWithTimeout(address: string): Promise<Socket> {
  try {
    return await new Promise<Socket>((resolve, reject) => {
      const socket = connect(address);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(
          new RuntimeClientError(
            "RUNTIME_TIMEOUT",
            "连接本机 Runtime daemon 超时",
            true,
          ),
        );
      }, CONNECT_TIMEOUT_MS);
      const onError = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.off("error", onError);
        resolve(socket);
      });
    });
  } catch (error) {
    throw toUnavailableError(error);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new RuntimeClientError("RUNTIME_TIMEOUT", message, true)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredToken>;
  return (
    candidate.version === 1 &&
    typeof candidate.token === "string" &&
    candidate.token.length >= 43
  );
}

function currentUserIdentity(): string {
  try {
    return `${userInfo().username}:${homedir()}`;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown-user";
  }
}

function normalizeClientError(error: unknown): RuntimeClientError {
  if (error instanceof RuntimeClientError) return error;
  return new RuntimeClientError(
    "RUNTIME_PROTOCOL_ERROR",
    error instanceof Error ? error.message : "本机 Runtime IPC 发生未知错误",
    false,
    error instanceof Error ? { cause: error } : undefined,
  );
}

function toUnavailableError(error: unknown): RuntimeClientError {
  return new RuntimeClientError(
    "RUNTIME_UNAVAILABLE",
    "无法连接本机 Runtime daemon",
    true,
    error instanceof Error ? { cause: error } : undefined,
  );
}
