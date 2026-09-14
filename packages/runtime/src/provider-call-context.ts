import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderCallPurpose } from "@pico/core";

/** Explicit business attribution for a Provider call within one async chain. */
export interface ProviderCallContext {
  readonly purpose: ProviderCallPurpose;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly goalId?: string;
  readonly jobId?: string;
  readonly attemptId?: string;
}

const providerCallContext = new AsyncLocalStorage<ProviderCallContext>();

export function withProviderCallContext<T>(context: ProviderCallContext, run: () => T): T {
  const parent = providerCallContext.getStore();
  return providerCallContext.run({ ...parent, ...context }, run);
}

export function getProviderCallContext(): ProviderCallContext | undefined {
  const context = providerCallContext.getStore();
  return context ? { ...context } : undefined;
}
