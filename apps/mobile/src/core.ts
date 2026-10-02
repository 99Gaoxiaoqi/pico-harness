import type { RuntimeInputAttachment } from "@pico/protocol/mobile";
import type {
  RemoteMethod as RuntimeMethod,
  RemoteParams as RuntimeParams,
  RemoteResult as RuntimeResult,
} from "@pico/protocol/remote";

export type MobileParams<M extends RuntimeMethod> = Omit<RuntimeParams<M>, "workspacePath">;
export type SavedHost = {
  id: string;
  name: string;
  baseUrl: string;
  deviceId: string;
  gatewayId: string;
};
export type Workspace = { id: string; label: string };
export type ConnectionPhase =
  | "offline"
  | "connecting"
  | "syncing"
  | "connected"
  | "background"
  | "blocked";
export type MobileCapabilities = {
  methods: readonly string[];
  permissions: readonly string[];
  reasons?: Record<string, string>;
};
export interface RuntimePort {
  request<M extends RuntimeMethod>(
    method: M,
    params: MobileParams<M>,
    workspaceId?: string,
  ): Promise<RuntimeResult<M>>;
}

export class GenerationFence {
  #generation = 0;
  next() {
    return ++this.#generation;
  }
  get current() {
    return this.#generation;
  }
  assert(generation: number) {
    if (generation !== this.#generation) throw new Error("连接已切换，已丢弃旧响应");
  }
}

export function decodedBase64Size(data: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0)
    throw new Error("图片编码无效");
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
export function validateAttachments(images: readonly RuntimeInputAttachment[]) {
  if (images.length > 4) throw new Error("最多选择 4 张图片");
  const total = images.reduce((n, image) => n + decodedBase64Size(image.data), 0);
  if (total > 256 * 1024) throw new Error("图片总量超过 256 KiB，请缩小图片");
  return total;
}

/** Schedules after completion, so slow attach calls never accumulate. */
export class SerialPoller {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #inFlight: Promise<void> | undefined;
  start(task: () => Promise<void>, onError: (error: unknown) => void, delay = 250) {
    this.stop();
    const generation = this.#generation;
    const run = async () => {
      if (generation !== this.#generation) return;
      // A previous foreground generation may still be draining a request.
      if (this.#inFlight) await this.#inFlight;
      if (generation !== this.#generation) return;
      const operation = task();
      this.#inFlight = operation;
      try {
        await operation;
      } catch (error) {
        if (generation === this.#generation) onError(error);
      } finally {
        if (this.#inFlight === operation) this.#inFlight = undefined;
      }
      if (generation === this.#generation) this.#timer = setTimeout(() => void run(), delay);
    };
    void run();
  }
  stop() {
    this.#generation++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error)
    return (
      ("outcome" in error && error.outcome === "unknown"
        ? "结果未确认，请刷新状态后再决定是否重试。"
        : "") + error.message
    );
  return "操作失败，请查看电脑网关状态";
}
export function canUse(
  capabilities: MobileCapabilities | undefined,
  method: string,
): string | undefined {
  if (!capabilities) return "尚未连接电脑";
  if (capabilities.methods.includes(method)) return undefined;
  return capabilities.reasons?.[method] ?? "电脑未授权此操作或当前宿主不支持，请在电脑调整设备授权";
}
export function assertArtifactIntegrity(
  expected: { sizeBytes: number; digest: string },
  size: number,
  digest: string,
) {
  if (expected.sizeBytes !== size || expected.digest.toLowerCase() !== digest.toLowerCase())
    throw new Error("文件大小或 SHA-256 校验失败，已删除下载");
}
