import { randomUUID } from "node:crypto";
import type { HookService } from "../hooks/service.js";
import type {
  McpElicitationHandler,
  McpElicitationRequest,
  McpElicitationResult,
} from "./types.js";

const MAX_FIELDS = 12;
const MAX_TEXT_LENGTH = 2_000;
const SECRET_FIELD =
  /(?:pass(?:word|wd)|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|credential|private[ _-]?key)/iu;

declare const elicitationRequestIdBrand: unique symbol;
export type ElicitationRequestId = string & { readonly [elicitationRequestIdBrand]: true };

interface ElicitationFieldBase {
  key: string;
  title: string;
  description?: string;
  required: boolean;
}

export type ElicitationField =
  | (ElicitationFieldBase & {
      kind: "string";
      minLength: number;
      maxLength: number;
      defaultValue: string;
    })
  | (ElicitationFieldBase & {
      kind: "number" | "integer";
      minimum?: number;
      maximum?: number;
      defaultValue: string;
    })
  | (ElicitationFieldBase & { kind: "boolean"; defaultValue: boolean })
  | (ElicitationFieldBase & {
      kind: "enum";
      values: readonly { value: string; label: string }[];
      defaultValue: string;
    });

export interface ElicitationUiRequest {
  requestId: ElicitationRequestId;
  server: string;
  message: string;
  fields: readonly ElicitationField[];
}

export type ElicitationUiEvent =
  | { kind: "pending"; request: ElicitationUiRequest }
  | { kind: "settled"; request: ElicitationUiRequest };

export type ElicitationUiListener = (event: ElicitationUiEvent) => void;

interface PendingElicitation {
  request: ElicitationUiRequest;
  resolve: (result: McpElicitationResult) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  abortListener: () => void;
}

/** MCP form 的会话 UI 租约；不记录任何表单内容。 */
export class McpElicitationUiHandler {
  private readonly pending = new Map<ElicitationRequestId, PendingElicitation>();
  private readonly listeners = new Set<ElicitationUiListener>();

  subscribe(listener: ElicitationUiListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(
    server: string,
    request: McpElicitationRequest,
    signal: AbortSignal,
  ): Promise<McpElicitationResult> {
    signal.throwIfAborted();
    const uiRequest: ElicitationUiRequest = {
      requestId: `elicit_${randomUUID()}` as ElicitationRequestId,
      server,
      message: request.message,
      fields: parseFields(request.requestedSchema),
    };
    return new Promise((resolve, reject) => {
      const abortListener = (): void => {
        const pending = this.take(uiRequest.requestId);
        if (!pending) return;
        this.emit({ kind: "settled", request: uiRequest });
        pending.reject(signal.reason ?? new DOMException("Elicitation aborted", "AbortError"));
      };
      this.pending.set(uiRequest.requestId, {
        request: uiRequest,
        resolve,
        reject,
        signal,
        abortListener,
      });
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
      else this.emit({ kind: "pending", request: uiRequest });
    });
  }

  submit(requestId: ElicitationRequestId, values: Readonly<Record<string, unknown>>): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    const content = validateContent(pending.request.fields, values);
    const taken = this.take(requestId);
    if (!taken) return false;
    this.emit({ kind: "settled", request: taken.request });
    taken.resolve({ action: "accept", content });
    return true;
  }

  decline(requestId: ElicitationRequestId): boolean {
    return this.settle(requestId, { action: "decline" });
  }

  cancel(requestId: ElicitationRequestId): boolean {
    return this.settle(requestId, { action: "cancel" });
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.cancel(requestId);
  }

  getPendingRequests(): readonly ElicitationUiRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  private settle(requestId: ElicitationRequestId, result: McpElicitationResult): boolean {
    const pending = this.take(requestId);
    if (!pending) return false;
    this.emit({ kind: "settled", request: pending.request });
    pending.resolve(result);
    return true;
  }

  private take(requestId: ElicitationRequestId): PendingElicitation | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    pending.signal.removeEventListener("abort", pending.abortListener);
    return pending;
  }

  private emit(event: ElicitationUiEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // UI 订阅者不得改变协议 settle 语义。
      }
    }
  }
}

export interface HookedElicitationOptions {
  ui: McpElicitationUiHandler;
  hookService: () => HookService | undefined;
}

/** 固定顺序：Elicitation Hook → 用户表单 → 只观察 ElicitationResult Hook。 */
export function createHookedElicitationHandler(
  options: HookedElicitationOptions,
): McpElicitationHandler {
  return async (request, context) => {
    const service = options.hookService();
    const schemaSummary = summarizeSchema(request.requestedSchema);
    const before = await service?.dispatch(
      "Elicitation",
      { server: context.server, request: { message: request.message, schema: schemaSummary } },
      { signal: context.signal },
    );
    let result: McpElicitationResult;
    if (before?.decision === "deny") result = { action: "decline" };
    else if (before?.decision === "defer") result = { action: "cancel" };
    else {
      try {
        result = await options.ui.request(context.server, request, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw error;
        result = { action: "decline" };
      }
    }
    await service?.dispatch(
      "ElicitationResult",
      {
        server: context.server,
        result: {
          action: result.action,
          fields: result.action === "accept" ? Object.keys(result.content ?? {}) : [],
        },
      },
      { signal: context.signal },
    );
    return result;
  };
}

function parseFields(schema: Record<string, unknown>): readonly ElicitationField[] {
  if (schema.type !== "object" || !isRecord(schema.properties)) {
    throw new Error("Elicitation schema 必须是带 properties 的顶层 object");
  }
  const entries = Object.entries(schema.properties);
  if (entries.length > MAX_FIELDS) throw new Error(`Elicitation 字段超过 ${MAX_FIELDS} 个`);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  return entries.map(([key, raw]) => parseField(key, raw, required.has(key)));
}

function parseField(key: string, raw: unknown, required: boolean): ElicitationField {
  if (!isRecord(raw)) throw new Error(`Elicitation 字段 ${key} 不是 schema 对象`);
  const title = typeof raw.title === "string" ? raw.title : key;
  const description = typeof raw.description === "string" ? raw.description : undefined;
  if (SECRET_FIELD.test(`${key} ${title} ${description ?? ""}`)) {
    throw new Error(`Elicitation 拒绝收集疑似凭证字段: ${key}`);
  }
  const base = { key, title, required, ...(description ? { description } : {}) };
  if (Array.isArray(raw.enum)) {
    const values = raw.enum.filter((value): value is string => typeof value === "string");
    if (values.length < 1 || values.length > 20 || values.length !== raw.enum.length) {
      throw new Error(`Elicitation enum ${key} 非法`);
    }
    const names = Array.isArray(raw.enumNames) ? raw.enumNames : [];
    const defaultValue =
      typeof raw.default === "string" && values.includes(raw.default) ? raw.default : values[0]!;
    return {
      ...base,
      kind: "enum",
      values: values.map((value, index) => ({
        value,
        label: typeof names[index] === "string" ? names[index] : value,
      })),
      defaultValue,
    };
  }
  if (raw.type === "string") {
    const minLength = boundedInteger(raw.minLength, required ? 1 : 0, 0, MAX_TEXT_LENGTH);
    const maxLength = boundedInteger(raw.maxLength, MAX_TEXT_LENGTH, minLength, MAX_TEXT_LENGTH);
    return {
      ...base,
      kind: "string",
      minLength,
      maxLength,
      defaultValue: typeof raw.default === "string" ? raw.default.slice(0, maxLength) : "",
    };
  }
  if (raw.type === "number" || raw.type === "integer") {
    const minimum =
      typeof raw.minimum === "number" && Number.isFinite(raw.minimum) ? raw.minimum : undefined;
    const maximum =
      typeof raw.maximum === "number" && Number.isFinite(raw.maximum) ? raw.maximum : undefined;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error(`Elicitation 数值范围 ${key} 非法`);
    }
    const initial =
      typeof raw.default === "number" && Number.isFinite(raw.default) ? String(raw.default) : "";
    return {
      ...base,
      kind: raw.type,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      defaultValue: initial,
    };
  }
  if (raw.type === "boolean") {
    return { ...base, kind: "boolean", defaultValue: raw.default === true };
  }
  throw new Error(`Elicitation 字段 ${key} 类型不受支持`);
}

function validateContent(
  fields: readonly ElicitationField[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind === "string") {
      if (typeof value !== "string") throw new Error(`${field.title} 必须是文本`);
      if (value.length < field.minLength || value.length > field.maxLength) {
        throw new Error(`${field.title} 长度不符合要求`);
      }
      if (field.required || value.length > 0) content[field.key] = value;
    } else if (field.kind === "number" || field.kind === "integer") {
      if ((value === "" || value === undefined) && !field.required) continue;
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed) || (field.kind === "integer" && !Number.isInteger(parsed))) {
        throw new Error(`${field.title} 必须是有效数值`);
      }
      if (field.minimum !== undefined && parsed < field.minimum)
        throw new Error(`${field.title} 过小`);
      if (field.maximum !== undefined && parsed > field.maximum)
        throw new Error(`${field.title} 过大`);
      content[field.key] = parsed;
    } else if (field.kind === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${field.title} 必须是布尔值`);
      content[field.key] = value;
    } else if (field.kind === "enum") {
      if (
        typeof value !== "string" ||
        !field.values.some((candidate) => candidate.value === value)
      ) {
        throw new Error(`${field.title} 选项非法`);
      }
      content[field.key] = value;
    }
  }
  return content;
}

function summarizeSchema(schema: Record<string, unknown>): unknown {
  if (!isRecord(schema.properties)) return { valid: false };
  return {
    fields: Object.entries(schema.properties).map(([key, value]) => ({
      key,
      type:
        isRecord(value) && Array.isArray(value.enum)
          ? "enum"
          : isRecord(value)
            ? value.type
            : "invalid",
    })),
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
