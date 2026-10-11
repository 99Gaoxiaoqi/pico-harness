import { existsSync } from "node:fs";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import { raceWithDeadlineReject } from "@pico/runtime/deadline";

export const DOCUMENT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_ATTACHMENT_MAX_CHARS = 120_000;
const PARSE_TIMEOUT_MS = 20_000;

export interface DocumentAttachmentInput {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ExtractedDocumentAttachment {
  readonly text: string;
  readonly truncated: boolean;
}

/** Parse untrusted document bytes off the host thread, with a hard termination deadline. */
export async function extractDocumentAttachment(
  input: DocumentAttachmentInput,
): Promise<ExtractedDocumentAttachment> {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0)
    throw new Error("附件为空，无法提取内容。");
  if (input.bytes.byteLength > DOCUMENT_ATTACHMENT_MAX_BYTES)
    throw new Error("单个附件不能超过 20 MiB。");
  if (!input.name.trim() || input.name.length > 1024) throw new Error("附件名称无效。");
  const extension = extname(input.name).toLowerCase();
  if (extension === ".doc" || extension === ".xls")
    throw new Error(`暂不支持旧版 ${extension} 文件，请另存为 ${extension}x 后上传。`);

  // Desktop bundles this worker beside daemon.cjs; normal package builds use the ESM sibling.
  const bundledWorker = new URL("./document-attachment-worker.cjs", import.meta.url);
  const workerUrl = existsSync(bundledWorker)
    ? bundledWorker
    : new URL("./document-attachment-worker.js", import.meta.url);
  const bytes = new Uint8Array(input.bytes);
  const worker = new Worker(workerUrl, {
    workerData: { ...input, bytes, maxChars: DOCUMENT_ATTACHMENT_MAX_CHARS },
    transferList: [bytes.buffer],
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 384, stackSizeMb: 8 },
  });
  try {
    return await raceWithDeadlineReject(
      new Promise<ExtractedDocumentAttachment>((resolve, reject) => {
        worker.once("message", (result: unknown) => {
          const response = result as {
            text?: unknown;
            truncated?: unknown;
            error?: unknown;
          } | null;
          if (typeof response?.error === "string") return reject(new Error(response.error));
          if (
            typeof response?.text !== "string" ||
            !response.text.trim() ||
            response.text.length > DOCUMENT_ATTACHMENT_MAX_CHARS ||
            typeof response.truncated !== "boolean"
          )
            return reject(new Error("附件解析未返回有效文本。"));
          resolve({ text: response.text, truncated: response.truncated });
        });
        worker.once("error", (error) => {
          reject(new Error("附件解析失败，文件可能已损坏或超过解析资源限制。", { cause: error }));
        });
        worker.once("exit", (code) => {
          reject(new Error(`附件解析进程提前结束（${code}）。`));
        });
      }),
      PARSE_TIMEOUT_MS,
      () => new Error("附件解析超过 20 秒，已停止处理，请缩小文件后重试。"),
    );
  } finally {
    await worker.terminate();
  }
}
