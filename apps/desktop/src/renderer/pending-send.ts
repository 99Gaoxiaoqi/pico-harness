import {
  parseStrictRuntimeParams,
  SESSION_SEND_REPLAY_RUNTIME_CAPABILITY,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";

export const PENDING_SEND_PREFIX = "pico.pending-send:";
export const SESSION_SEND_REPLAY_CAPABILITY = SESSION_SEND_REPLAY_RUNTIME_CAPABILITY;

export interface PendingSendScope {
  readonly picoHome: string;
  readonly sourceKey: string;
}

export interface PendingSendRecord {
  readonly version: 1;
  readonly scope: PendingSendScope;
  readonly generation: string;
  readonly params: RuntimeParams<"session.send">;
  readonly draftSnapshot: string;
}

export type PendingSendEntry =
  | {
      readonly kind: "pending";
      readonly scope: PendingSendScope;
      readonly record: PendingSendRecord;
    }
  | { readonly kind: "blocked"; readonly scope: PendingSendScope; readonly reason: string };

type Send = (params: RuntimeParams<"session.send">) => Promise<RuntimeResult<"session.send">>;

function storageKey(scope: PendingSendScope): string {
  return PENDING_SEND_PREFIX + JSON.stringify([scope.picoHome, scope.sourceKey]);
}

function parseScope(key: string): PendingSendScope | undefined {
  try {
    const value: unknown = JSON.parse(key.slice(PENDING_SEND_PREFIX.length));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === "string" && part.length > 0)
    ) {
      return { picoHome: value[0], sourceKey: value[1] };
    }
  } catch {
    /* Keep records whose key cannot be decoded untouched. */
  }
  return undefined;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** A single-purpose store: a send must be durable before it reaches the bridge. */
export class PendingSendRepository {
  private readonly locks = new Set<string>();
  constructor(private readonly storage: Storage) {}

  get(scope: PendingSendScope): PendingSendEntry | undefined {
    const raw = this.storage.getItem(storageKey(scope));
    if (raw === null) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("记录格式无效");
      const record = value as Record<string, unknown>;
      if (record["version"] !== 1) throw Error("待确认记录版本不受支持，请更新 Pico");
      if (Object.keys(record).sort().join(",") !== "draftSnapshot,generation,params,scope,version")
        throw Error("记录字段无效");
      const storedScope = record["scope"] as PendingSendScope | undefined;
      if (
        !storedScope ||
        Object.keys(storedScope).sort().join(",") !== "picoHome,sourceKey" ||
        storedScope.picoHome !== scope.picoHome ||
        storedScope.sourceKey !== scope.sourceKey
      )
        throw Error("记录来源无效");
      if (
        typeof record["generation"] !== "string" ||
        !record["generation"] ||
        typeof record["draftSnapshot"] !== "string"
      )
        throw Error("记录内容无效");
      const params = parseStrictRuntimeParams("session.send", record["params"]);
      if (!params.idempotencyKey || "replayOnly" in params) throw Error("原始请求无效");
      return {
        kind: "pending",
        scope,
        record: freeze({
          version: 1,
          scope,
          generation: record["generation"],
          params,
          draftSnapshot: record["draftSnapshot"],
        }),
      };
    } catch (cause) {
      return {
        kind: "blocked",
        scope,
        reason: cause instanceof Error ? cause.message : "待确认记录无法读取",
      };
    }
  }

  list(picoHome: string): readonly PendingSendEntry[] {
    const entries: PendingSendEntry[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(PENDING_SEND_PREFIX)) continue;
      const scope = parseScope(key);
      if (!scope || scope.picoHome !== picoHome) continue;
      const entry = this.get(scope);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  isSending(scope: PendingSendScope): boolean {
    return this.locks.has(storageKey(scope));
  }

  abandon(scope: PendingSendScope): void {
    this.storage.removeItem(storageKey(scope));
  }

  private complete(record: PendingSendRecord): boolean {
    const current = this.get(record.scope);
    if (
      current?.kind !== "pending" ||
      current.record.generation !== record.generation ||
      current.record.params.idempotencyKey !== record.params.idempotencyKey
    )
      return false;
    this.storage.removeItem(storageKey(record.scope));
    return true;
  }

  async send(
    scope: PendingSendScope,
    params: RuntimeParams<"session.send">,
    draftSnapshot: string,
    dispatch: Send,
    changed: () => void = () => {},
  ): Promise<{
    readonly value: RuntimeResult<"session.send">;
    readonly record: PendingSendRecord;
    readonly confirmed: boolean;
  }> {
    if (!scope.picoHome || !scope.sourceKey) throw Error("发送记录缺少有效来源。");
    const key = storageKey(scope);
    if (this.locks.has(key) || this.get(scope))
      throw Error("这份草稿有待确认的发送，请先恢复发送结果或放弃恢复。");
    const checked = parseStrictRuntimeParams("session.send", JSON.parse(JSON.stringify(params)));
    if (!checked.idempotencyKey || "replayOnly" in checked)
      throw Error("原始发送请求缺少有效的幂等 key。");
    const record: PendingSendRecord = freeze({
      version: 1,
      scope: { ...scope },
      generation: crypto.randomUUID(),
      params: checked,
      draftSnapshot,
    });
    // No fallback to memory: a failed write must prevent the RPC.
    this.storage.setItem(key, JSON.stringify(record));
    return this.dispatch(record, false, dispatch, changed);
  }

  async recover(
    scope: PendingSendScope,
    supported: boolean,
    dispatch: Send,
    changed: () => void = () => {},
  ) {
    if (!supported)
      throw Error(
        "当前 Runtime 不支持恢复发送结果，请更新 Pico；原请求可能已经执行，待确认记录已保留。",
      );
    const current = this.get(scope);
    if (current?.kind !== "pending") throw Error(current?.reason ?? "没有可恢复的发送记录。");
    return this.dispatch(current.record, true, dispatch, changed);
  }

  private async dispatch(
    record: PendingSendRecord,
    replay: boolean,
    dispatch: Send,
    changed: () => void,
  ) {
    const key = storageKey(record.scope);
    if (this.locks.has(key)) throw Error("正在确认发送结果，请稍候。");
    this.locks.add(key);
    changed();
    try {
      const params = replay
        ? parseStrictRuntimeParams("session.send", { ...record.params, replayOnly: true })
        : record.params;
      const value = await dispatch(params);
      return { value, record, confirmed: this.complete(record) };
    } catch (cause) {
      // A rejection of recovery cannot prove that the original attempt did not execute.
      if (!replay && (cause as { outcome?: unknown })?.outcome === "not_executed")
        this.complete(record);
      throw cause;
    } finally {
      this.locks.delete(key);
      changed();
    }
  }
}
