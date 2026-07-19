import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MobileProjectId } from "@pico/protocol";
import type { MobileGatewayApi } from "./service.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_TOKEN_BYTES = 32;

export interface MobileGatewayServerOptions {
  readonly api: MobileGatewayApi;
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly requestTimeoutMs?: number;
}

export interface MobileGatewayHandle {
  readonly origin: string;
  readonly token: string;
  close(): Promise<void>;
}

/** Starts the first Mobile Gateway surface: authenticated, loopback-only project discovery. */
export async function startMobileGateway(
  options: MobileGatewayServerOptions,
): Promise<MobileGatewayHandle> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error(`Mobile Gateway must listen on ${LOOPBACK_HOST}`);
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Mobile Gateway port must be an integer between 0 and 65535");
  }
  const token = options.token ?? randomBytes(MIN_TOKEN_BYTES).toString("base64url");
  if (Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES) {
    throw new Error(`Mobile Gateway token must contain at least ${MIN_TOKEN_BYTES} bytes`);
  }

  const server = createServer(async (request, response) => {
    setCommonHeaders(response);
    if (!isAuthorized(request.headers.authorization, token)) {
      sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method === "GET" && url.pathname === "/v1/projects" && !url.search) {
      try {
        sendJson(response, 200, { projects: await options.api.listProjects() });
      } catch {
        sendJson(response, 500, {
          error: { code: "GATEWAY_FAILURE", message: "Mobile Gateway request failed" },
        });
      }
      return;
    }

    const sessionsMatch = /^\/v1\/projects\/([^/]+)\/sessions$/u.exec(url.pathname);
    if (request.method === "GET" && sessionsMatch && !url.search) {
      try {
        const projectId = decodeURIComponent(sessionsMatch[1] ?? "") as MobileProjectId;
        sendJson(response, 200, { sessions: await options.api.listSessions(projectId) });
      } catch {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
      }
      return;
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
  });
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  server.requestTimeout = requirePositiveTimeout(requestTimeoutMs);
  server.headersTimeout = Math.min(server.requestTimeout, 10_000);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || address.address !== host) {
    await closeServer(server);
    throw new Error("Mobile Gateway failed to bind the expected loopback address");
  }

  return {
    origin: `http://${host}:${address.port}`,
    token,
    close: () => closeServer(server),
  };
}

function isAuthorized(header: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const received = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

function requirePositiveTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Mobile Gateway request timeout must be positive");
  }
  return value;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
