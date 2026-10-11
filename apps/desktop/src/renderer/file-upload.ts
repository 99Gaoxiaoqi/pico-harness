import type {
  RuntimeArtifactInputAttachment,
  RuntimeParams,
  RuntimeResult,
  RuntimeUserDefaults,
} from "@pico/protocol";
import type { WorkspaceSessionRef } from "./workspace-session.js";
import { isRecord } from "./runtime-projections/values.js";

const MiB = 1024 * 1024;
const CHUNK_BYTES = 32 * 1024;
const MIME_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "text/plain",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
};
const CODE_EXTENSIONS = new Set(
  "js jsx ts tsx mjs cjs py rb go rs java c h cc cpp hpp cs swift kt kts scala sh bash zsh sql toml ini conf log r lua php vue svelte dockerfile makefile".split(
    " ",
  ),
);

export const FILE_UPLOAD_ACCEPT = [
  ...Object.keys(MIME_TYPES).map((extension) => `.${extension}`),
  ...[...CODE_EXTENSIONS].map((extension) => `.${extension}`),
  "text/*",
].join(",");

export function uploadMimeType(file: File): string | undefined {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  return (
    MIME_TYPES[extension] ??
    (CODE_EXTENSIONS.has(extension)
      ? "text/plain"
      : file.type.startsWith("text/")
        ? file.type
        : undefined)
  );
}

export function validateUploadFiles(files: readonly File[]): readonly (string | undefined)[] {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const imageTotal = files.reduce(
    (sum, file) => sum + (uploadMimeType(file)?.startsWith("image/") ? file.size : 0),
    0,
  );
  return files.map((file) => {
    const mimeType = uploadMimeType(file);
    if (!mimeType) return "不支持此文件类型；请选择图片、文本/代码、PDF、DOCX 或 XLSX。";
    if (!file.size) return "文件为空，请选择有内容的文件。";
    if (file.size > (mimeType.startsWith("image/") ? 10 : 20) * MiB)
      return mimeType.startsWith("image/")
        ? "单张图片不能超过 10 MiB。"
        : "单个文件不能超过 20 MiB。";
    if (files.length > 8) return "每条消息最多附加 8 个文件。";
    if (total > 40 * MiB) return "附件总大小不能超过 40 MiB。";
    if (imageTotal > 12 * MiB) return "图片总大小不能超过 12 MiB。";
    return undefined;
  });
}

export class FileUploadError extends Error {
  constructor(
    readonly file: File,
    cause: unknown,
  ) {
    super(`${file.name}：${cause instanceof Error ? cause.message : "上传失败，请重试。"}`);
    this.name = "FileUploadError";
  }
}

type UploadMethod =
  | "session.create"
  | "session.settings.update"
  | "session.artifacts.query"
  | "session.artifacts.command";
export type FileUploadRequest = <M extends UploadMethod>(
  method: M,
  params: RuntimeParams<M>,
) => Promise<RuntimeResult<M>>;

async function revision(request: FileUploadRequest, ref: WorkspaceSessionRef): Promise<number> {
  const value = await request("session.artifacts.query", { ...ref, action: "list", limit: 1 });
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision))
    throw new Error("无法读取附件版本，请重试。");
  return value.revision;
}

/** The renderer holds bytes only while uploading; durable sends contain Artifact references. */
export async function uploadFile(
  request: FileUploadRequest,
  ref: WorkspaceSessionRef,
  file: File,
): Promise<RuntimeArtifactInputAttachment> {
  let ingestId: string | undefined;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const begun = await request("session.artifacts.command", {
      ...ref,
      action: "begin",
      title: file.name,
      mimeType: uploadMimeType(file)!,
      expectedRevision: await revision(request, ref),
      idempotencyKey: crypto.randomUUID(),
    });
    if (typeof begun.ingestId !== "string") throw new Error("附件上传未返回有效标识。");
    ingestId = begun.ingestId;
    for (let offsetBytes = 0; offsetBytes < bytes.length; offsetBytes += CHUNK_BYTES) {
      const chunk = bytes.subarray(offsetBytes, offsetBytes + CHUNK_BYTES);
      const appended = await request("session.artifacts.command", {
        ...ref,
        action: "append",
        ingestId,
        offsetBytes,
        contentBase64: btoa(String.fromCharCode(...chunk)),
      });
      if (appended.nextOffsetBytes !== offsetBytes + chunk.length)
        throw new Error("附件上传字节数不一致，请重试。");
    }
    const committed = await request("session.artifacts.command", {
      ...ref,
      action: "commit",
      ingestId,
      expectedRevision: await revision(request, ref),
      expectedSizeBytes: file.size,
      expectedDigest: digest,
      idempotencyKey: crypto.randomUUID(),
    });
    const artifact = committed.artifact;
    if (
      !isRecord(artifact) ||
      typeof artifact.artifactId !== "string" ||
      artifact.digest !== digest
    )
      throw new Error("附件提交校验失败，请重试。");
    return { type: "artifact", artifactId: artifact.artifactId, digest };
  } catch (cause) {
    if (ingestId) {
      await request("session.artifacts.command", { ...ref, action: "abort", ingestId }).catch(
        () => {},
      );
    }
    throw new FileUploadError(file, cause);
  }
}

/** Preserve the session and completed uploads when a later upload or send fails. */
export class FileSendPreparation {
  private readonly sessions = new Map<string, WorkspaceSessionRef>();
  private readonly uploads = new WeakMap<File, Map<string, RuntimeArtifactInputAttachment>>();

  session(key: string): WorkspaceSessionRef | undefined {
    return this.sessions.get(key);
  }
  complete(key: string): void {
    this.sessions.delete(key);
  }

  async prepare(
    request: FileUploadRequest,
    key: string,
    input: {
      readonly workspacePath: string;
      readonly sessionId?: string;
      readonly initialSettings?: RuntimeUserDefaults;
      readonly files: readonly File[];
    },
  ): Promise<{
    readonly ref: WorkspaceSessionRef;
    readonly attachments: readonly RuntimeArtifactInputAttachment[];
  }> {
    const errors = validateUploadFiles(input.files);
    const invalid = errors.findIndex(Boolean);
    if (invalid >= 0) throw new FileUploadError(input.files[invalid]!, new Error(errors[invalid]));
    let ref = input.sessionId
      ? { workspacePath: input.workspacePath, sessionId: input.sessionId }
      : this.sessions.get(key);
    if (!ref) {
      const created = await request("session.create", { workspacePath: input.workspacePath });
      ref = { workspacePath: input.workspacePath, sessionId: created.session.sessionId };
      this.sessions.set(key, ref);
    }
    if (!input.sessionId && input.initialSettings && Object.keys(input.initialSettings).length)
      await request("session.settings.update", { ...ref, ...input.initialSettings });
    const attachments: RuntimeArtifactInputAttachment[] = [];
    const sessionKey = JSON.stringify([key, ref.workspacePath, ref.sessionId]);
    for (const file of input.files) {
      let cached = this.uploads.get(file);
      if (!cached) {
        cached = new Map();
        this.uploads.set(file, cached);
      }
      let attachment = cached.get(sessionKey);
      if (!attachment) {
        attachment = await uploadFile(request, ref, file);
        cached.set(sessionKey, attachment);
      }
      attachments.push(attachment);
    }
    return { ref, attachments };
  }
}
