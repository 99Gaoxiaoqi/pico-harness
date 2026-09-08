import type { DesktopRuntimeMethod, RuntimeParams, RuntimeResult } from "@pico/protocol";
import type { DesktopRuntimeApi } from "../../preload/contract.js";

export const QUERY_PAGE_SIZE = 200;

export class WorkbarPanelRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WorkbarPanelRuntimeError";
  }
}

export async function invokeWorkbarRuntime<Method extends DesktopRuntimeMethod>(
  runtime: DesktopRuntimeApi,
  method: Method,
  params: RuntimeParams<Method>,
): Promise<RuntimeResult<Method>> {
  const result = await runtime[method](params);
  if (!result.ok) {
    throw new WorkbarPanelRuntimeError(
      result.error.code,
      result.error.message,
      result.error.retryable,
    );
  }
  return result.value;
}

export function workbarIdempotencyKey(instanceId: string, operation: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `desktop-workbar:${instanceId}:${operation}:${suffix}`;
}

export function workbarErrorMessage(cause: unknown): string {
  if (
    cause instanceof WorkbarPanelRuntimeError &&
    (cause.code === "not_repository" || cause.message.includes("not a Git repository"))
  ) {
    return "当前任务没有关联 Git 项目，变更审阅仅在 Git 项目中可用。";
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return "工作栏 authority 请求失败。";
}
