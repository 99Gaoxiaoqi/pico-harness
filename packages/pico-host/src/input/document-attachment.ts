import { existsSync } from "node:fs";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import { raceWithDeadlineReject } from "@pico/runtime/deadline";
import {
  DOCUMENT_QUERY_MAX_CHARS,
  DOCUMENT_QUERY_MAX_IMAGE_BYTES,
  type DocumentQuery,
  type DocumentQueryResult,
} from "./document-query-contract.js";

export const DOCUMENT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_ATTACHMENT_MAX_CHARS = 120_000;
const PARSE_TIMEOUT_MS = 20_000;
const MAX_ACTIVE_WORKERS = 2;
let activeWorkers = 0;

export interface DocumentAttachmentInput {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ExtractedDocumentAttachment {
  readonly text: string;
  readonly truncated: boolean;
}

function validateInput(input: DocumentAttachmentInput): void {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0)
    throw new Error("附件为空，无法提取内容。");
  if (input.bytes.byteLength > DOCUMENT_ATTACHMENT_MAX_BYTES)
    throw new Error("单个附件不能超过 20 MiB。");
  if (!input.name.trim() || input.name.length > 1024) throw new Error("附件名称无效。");
  const extension = extname(input.name).toLowerCase();
  if (extension === ".doc" || extension === ".xls")
    throw new Error(`暂不支持旧版 ${extension} 文件，请另存为 ${extension}x 后上传。`);
}

function validateQuery(query: DocumentQuery): void {
  if (!query || !["inspect", "read", "search", "view", "analyze"].includes(query.action))
    throw new Error("文档查询 action 无效。");
  if (
    "offset" in query &&
    query.offset !== undefined &&
    (!Number.isSafeInteger(query.offset) || query.offset < 0)
  )
    throw new Error("offset 必须是从 0 开始的整数。");
  if (
    "limit" in query &&
    query.limit !== undefined &&
    (!Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > (query.action === "search" ? 100 : DOCUMENT_QUERY_MAX_CHARS))
  )
    throw new Error(
      `limit 必须是 1–${query.action === "search" ? 100 : DOCUMENT_QUERY_MAX_CHARS} 的整数。`,
    );
  if (
    query.action === "search" &&
    (typeof query.query !== "string" || !query.query.trim() || query.query.length > 1024)
  )
    throw new Error("搜索 query 必须包含 1–1024 个字符。");
  if (
    "page" in query &&
    query.page !== undefined &&
    (!Number.isSafeInteger(query.page) || query.page < 1)
  )
    throw new Error("page 必须是从 1 开始的整数。");
  if (query.action === "view" && query.page === undefined) throw new Error("view 必须指定 page。");
}

function aborted(): Error {
  const error = new Error("文档查询已取消。");
  error.name = "AbortError";
  return error;
}

/** Every parse runs off-thread, with a hard deadline, bounded concurrency and cancellation. */
async function runWorker(
  input: DocumentAttachmentInput,
  query?: DocumentQuery,
  signal?: AbortSignal,
): Promise<unknown> {
  validateInput(input);
  if (signal?.aborted) throw aborted();
  if (activeWorkers >= MAX_ACTIVE_WORKERS)
    throw new Error("文档解析正在忙碌（最多 2 个并行任务），请稍后重试。");
  const bundledWorker = new URL("./document-attachment-worker.cjs", import.meta.url);
  const workerUrl = existsSync(bundledWorker)
    ? bundledWorker
    : new URL("./document-attachment-worker.js", import.meta.url);
  const bytes = new Uint8Array(input.bytes);
  activeWorkers++;
  let worker: Worker | undefined;
  let onAbort: (() => void) | undefined;
  try {
    worker = new Worker(workerUrl, {
      workerData: { ...input, bytes, maxChars: DOCUMENT_ATTACHMENT_MAX_CHARS, query },
      transferList: [bytes.buffer],
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    return await raceWithDeadlineReject(
      new Promise<unknown>((resolve, reject) => {
        onAbort = () => reject(aborted());
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        worker!.once("message", (response: unknown) => {
          if (
            response &&
            typeof response === "object" &&
            "error" in response &&
            typeof response.error === "string"
          )
            reject(new Error(response.error));
          else resolve(response);
        });
        worker!.once("error", (cause) =>
          reject(new Error("附件解析失败，文件可能已损坏或超过解析资源限制。", { cause })),
        );
        worker!.once("exit", (code) => reject(new Error(`附件解析进程提前结束（${code}）。`)));
      }),
      PARSE_TIMEOUT_MS,
      () => new Error("附件解析超过 20 秒，已停止处理，请缩小文件后重试。"),
    );
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    try {
      await worker?.terminate();
    } finally {
      activeWorkers--;
    }
  }
}

export async function queryDocumentAttachment(
  input: DocumentAttachmentInput,
  query: DocumentQuery,
  options: { readonly signal?: AbortSignal } = {},
): Promise<DocumentQueryResult> {
  validateQuery(query);
  const response = (await runWorker(input, query, options.signal)) as DocumentQueryResult | null;
  if (
    !response ||
    !["text", "word", "pdf", "spreadsheet"].includes(response.kind) ||
    typeof response.text !== "string" ||
    response.text.length > DOCUMENT_QUERY_MAX_CHARS
  )
    throw new Error("文档查询未返回有效的受限结果。");
  if (response.image) {
    const image = response.image;
    if (
      query.action !== "view" ||
      image.mimeType !== "image/png" ||
      typeof image.data !== "string" ||
      image.data.length > Math.ceil(DOCUMENT_QUERY_MAX_IMAGE_BYTES / 3) * 4 ||
      Buffer.byteLength(image.data, "base64") > DOCUMENT_QUERY_MAX_IMAGE_BYTES ||
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width <= 0 ||
      image.height <= 0 ||
      image.width > 4096 ||
      image.height > 4096 ||
      image.width * image.height > 4_000_000
    )
      throw new Error("PDF 页面图像超过安全输出限制。");
  }
  return response;
}

/** Compatibility only. New document tools must use queryDocumentAttachment. */
export async function extractDocumentAttachment(
  input: DocumentAttachmentInput,
): Promise<ExtractedDocumentAttachment> {
  const response = (await runWorker(input)) as ExtractedDocumentAttachment | null;
  if (
    typeof response?.text !== "string" ||
    !response.text.trim() ||
    response.text.length > DOCUMENT_ATTACHMENT_MAX_CHARS ||
    typeof response.truncated !== "boolean"
  )
    throw new Error("附件解析未返回有效文本。");
  return { text: response.text, truncated: response.truncated };
}
