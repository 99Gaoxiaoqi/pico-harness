import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderCallPurpose } from "../tasks/runtime-types.js";

/**
 * 一次 Provider 调用的业务归属。purpose 必须由调用路径明确给出；其余 ID
 * 只有在宿主掌握真实值时才写入，禁止从提示词、路径或任务描述猜测。
 */
export interface ProviderCallContext {
  purpose: ProviderCallPurpose;
  sessionId?: string;
  conversationId?: string;
  goalId?: string;
  jobId?: string;
  attemptId?: string;
}

const providerCallContext = new AsyncLocalStorage<ProviderCallContext>();

/** 在当前异步调用链中显式覆盖 Provider 调用归属。嵌套调用继承未覆盖字段。 */
export function withProviderCallContext<T>(
  context: ProviderCallContext,
  run: () => T,
): T {
  const parent = providerCallContext.getStore();
  return providerCallContext.run({ ...parent, ...context }, run);
}

/** 供 CostTracker 在真正发请求前读取；返回副本避免调用方修改 ALS 状态。 */
export function getProviderCallContext(): ProviderCallContext | undefined {
  const context = providerCallContext.getStore();
  return context ? { ...context } : undefined;
}
