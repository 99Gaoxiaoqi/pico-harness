import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  HookCondition,
  HookDiagnostic,
  HookEvent,
  HookEventPayloadMap,
  HookExecutionContext,
  HookHandler,
  HookInput,
  HookOutput,
  HookSnapshot,
  ResolvedHookHandler,
} from "./types.js";

export interface HookExecutor {
  execute(
    resolved: ResolvedHookHandler,
    input: HookInput,
    context: HookExecutionContext,
  ): Promise<HookOutput>;
}

export interface HookServiceOptions {
  workDir: string;
  sessionId: string;
  executor: HookExecutor;
  snapshot?: HookSnapshot;
  concurrency?: number;
  agentConcurrency?: number;
}

const DECISION_RANK: Readonly<Record<HookOutput["decision"], number>> = {
  allow: 0,
  ask: 1,
  defer: 2,
  deny: 3,
};

/** 会话级 Hook 编排器。每次 dispatch 固定捕获一个快照，热重载不会影响在途事件。 */
export class HookService {
  private snapshot: HookSnapshot;
  private readonly hookScope = new AsyncLocalStorage<boolean>();
  private readonly concurrency: number;
  private readonly agentConcurrency: number;

  constructor(private readonly options: HookServiceOptions) {
    this.snapshot = options.snapshot ?? emptyHookSnapshot();
    this.concurrency = options.concurrency ?? 8;
    this.agentConcurrency = options.agentConcurrency ?? 2;
  }

  currentSnapshot(): HookSnapshot {
    return this.snapshot;
  }

  replaceSnapshot(snapshot: HookSnapshot): void {
    this.snapshot = snapshot;
  }

  async dispatch<E extends HookEvent>(
    event: E,
    payload: HookEventPayloadMap[E],
    context: HookExecutionContext = {},
  ): Promise<HookOutput> {
    if (context.signal?.aborted) throw abortReason(context.signal);
    if (context.suppressHooks || this.hookScope.getStore()) return { decision: "allow" };

    const snapshot = this.snapshot;
    const candidates = snapshot.handlers[event]
      .filter((entry) => entry.handler.enabled !== false)
      .filter((entry) => entry.trusted || !isExecutable(entry.handler))
      .filter((entry) => matcherMatches(entry.matcher, payload))
      .filter((entry) => conditionMatches(entry.groupCondition, payload))
      .filter((entry) => conditionMatches(entry.handler.if, payload));
    const handlers = deduplicate(candidates);
    if (handlers.length === 0) return { decision: "allow" };

    const input = makeInput(this.options.sessionId, this.options.workDir, event, payload);
    return await this.hookScope.run(true, async () => {
      const results = await runLimited(
        handlers,
        this.concurrency,
        this.agentConcurrency,
        context.signal,
        async (entry) => await this.options.executor.execute(entry, input, context),
      );
      return aggregateHookOutputs(results);
    });
  }
}

export function emptyHookSnapshot(): HookSnapshot {
  return {
    id: "empty",
    version: 0,
    createdAt: new Date(0).toISOString(),
    handlers: new Proxy(
      {},
      { get: () => [] },
    ) as Readonly<Record<HookEvent, readonly ResolvedHookHandler[]>>,
    diagnostics: [],
  };
}

export function aggregateHookOutputs(outputs: readonly HookOutput[]): HookOutput {
  let decision: HookOutput["decision"] = "allow";
  let reason: string | undefined;
  let modifiedInput: unknown;
  const contexts: string[] = [];
  const diagnostics: HookDiagnostic[] = [];

  for (const output of outputs) {
    if (DECISION_RANK[output.decision] > DECISION_RANK[decision]) {
      decision = output.decision;
      reason = output.reason;
    } else if (output.decision === decision && reason === undefined && output.reason) {
      reason = output.reason;
    }
    if (modifiedInput === undefined && output.modifiedInput !== undefined) {
      modifiedInput = output.modifiedInput;
    }
    if (output.additionalContext) contexts.push(output.additionalContext);
    if (output.diagnostics) diagnostics.push(...output.diagnostics);
  }

  return {
    decision,
    ...(reason ? { reason } : {}),
    ...(modifiedInput !== undefined ? { modifiedInput } : {}),
    ...(contexts.length > 0 ? { additionalContext: contexts.join("\n") } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function makeInput<E extends HookEvent>(
  sessionId: string,
  cwd: string,
  event: E,
  payload: HookEventPayloadMap[E],
): HookInput<E> {
  const toolPayload = isToolPayload(payload) ? payload : undefined;
  const response = "tool_response" in Object(payload) ? Reflect.get(payload, "tool_response") : undefined;
  return {
    session_id: sessionId,
    cwd,
    hook_event_name: event,
    payload,
    ...(toolPayload ? { tool_name: toolPayload.tool_name, tool_input: toolPayload.tool_input } : {}),
    ...(typeof response === "string" ? { tool_response: response } : {}),
  };
}

function isToolPayload(payload: object): payload is { tool_name: string; tool_input: unknown } {
  return "tool_name" in payload && typeof Reflect.get(payload, "tool_name") === "string";
}

function matcherMatches(matcher: string | undefined, payload: object): boolean {
  if (!matcher || matcher === "*") return true;
  const subject = "tool_name" in payload ? String(Reflect.get(payload, "tool_name")) : JSON.stringify(payload);
  if (/^[A-Za-z0-9_|.-]+$/.test(matcher)) return matcher.split("|").includes(subject);
  try {
    return new RegExp(matcher).test(subject);
  } catch {
    return false;
  }
}

function conditionMatches(condition: HookCondition | undefined, payload: object): boolean {
  if (!condition) return true;
  const value = readPath(payload, condition.path);
  switch (condition.op) {
    case "equals":
      return value === condition.value;
    case "contains":
      return typeof value === "string" && value.includes(condition.value);
    case "regex":
      try {
        return typeof value === "string" && new RegExp(condition.pattern).test(value);
      } catch {
        return false;
      }
    case "exists":
      return (value !== undefined) === (condition.value ?? true);
  }
}

function readPath(input: object, path: string): unknown {
  let current: unknown = input;
  for (const segment of path.split(".").filter(Boolean)) {
    if (typeof current !== "object" || current === null || !(segment in current)) return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
}

function isExecutable(handler: HookHandler): boolean {
  return handler.type === "command" || handler.type === "http" || handler.type === "mcp_tool";
}

function deduplicate(handlers: readonly ResolvedHookHandler[]): ResolvedHookHandler[] {
  const seen = new Set<string>();
  return handlers.filter((entry) => {
    const key = createHash("sha256")
      .update(JSON.stringify({ matcher: entry.matcher, handler: entry.handler }))
      .digest("hex");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runLimited<T extends ResolvedHookHandler>(
  entries: readonly T[],
  concurrency: number,
  agentConcurrency: number,
  signal: AbortSignal | undefined,
  execute: (entry: T) => Promise<HookOutput>,
): Promise<HookOutput[]> {
  const results: HookOutput[] = new Array(entries.length);
  let next = 0;
  let agents = 0;
  let wakeAgent: (() => void) | undefined;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      if (signal?.aborted) throw abortReason(signal);
      const index = next++;
      const entry = entries[index];
      if (!entry) return;
      if (entry.handler.type === "agent") {
        while (agents >= agentConcurrency) {
          await new Promise<void>((resolve) => {
            wakeAgent = resolve;
          });
          if (signal?.aborted) throw abortReason(signal);
        }
        agents++;
      }
      try {
        results[index] = await execute(entry);
      } finally {
        if (entry.handler.type === "agent") {
          agents--;
          wakeAgent?.();
          wakeAgent = undefined;
        }
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Hook dispatch aborted");
}
