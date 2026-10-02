import {
  inspectMediaBytes,
  mediaPreviewLimit,
  type RuntimeMediaReference,
  type RuntimeSessionArtifact,
} from "@pico/protocol/mobile";
import type { RuntimePort } from "./core";
import { assertArtifactIntegrity } from "./core";

export async function resolveMediaArtifact(
  port: RuntimePort,
  sessionId: string,
  reference: RuntimeMediaReference,
): Promise<RuntimeSessionArtifact> {
  if (
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes <= 0 ||
    reference.sizeBytes > mediaPreviewLimit(reference.kind) ||
    !/^[a-f0-9]{64}$/.test(reference.digest)
  )
    throw new Error("媒体超过预览上限或缺少有效校验信息");
  const result = await port.request("session.artifacts.query", {
    sessionId,
    action: "get",
    artifactId: reference.artifactId,
  });
  const artifacts = result.artifacts as RuntimeSessionArtifact[] | undefined;
  const artifact = artifacts?.length === 1 ? artifacts[0] : undefined;
  if (
    !artifact ||
    artifact.artifactId !== reference.artifactId ||
    artifact.sizeBytes !== reference.sizeBytes ||
    artifact.digest !== reference.digest ||
    artifact.mimeType !== reference.mimeType
  )
    throw new Error("媒体已删除或登记信息已改变，请刷新会话");
  return artifact;
}

export function verifyMediaIntegrity(
  reference: RuntimeMediaReference,
  size: number,
  digest: string,
  prefix: Uint8Array,
) {
  assertArtifactIntegrity(reference, size, digest);
  const actual = inspectMediaBytes(prefix);
  if (!actual || actual.kind !== reference.kind || actual.mimeType !== reference.mimeType)
    throw new Error("文件内容与声明格式不符，已拒绝预览");
}

export function streamingMediaText(text: string): string {
  // An overlay has no durable media identity yet, including half-written data URIs.
  return text.replace(
    /data:(?:image|video)\/[a-z0-9.+-]+(?:;[^,\s"'<>()[\]`]+)?(?:,[a-z0-9+/=%_-]*)?/giu,
    "[媒体正在生成]",
  );
}
