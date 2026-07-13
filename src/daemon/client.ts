import { connect, type Socket } from "node:net";
import {
  createRuntimeRequest,
  encodeRuntimeFrame,
  type JsonValue,
  type RuntimeEvent,
  RuntimeFrameDecoder,
  type RuntimeMethod,
  type RuntimeResponse,
  isJsonObject,
} from "./protocol.js";
import type { LocalDaemonEndpoint } from "./endpoint.js";

export class LocalRuntimeClient {
  private socket?: Socket;
  private readonly pending = new Map<
    string,
    { resolve: (response: RuntimeResponse) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly decoder = new RuntimeFrameDecoder();

  constructor(private readonly endpoint: LocalDaemonEndpoint) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(this.endpoint.address);
      candidate.once("connect", () => {
        candidate.off("error", onError);
        resolve(candidate);
      });
      const onError = (error: Error) => reject(error);
      candidate.once("error", onError);
    });
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error) => this.rejectPending(error));
    socket.on("close", () => this.rejectPending(new Error("本机 Runtime daemon 连接已关闭")));
  }

  async request(method: RuntimeMethod, params: JsonValue): Promise<JsonValue> {
    await this.connect();
    const request = createRuntimeRequest(method, params);
    const response = await new Promise<RuntimeResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
      this.socket?.write(encodeRuntimeFrame(request));
    });
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result;
  }

  async subscribe(
    listener: (event: RuntimeEvent) => void,
    afterEventId?: string,
    workspacePath?: string,
  ): Promise<readonly RuntimeEvent[]> {
    this.listeners.add(listener);
    try {
      const result = await this.request("events.subscribe", {
        ...(afterEventId ? { afterEventId } : {}),
        ...(workspacePath ? { workspacePath } : {}),
      });
      const events = readSubscribedEvents(result);
      if (!events) throw new Error("daemon 返回了无效事件订阅结果");
      return events;
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
  }

  close(): void {
    this.socket?.end();
    this.socket = undefined;
    this.listeners.clear();
    this.rejectPending(new Error("本机 Runtime client 已关闭"));
  }

  private handleData(chunk: Buffer): void {
    for (const message of this.decoder.push(chunk)) {
      if (message.kind === "event") {
        for (const listener of this.listeners) listener(message.event);
      } else if (message.kind === "response") {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          pending.resolve(message);
        }
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function readSubscribedEvents(value: JsonValue): readonly RuntimeEvent[] | undefined {
  if (!isJsonObject(value)) return undefined;
  if (!Array.isArray(value.events)) return undefined;
  const events = value.events.map(readRuntimeEvent);
  return events.every((event): event is RuntimeEvent => event !== undefined) ? events : undefined;
}

function readRuntimeEvent(value: JsonValue): RuntimeEvent | undefined {
  if (!isJsonObject(value)) return undefined;
  const { eventId, topic, scope, resourceVersion, at, payload } = value;
  if (
    typeof eventId !== "string" ||
    typeof topic !== "string" ||
    typeof resourceVersion !== "number" ||
    typeof at !== "number" ||
    !isJsonObject(scope) ||
    typeof scope.workspacePath !== "string" ||
    !isJsonValue(payload)
  )
    return undefined;
  if (
    (scope.sessionId !== undefined && typeof scope.sessionId !== "string") ||
    (scope.runId !== undefined && typeof scope.runId !== "string") ||
    (scope.jobId !== undefined && typeof scope.jobId !== "string")
  )
    return undefined;
  return {
    protocolVersion: 1,
    eventId,
    topic,
    scope: {
      workspacePath: scope.workspacePath,
      ...(typeof scope.sessionId === "string" ? { sessionId: scope.sessionId } : {}),
      ...(typeof scope.runId === "string" ? { runId: scope.runId } : {}),
      ...(typeof scope.jobId === "string" ? { jobId: scope.jobId } : {}),
    },
    resourceVersion,
    at,
    payload,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}
