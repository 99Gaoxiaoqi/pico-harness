import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MAX_MOBILE_MESSAGE_BYTES,
  parseMobileSendMessageBody,
  type MobileProjectId,
  type SessionId,
} from "@pico/protocol";
import type { MobileGatewayApi } from "./service.js";
import { attachMobileRealtimeServer } from "./realtime-server.js";
import type { MobileGatewayRealtimeApi } from "./service.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_TOKEN_BYTES = 32;
const MAX_MOBILE_REQUEST_BODY_BYTES = MAX_MOBILE_MESSAGE_BYTES + 4 * 1024;

export interface MobileGatewayServerOptions {
  readonly api: MobileGatewayApi & Partial<MobileGatewayRealtimeApi>;
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
        const projectId = decodePathSegment(sessionsMatch[1]) as MobileProjectId;
        sendJson(response, 200, { sessions: await options.api.listSessions(projectId) });
      } catch {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
      }
      return;
    }

    const transcriptMatch = /^\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/transcript$/u.exec(
      url.pathname,
    );
    if (request.method === "GET" && transcriptMatch) {
      try {
        const before = singleOptionalQuery(url, "before");
        const projectId = decodePathSegment(transcriptMatch[1]) as MobileProjectId;
        const sessionId = decodePathSegment(transcriptMatch[2]) as SessionId;
        sendJson(response, 200, await options.api.getTranscript(projectId, sessionId, before));
      } catch {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
      }
      return;
    }

    const messagesMatch = /^\/v1\/projects\/([^/]+)\/messages$/u.exec(url.pathname);
    if (request.method === "POST" && messagesMatch && !url.search) {
      try {
        const projectId = decodePathSegment(messagesMatch[1]) as MobileProjectId;
        const body = parseMessageBody(await readJsonBody(request));
        sendJson(response, 200, await options.api.sendMessage(projectId, body));
      } catch (error) {
        const statusCode = mobileGatewayErrorStatus(error);
        sendJson(response, statusCode, {
          error: {
            code:
              statusCode === 400
                ? "INVALID_REQUEST"
                : statusCode === 413
                  ? "TOO_LARGE"
                  : statusCode === 409
                    ? "CONFLICT"
                    : statusCode === 404
                      ? "NOT_FOUND"
                      : "GATEWAY_FAILURE",
            message: statusCode >= 500 ? "Mobile Gateway request failed" : "Request rejected",
          },
        });
      }
      return;
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
  });
  const realtime = attachMobileRealtimeServer({ server, api: options.api, token, host });
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
    await realtime.close();
    await closeServer(server);
    throw new Error("Mobile Gateway failed to bind the expected loopback address");
  }

  return {
    origin: `http://${host}:${address.port}`,
    token,
    close: async () => {
      await realtime.close();
      await closeServer(server);
    },
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

function decodePathSegment(value: string | undefined): string {
  const decoded = decodeURIComponent(value ?? "");
  if (!decoded || decoded.length > 256 || decoded.includes("/") || decoded.includes("\\")) {
    throw new Error("Invalid Mobile Gateway path segment");
  }
  return decoded;
}

function singleOptionalQuery(url: URL, name: string): string | undefined {
  const names = [...url.searchParams.keys()];
  if (names.some((entry) => entry !== name) || url.searchParams.getAll(name).length > 1) {
    throw new Error("Invalid Mobile Gateway query");
  }
  const value = url.searchParams.get(name) ?? undefined;
  if (value !== undefined && (!value || value.length > 1024)) {
    throw new Error("Invalid Mobile Gateway query value");
  }
  return value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new MobileGatewayRequestError(400);
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MOBILE_REQUEST_BODY_BYTES) {
    throw new MobileGatewayRequestError(413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MOBILE_REQUEST_BODY_BYTES) throw new MobileGatewayRequestError(413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new MobileGatewayRequestError(400);
  }
}

function parseMessageBody(value: unknown) {
  try {
    return parseMobileSendMessageBody(value);
  } catch {
    throw new MobileGatewayRequestError(400);
  }
}

function mobileGatewayErrorStatus(error: unknown): number {
  if (error instanceof MobileGatewayRequestError) return error.statusCode;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "PROJECT_NOT_FOUND" || code === "NOT_FOUND") return 404;
    if (code === "CONFLICT") return 409;
  }
  return 500;
}

class MobileGatewayRequestError extends Error {
  constructor(readonly statusCode: 400 | 413) {
    super("Mobile Gateway request rejected");
  }
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
