import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../schema/message.js";
import type { BaseTool, Registry, ToolExecutionContext } from "./registry.js";
import { NO_FILE_SIDE_EFFECTS } from "./registry.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";

const MAX_QUESTION_LENGTH = 2_000;
const MAX_HEADER_LENGTH = 64;
const MAX_OPTION_LABEL_LENGTH = 120;
const MAX_OPTION_DESCRIPTION_LENGTH = 500;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

declare const askUserRequestIdBrand: unique symbol;

/** 每个结构化问题的稳定 ID，与 provider tool call ID 解耦。 */
export type AskUserRequestId = string & { readonly [askUserRequestIdBrand]: true };

export interface AskUserOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export interface AskUserRequest {
  readonly requestId: AskUserRequestId;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly AskUserOption[];
}

export type AskUserAnswer =
  | {
      readonly kind: "selected";
      readonly requestId: AskUserRequestId;
      readonly optionId: string;
      readonly label: string;
    }
  | {
      readonly kind: "cancelled";
      readonly requestId: AskUserRequestId;
      readonly reason: string;
    };

export type AskUserHandlerEvent =
  | { readonly kind: "pending"; readonly request: AskUserRequest }
  | {
      readonly kind: "settled";
      readonly request: AskUserRequest;
      readonly outcome: "answered" | "cancelled" | "aborted";
      readonly answer?: AskUserAnswer;
    };

export type AskUserHandlerListener = (event: AskUserHandlerEvent) => void;

export interface AskUserHandlerOptions {
  /** UI 订阅者异常不得卡住工具 Promise；宿主可在此记录异常。 */
  readonly onListenerError?: (error: unknown) => void;
}

interface PendingAskUserRequest {
  readonly request: AskUserRequest;
  readonly resolve: (answer: AskUserAnswer) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

/**
 * 结构化 AskUser 的并发中枢。
 *
 * requestId 是唯一索引，因此多个并发问题可独立等待、回答或取消。
 * 所有 settle 路径均先从 Map 移除记录并解绑 AbortSignal，避免泄漏 resolver。
 */
export class AskUserHandler {
  private readonly pending = new Map<AskUserRequestId, PendingAskUserRequest>();
  private readonly listeners = new Set<AskUserHandlerListener>();

  constructor(private readonly options: AskUserHandlerOptions = {}) {}

  subscribe(listener: AskUserHandlerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  waitForAnswer(request: AskUserRequest, signal?: AbortSignal): Promise<AskUserAnswer> {
    signal?.throwIfAborted();
    if (this.pending.has(request.requestId)) {
      return Promise.reject(new Error(`AskUser requestId 重复: ${request.requestId}`));
    }

    return new Promise<AskUserAnswer>((resolve, reject) => {
      const abortListener = signal
        ? () => {
            const pending = this.take(request.requestId);
            if (!pending) return;
            this.emit({ kind: "settled", request, outcome: "aborted" });
            pending.reject(signal.reason ?? new DOMException("AskUser aborted", "AbortError"));
          }
        : undefined;
      const pending: PendingAskUserRequest = {
        request,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        ...(abortListener ? { abortListener } : {}),
      };

      this.pending.set(request.requestId, pending);
      if (signal && abortListener) {
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
          return;
        }
      }
      this.emit({ kind: "pending", request });
    });
  }

  /** 按 optionId 提交答案；标签从原请求取得，不信任 UI 回传文本。 */
  select(requestId: AskUserRequestId, optionId: string): boolean {
    const pending = this.pending.get(requestId);
    const option = pending?.request.options.find((candidate) => candidate.optionId === optionId);
    if (!pending || !option) return false;

    const taken = this.take(requestId);
    if (!taken) return false;
    const answer: AskUserAnswer = {
      kind: "selected",
      requestId,
      optionId: option.optionId,
      label: option.label,
    };
    this.emit({ kind: "settled", request: taken.request, outcome: "answered", answer });
    taken.resolve(answer);
    return true;
  }

  /** Esc 等交互取消会返回结构化 cancelled，让模型知道用户未选择。 */
  cancel(requestId: AskUserRequestId, reason = "用户取消了问题。"): boolean {
    const pending = this.take(requestId);
    if (!pending) return false;
    const answer: AskUserAnswer = { kind: "cancelled", requestId, reason };
    this.emit({ kind: "settled", request: pending.request, outcome: "cancelled", answer });
    pending.resolve(answer);
    return true;
  }

  cancelAll(reason = "AskUser handler 已关闭。"): number {
    const requestIds = [...this.pending.keys()];
    let cancelled = 0;
    for (const requestId of requestIds) {
      if (this.cancel(requestId, reason)) cancelled++;
    }
    return cancelled;
  }

  getPendingRequests(): readonly AskUserRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private take(requestId: AskUserRequestId): PendingAskUserRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private emit(event: AskUserHandlerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.options.onListenerError?.(error);
        } catch {
          // 监控回调也不得改变 AskUser 的 settle 语义。
        }
      }
    }
  }
}

interface AskUserToolInput {
  readonly question: string;
  readonly header?: string;
  readonly options: readonly {
    readonly label: string;
    readonly description?: string;
  }[];
}

export interface AskUserToolResult {
  readonly requestId: AskUserRequestId;
  readonly status: "answered" | "cancelled";
  readonly selectedOption?: { readonly optionId: string; readonly label: string };
  readonly reason?: string;
}

/** 模型工具：提交一个结构化单选问题，并异步等待 TUI 回答。 */
export class AskUserTool implements BaseTool {
  readonly readOnly = true;
  readonly handlesAbortSignal = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly handler: AskUserHandler) {}

  name(): string {
    return "ask_user";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "向用户提出一个需要明确选择的结构化问题。仅在缺少的选择会显著改变结果时使用；提交后工具会等待用户回答。",
      inputSchema: {
        type: "object",
        properties: {
          header: {
            type: "string",
            description: "可选的简短标题。",
            maxLength: MAX_HEADER_LENGTH,
          },
          question: {
            type: "string",
            description: "给用户的具体问题。",
            maxLength: MAX_QUESTION_LENGTH,
          },
          options: {
            type: "array",
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            items: {
              type: "object",
              properties: {
                label: { type: "string", maxLength: MAX_OPTION_LABEL_LENGTH },
                description: { type: "string", maxLength: MAX_OPTION_DESCRIPTION_LENGTH },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    };
  }

  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.none();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const input = parseAskUserToolInput(args);
    const requestId = createAskUserRequestId();
    const request: AskUserRequest = {
      requestId,
      question: input.question,
      ...(input.header ? { header: input.header } : {}),
      options: input.options.map((option, index) => ({
        optionId: `option-${index + 1}`,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    };
    const answer = await this.handler.waitForAnswer(request, context?.signal);
    context?.signal?.throwIfAborted();

    const result: AskUserToolResult =
      answer.kind === "selected"
        ? {
            requestId,
            status: "answered",
            selectedOption: { optionId: answer.optionId, label: answer.label },
          }
        : { requestId, status: "cancelled", reason: answer.reason };
    return JSON.stringify(result);
  }
}

/** 宿主显式选择开启 AskUser；默认 registry 构建不会隐式创建无 UI 的 handler。 */
export function registerAskUserTool(
  registry: Pick<Registry, "register">,
  handler: AskUserHandler,
): AskUserTool {
  const tool = new AskUserTool(handler);
  registry.register(tool);
  return tool;
}

export function createAskUserRequestId(): AskUserRequestId {
  return `ask_${Date.now().toString(36)}_${randomUUID()}` as AskUserRequestId;
}

function parseAskUserToolInput(args: string): AskUserToolInput {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("ask_user 参数解析失败：期望 JSON 对象。");
  }
  if (!isRecord(value)) {
    throw new Error("ask_user 参数无效：期望 JSON 对象。");
  }

  const question = requiredText(value["question"], "question", MAX_QUESTION_LENGTH);
  const header = optionalText(value["header"], "header", MAX_HEADER_LENGTH);
  const rawOptions = value["options"];
  if (
    !Array.isArray(rawOptions) ||
    rawOptions.length < MIN_OPTIONS ||
    rawOptions.length > MAX_OPTIONS
  ) {
    throw new Error(`ask_user 参数无效：options 必须包含 ${MIN_OPTIONS}-${MAX_OPTIONS} 项。`);
  }

  const seenLabels = new Set<string>();
  const options = rawOptions.map((rawOption, index) => {
    if (!isRecord(rawOption)) {
      throw new Error(`ask_user 参数无效：options[${index}] 必须是对象。`);
    }
    const label = requiredText(
      rawOption["label"],
      `options[${index}].label`,
      MAX_OPTION_LABEL_LENGTH,
    );
    const normalizedLabel = label.toLocaleLowerCase();
    if (seenLabels.has(normalizedLabel)) {
      throw new Error(`ask_user 参数无效：选项标签不得重复 (${label})。`);
    }
    seenLabels.add(normalizedLabel);
    const description = optionalText(
      rawOption["description"],
      `options[${index}].description`,
      MAX_OPTION_DESCRIPTION_LENGTH,
    );
    return { label, ...(description ? { description } : {}) };
  });

  return { question, ...(header ? { header } : {}), options };
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`ask_user 参数无效：${field} 必须是非空字符串。`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`ask_user 参数无效：${field} 不得超过 ${maxLength} 个字符。`);
  }
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
