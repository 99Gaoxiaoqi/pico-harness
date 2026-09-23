import { createHash } from "node:crypto";
import { copyFile, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeParams } from "@pico/protocol";
import {
  isArtifactReference,
  type DesktopArtifactReference,
} from "../preload/artifact-contract.js";

type ArtifactQuery = (params: RuntimeParams<"session.artifacts.query">) => Promise<unknown>;

export interface ArtifactExportServices {
  readonly query: ArtifactQuery;
  readonly chooseSavePath: (name: string) => Promise<string | undefined>;
  readonly revealFile: (path: string) => void;
  readonly openDefaultApp?: (path: string) => Promise<void>;
}

/** All bytes originate in the session authority. Renderer supplies no source or output path. */
export function createArtifactExporter(services: ArtifactExportServices) {
  const retainedDirectories = new Set<string>();
  return {
    async export(
      reference: DesktopArtifactReference,
      action: "open" | "openInDefaultApp" | "saveAs",
    ): Promise<void> {
      if (!isArtifactReference(reference)) throw new Error("生成文件引用无效");
      const metadata = record(await services.query({ ...reference, action: "get" }));
      if (!Array.isArray(metadata.artifacts) || metadata.artifacts.length !== 1) {
        throw new Error("生成文件不存在或不属于当前会话");
      }
      const artifact = record(metadata.artifacts[0]);
      if (
        artifact.artifactId !== reference.artifactId ||
        typeof artifact.title !== "string" ||
        typeof artifact.digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(artifact.digest) ||
        !Number.isSafeInteger(artifact.sizeBytes) ||
        (artifact.sizeBytes as number) < 0
      )
        throw new Error("生成文件元数据无效");
      const filename = safeArtifactFilename(artifact.title);
      if (
        action === "openInDefaultApp" &&
        (!/\.html?$/iu.test(filename) ||
          typeof artifact.mimeType !== "string" ||
          artifact.mimeType.split(";", 1)[0]?.trim().toLowerCase() !== "text/html")
      )
        throw new Error("仅 HTML 生成文件可用默认应用打开");
      const destination = action === "saveAs" ? await services.chooseSavePath(filename) : undefined;
      if (action === "saveAs" && !destination) return;
      const directory = await mkdtemp(join(tmpdir(), "pico-artifact-"));
      const filePath = join(directory, filename);
      let retained = false;
      try {
        const file = await open(filePath, "wx", 0o600);
        try {
          let offsetBytes = 0;
          const digest = createHash("sha256");
          do {
            const chunk = record(
              await services.query({
                ...reference,
                action: "read_chunk",
                offsetBytes,
                limitBytes: 32 * 1024,
              }),
            );
            if (typeof chunk.contentBase64 !== "string") throw new Error("生成文件分块无效");
            const bytes = Buffer.from(chunk.contentBase64, "base64");
            if (
              bytes.toString("base64") !== chunk.contentBase64 ||
              bytes.byteLength > 32 * 1024 ||
              chunk.offsetBytes !== offsetBytes ||
              chunk.endOffsetBytes !== offsetBytes + bytes.byteLength ||
              chunk.totalBytes !== artifact.sizeBytes ||
              offsetBytes + bytes.byteLength > (artifact.sizeBytes as number) ||
              (bytes.byteLength === 0 && offsetBytes < (artifact.sizeBytes as number))
            )
              throw new Error("生成文件分块范围或内容无效");
            await file.writeFile(bytes);
            digest.update(bytes);
            offsetBytes += bytes.byteLength;
          } while (offsetBytes < (artifact.sizeBytes as number));
          if (digest.digest("hex") !== artifact.digest) throw new Error("生成文件内容校验失败");
        } finally {
          await file.close();
        }
        if (destination) await copyFile(filePath, destination);
        else if (action === "openInDefaultApp") {
          if (!services.openDefaultApp) throw new Error("默认应用打开能力不可用");
          await services.openDefaultApp(filePath);
          retainedDirectories.add(directory);
          retained = true;
        } else {
          // Showing the file does not execute script/executable artifacts through an OS association.
          services.revealFile(filePath);
          retainedDirectories.add(directory);
          retained = true;
        }
      } finally {
        if (!retained) await rm(directory, { recursive: true, force: true });
      }
    },
    async dispose(): Promise<void> {
      await Promise.all(
        [...retainedDirectories].map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
      retainedDirectories.clear();
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("生成文件响应无效");
  return value as Record<string, unknown>;
}

function safeArtifactFilename(title: string): string {
  const name = title
    .split(/[\\/]/u)
    .at(-1)
    ?.replace(/[<>:"|?*]/gu, "_")
    .trim();
  if (!name || /^\.+$/u.test(name)) return "artifact.txt";
  let bounded = Array.from(name, (character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127 ? "_" : character;
  }).join("");
  while (Buffer.byteLength(bounded, "utf8") > 180) bounded = bounded.slice(0, -1);
  return bounded;
}
