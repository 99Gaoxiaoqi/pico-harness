import type { RuntimeSessionContextSnapshot } from "@pico/protocol";

export interface ContextUsageTarget {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly routeId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly connectionId: string;
  readonly configurationRevision: string;
}
export interface ComposerContextUsage {
  readonly inputTokens: number;
  readonly contextWindow?: number;
  readonly basis: "latest_input" | "turn_anchor";
}
export function contextTargetKey(target: ContextUsageTarget): string {
  return JSON.stringify([
    target.workspacePath,
    target.sessionId,
    target.routeId,
    target.providerId,
    target.modelId,
    target.connectionId,
    target.configurationRevision,
  ]);
}
/** Frozen per-request input is preferred; the same-route turn anchor includes output. */
export function composerContextUsage(
  snapshot: RuntimeSessionContextSnapshot | undefined,
  target: ContextUsageTarget,
): ComposerContextUsage | undefined {
  if (!snapshot || snapshot.sessionId !== target.sessionId) return undefined;
  const selected = snapshot.selectedRoute;
  if (
    selected.routeId !== target.routeId ||
    selected.providerId !== target.providerId ||
    selected.modelId !== target.modelId ||
    selected.connectionId !== target.connectionId
  )
    return undefined;
  const request = snapshot.latestRequest;
  const live =
    request.status === "available" &&
    request.providerId === target.providerId &&
    request.modelId === target.modelId &&
    request.routeId === target.routeId &&
    request.connectionId === target.connectionId &&
    request.usageStatus !== "missing" &&
    request.inputTokens !== undefined &&
    Number.isFinite(request.inputTokens) &&
    request.inputTokens > 0;
  if (live)
    return {
      inputTokens: request.inputTokens!,
      contextWindow:
        selected.declaredContextWindow ?? request.contextWindow ?? selected.contextWindow,
      basis: "latest_input",
    };
  const anchor = snapshot.lastRequestAnchor;
  if (
    !anchor ||
    anchor.routeId !== target.routeId ||
    anchor.modelId !== target.modelId ||
    anchor.connectionId !== target.connectionId
  )
    return undefined;
  const inputTokens = anchor.inputTokens + anchor.outputTokens;
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
  return {
    inputTokens,
    contextWindow: selected.declaredContextWindow ?? selected.contextWindow,
    basis: "turn_anchor",
  };
}

export interface ContextUsageReading {
  readonly targetKey: string;
  readonly snapshot?: RuntimeSessionContextSnapshot;
  readonly error?: string;
}
/** Target changes invalidate both standing data and in-flight reads; failures preserve same-target data. */
export function createContextUsageTracker(options: {
  readonly query: (target: ContextUsageTarget) => Promise<RuntimeSessionContextSnapshot>;
  readonly onChange: (reading: ContextUsageReading) => void;
  readonly delayMs?: number;
}) {
  let target: ContextUsageTarget | undefined;
  let revision = 0;
  let snapshot: RuntimeSessionContextSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let running = false;
  let dirty = false;
  const refresh = async () => {
    const current = target;
    if (disposed || !current) return;
    const readRevision = ++revision;
    const key = contextTargetKey(current);
    running = true;
    dirty = false;
    try {
      const result = await options.query(current);
      if (disposed || revision !== readRevision) return;
      snapshot = result;
      options.onChange({ targetKey: key, snapshot });
    } catch (error) {
      if (disposed || revision !== readRevision) return;
      options.onChange({
        targetKey: key,
        snapshot,
        error: error instanceof Error ? error.message : "上下文读取失败",
      });
    } finally {
      if (revision === readRevision) {
        running = false;
        if (dirty) schedule();
      }
    }
  };
  const schedule = () => {
    if (disposed || !target || timer !== undefined || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, options.delayMs ?? 100);
  };
  return {
    setTarget(next: ContextUsageTarget | undefined) {
      if (disposed) return;
      if (next && target && contextTargetKey(next) === contextTargetKey(target)) return;
      revision += 1;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      target = next;
      snapshot = undefined;
      running = false;
      dirty = false;
      options.onChange({ targetKey: next ? contextTargetKey(next) : "" });
      void refresh();
    },
    observe(sessionId: string) {
      if (sessionId !== target?.sessionId) return;
      dirty = true;
      schedule();
    },
    dispose() {
      disposed = true;
      revision += 1;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
