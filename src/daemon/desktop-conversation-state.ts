import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import type { JsonObject } from "./protocol.js";

const DESKTOP_CONVERSATION_STATE_VERSION = 1 as const;
const MAX_IDEMPOTENCY_RECORDS = 500;

export interface DesktopQueuedInput {
  readonly queueId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly text: string;
  readonly createdAt: number;
}

interface DesktopIdempotencyRecord {
  readonly workspacePath: string;
  readonly key: string;
  readonly result: JsonObject;
  readonly createdAt: number;
}

interface DesktopConversationStateFile {
  readonly version: typeof DESKTOP_CONVERSATION_STATE_VERSION;
  readonly queuedInputs: readonly DesktopQueuedInput[];
  readonly idempotency: readonly DesktopIdempotencyRecord[];
}

export interface DesktopConversationStateStoreOptions {
  readonly filePath?: string;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

/** Durable desktop control state. Conversation messages remain exclusively in Session JSONL. */
export class DesktopConversationStateStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: DesktopConversationStateStoreOptions = {}) {
    this.filePath =
      options.filePath ?? join(homedir(), ".pico", "desktop", "conversation-state.json");
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => `queued_${randomUUID()}`);
  }

  async listQueued(workspacePath: string, sessionId: string): Promise<DesktopQueuedInput[]> {
    const canonical = normalizeWorkspacePath(workspacePath);
    return (await this.read()).queuedInputs
      .filter((input) => input.workspacePath === canonical && input.sessionId === sessionId)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.queueId.localeCompare(right.queueId),
      );
  }

  async enqueue(
    workspacePath: string,
    sessionId: string,
    text: string,
  ): Promise<DesktopQueuedInput> {
    const queued: DesktopQueuedInput = {
      queueId: this.generateId(),
      workspacePath: normalizeWorkspacePath(workspacePath),
      sessionId: requireNonEmpty(sessionId, "sessionId"),
      text: requireNonEmpty(text, "text"),
      createdAt: this.now(),
    };
    await this.mutate((state) => ({
      ...state,
      queuedInputs: [...state.queuedInputs, queued],
    }));
    return queued;
  }

  async removeQueued(queueId: string): Promise<void> {
    const normalized = requireNonEmpty(queueId, "queueId");
    await this.mutate((state) => ({
      ...state,
      queuedInputs: state.queuedInputs.filter((input) => input.queueId !== normalized),
    }));
  }

  async getIdempotent(workspacePath: string, key: string): Promise<JsonObject | undefined> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalized = requireNonEmpty(key, "idempotencyKey");
    return (await this.read()).idempotency.find(
      (record) => record.workspacePath === canonical && record.key === normalized,
    )?.result;
  }

  async rememberIdempotent(workspacePath: string, key: string, result: JsonObject): Promise<void> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalized = requireNonEmpty(key, "idempotencyKey");
    await this.mutate((state) => ({
      ...state,
      idempotency: [
        ...state.idempotency.filter(
          (record) => record.workspacePath !== canonical || record.key !== normalized,
        ),
        { workspacePath: canonical, key: normalized, result, createdAt: this.now() },
      ]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, MAX_IDEMPOTENCY_RECORDS),
    }));
  }

  private async mutate(
    operation: (state: DesktopConversationStateFile) => DesktopConversationStateFile,
  ): Promise<void> {
    const execute = async () => writeJsonAtomic(this.filePath, operation(await this.read()));
    const queued = this.mutationQueue.then(execute, execute);
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  private async read(): Promise<DesktopConversationStateFile> {
    try {
      return parseState(JSON.parse(await readFile(this.filePath, "utf8")), this.filePath);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return emptyState();
      throw error;
    }
  }
}

function emptyState(): DesktopConversationStateFile {
  return { version: DESKTOP_CONVERSATION_STATE_VERSION, queuedInputs: [], idempotency: [] };
}

function parseState(value: unknown, filePath: string): DesktopConversationStateFile {
  if (
    !isRecord(value) ||
    value["version"] !== DESKTOP_CONVERSATION_STATE_VERSION ||
    !Array.isArray(value["queuedInputs"]) ||
    !Array.isArray(value["idempotency"])
  ) {
    throw new Error(`Desktop conversation state format is invalid: ${filePath}`);
  }
  return {
    version: DESKTOP_CONVERSATION_STATE_VERSION,
    queuedInputs: value["queuedInputs"].map((item) => parseQueued(item, filePath)),
    idempotency: value["idempotency"].map((item) => parseIdempotency(item, filePath)),
  };
}

function parseQueued(value: unknown, filePath: string): DesktopQueuedInput {
  if (
    !isRecord(value) ||
    typeof value["queueId"] !== "string" ||
    typeof value["workspacePath"] !== "string" ||
    typeof value["sessionId"] !== "string" ||
    typeof value["text"] !== "string" ||
    typeof value["createdAt"] !== "number" ||
    !Number.isFinite(value["createdAt"])
  ) {
    throw new Error(`Desktop conversation queue contains an invalid entry: ${filePath}`);
  }
  return {
    queueId: requireNonEmpty(value["queueId"], "queueId"),
    workspacePath: normalizeWorkspacePath(value["workspacePath"]),
    sessionId: requireNonEmpty(value["sessionId"], "sessionId"),
    text: requireNonEmpty(value["text"], "text"),
    createdAt: value["createdAt"],
  };
}

function parseIdempotency(value: unknown, filePath: string): DesktopIdempotencyRecord {
  if (
    !isRecord(value) ||
    typeof value["workspacePath"] !== "string" ||
    typeof value["key"] !== "string" ||
    !isRecord(value["result"]) ||
    typeof value["createdAt"] !== "number" ||
    !Number.isFinite(value["createdAt"])
  ) {
    throw new Error(`Desktop conversation idempotency contains an invalid entry: ${filePath}`);
  }
  return {
    workspacePath: normalizeWorkspacePath(value["workspacePath"]),
    key: requireNonEmpty(value["key"], "idempotencyKey"),
    result: value["result"] as JsonObject,
    createdAt: value["createdAt"],
  };
}

function normalizeWorkspacePath(workspacePath: string): string {
  return resolve(requireNonEmpty(workspacePath, "workspacePath")).normalize("NFC");
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
