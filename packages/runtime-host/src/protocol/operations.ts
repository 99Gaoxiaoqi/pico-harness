import { requireExactRecord, requireId, requireRecord, requireString } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { HOST_BOOTSTRAP_OPERATION_SPECS } from './host-status.js';
import {
  composeOperationSpecMaps,
  type AnyOperationSpec,
  type HostOperationError,
  type HostOperationErrorCode,
  type OperationSpec,
} from './operation-spec.js';

export type {
  HostDiagnosticsInput,
  HostDiagnosticsResult,
  HostLifecycleState,
  HostStatusInput,
  HostStatusResult,
} from './host-status.js';
export type {
  AnyOperationSpec,
  HostOperationError,
  HostOperationErrorCode,
} from './operation-spec.js';

// 3-A 骨架阶段只注册 bootstrap 操作（host.status / host.diagnostics.query）。
// 领域 operation spec（turn/session/plan/goal 等）在 3-B 接入 pico 业务时补齐。
export const HOST_OPERATION_SPECS = composeOperationSpecMaps(HOST_BOOTSTRAP_OPERATION_SPECS);

// 动态 spec 注册表：领域 operation spec 在运行时注册，而不必加宽静态 OperationKey
// 类型——静态面保持只有 bootstrap spec，机制层对业务零感知。3-B 起 pico 桥接的
// daemon 方法（workspace.status/usage.get 等）由 pico 侧经 registerHostOperationSpecs
// 注册；integration 测试同样用它注册测试 domain 操作。帧编解码、handler 组合与分发
// 一律通过 resolveOperationSpec/knownOperationKeys 解析，因此注册后的操作对 client
// 与 server 两侧同时生效。
const DYNAMIC_OPERATION_SPECS: Record<string, AnyOperationSpec> = {};

/**
 * Registers domain operation specs into the dynamic registry. Throws on a key that
 * collides with a static bootstrap spec or an already-registered spec. Registration
 * is process-global: call it once at process startup before starting a kernel or
 * connecting a client (both resolve specs through the same registry).
 */
export function registerHostOperationSpecs(specs: Record<string, AnyOperationSpec>): void {
  for (const [key, spec] of Object.entries(specs)) {
    if (isKnownOperationKey(key)) {
      throw new Error(`Duplicate Runtime Host operation key: ${key}`);
    }
    DYNAMIC_OPERATION_SPECS[key] = spec;
  }
}

/** Backward-compatible alias kept for existing integration tests. */
export const registerHostOperationSpecsForTesting = registerHostOperationSpecs;

export function knownOperationKeys(): readonly string[] {
  return [...Object.keys(HOST_OPERATION_SPECS), ...Object.keys(DYNAMIC_OPERATION_SPECS)];
}

export function resolveOperationSpec(key: string): AnyOperationSpec | undefined {
  if (Object.hasOwn(HOST_OPERATION_SPECS, key)) {
    return (HOST_OPERATION_SPECS as Record<string, AnyOperationSpec>)[key];
  }
  return DYNAMIC_OPERATION_SPECS[key];
}

function isKnownOperationKey(key: string): boolean {
  return Object.hasOwn(HOST_OPERATION_SPECS, key) || Object.hasOwn(DYNAMIC_OPERATION_SPECS, key);
}

export type OperationSpecMap = typeof HOST_OPERATION_SPECS;
export type OperationKey = keyof OperationSpecMap;

// 线上协议只有 bootstrap 两个操作；test-only 动态注册的操作在运行时加入
// spec 注册表（见 registerHostOperationSpecsForTesting），类型面用该 union 表达，
// 使帧/分发类型覆盖动态操作而不加宽生产 OperationKey。
export type KnownOperationKey = OperationKey | (string & {});

type KnownRequestFrameFor = {
  requestId: string;
  operation: KnownOperationKey;
  input: unknown;
};

type KnownResponseFrameFor =
  | {
      requestId: string;
      operation: KnownOperationKey;
      ok: true;
      result: unknown;
    }
  | {
      requestId: string;
      operation: KnownOperationKey;
      ok: false;
      error: HostOperationError<HostOperationErrorCode>;
    };

type InferInput<Spec> =
  Spec extends OperationSpec<infer Input, unknown, HostOperationErrorCode> ? Input : never;
type InferOutput<Spec> =
  Spec extends OperationSpec<unknown, infer Output, HostOperationErrorCode> ? Output : never;
type InferErrorCode<Spec> =
  Spec extends OperationSpec<unknown, unknown, infer ErrorCode> ? ErrorCode : never;

export type OperationInput<K extends OperationKey> = InferInput<OperationSpecMap[K]>;
export type OperationOutput<K extends OperationKey> = InferOutput<OperationSpecMap[K]>;
export type OperationError<K extends OperationKey> = HostOperationError<
  InferErrorCode<OperationSpecMap[K]>
>;

export type RequestFrameFor<K extends OperationKey> = {
  requestId: string;
  operation: K;
  input: OperationInput<K>;
};

export type ResponseFrameFor<K extends OperationKey> =
  | { requestId: string; operation: K; ok: true; result: OperationOutput<K> }
  | { requestId: string; operation: K; ok: false; error: OperationError<K> };

export type OperationOutcome<K extends OperationKey> =
  | { ok: true; result: OperationOutput<K> }
  | { ok: false; error: OperationError<K> };

export type RequestFrame =
  | {
      [K in OperationKey]: RequestFrameFor<K>;
    }[OperationKey]
  | KnownRequestFrameFor;
export type ResponseFrame =
  | {
      [K in OperationKey]: ResponseFrameFor<K>;
    }[OperationKey]
  | KnownResponseFrameFor;

export function decodeRequestFrame(value: unknown): RequestFrame {
  const frame = requireExactRecord(value, 'operation request', ['requestId', 'operation', 'input']);
  const requestId = requireId(frame.requestId, 'requestId');
  const operation = requireOperationKey(frame.operation);
  const spec = resolveOperationSpec(operation);
  if (!spec) throw invalidProtocolFrame('Unknown operation key');
  const input = spec.decodeInput(frame.input);
  return { requestId, operation, input } as RequestFrame;
}

export function decodeResponseFrame(value: unknown): ResponseFrame {
  const record = requireRecord(value, 'operation response');
  const requestId = requireId(record.requestId, 'requestId');
  const operation = requireOperationKey(record.operation);
  const outcome = decodeOperationOutcome(operation, omitResponseIdentity(record));
  return { requestId, operation, ...outcome } as ResponseFrame;
}

export function decodeOperationOutcome<K extends OperationKey>(
  operation: K,
  value: unknown,
): OperationOutcome<K> {
  const spec = resolveOperationSpec(operation);
  if (!spec) throw invalidProtocolFrame('Unknown operation key');
  const record = requireRecord(value, 'operation outcome');
  if (record.ok === true) {
    const exact = requireExactRecord(record, 'operation outcome', ['ok', 'result']);
    return {
      ok: true,
      result: spec.decodeOutput(exact.result),
    } as OperationOutcome<K>;
  }
  if (record.ok === false) {
    const exact = requireExactRecord(record, 'operation outcome', ['ok', 'error']);
    return {
      ok: false,
      error: decodeOperationError(exact.error, spec.errors),
    } as OperationOutcome<K>;
  }
  throw invalidProtocolFrame('Invalid operation outcome');
}

export function isOperationKey(value: unknown): value is OperationKey {
  return typeof value === 'string' && isKnownOperationKey(value);
}

function omitResponseIdentity(record: Record<string, unknown>): Record<string, unknown> {
  if (record.ok === true) {
    requireExactRecord(record, 'operation response', ['requestId', 'operation', 'ok', 'result']);
    return { ok: true, result: record.result };
  }
  if (record.ok === false) {
    requireExactRecord(record, 'operation response', ['requestId', 'operation', 'ok', 'error']);
    return { ok: false, error: record.error };
  }
  throw invalidProtocolFrame('Invalid operation response outcome');
}

function decodeOperationError<C extends HostOperationErrorCode>(
  value: unknown,
  allowedCodes: readonly C[],
): HostOperationError<C> {
  const record = requireExactRecord(value, 'operation error', ['code', 'message']);
  if (typeof record.code !== 'string' || !allowedCodes.includes(record.code as C)) {
    throw invalidProtocolFrame('Operation returned an undeclared error code');
  }
  return {
    code: record.code as C,
    message: requireString(record.message, 'operation error message', 1024),
  };
}

function requireOperationKey(value: unknown): OperationKey {
  if (!isOperationKey(value)) throw invalidProtocolFrame('Unknown operation key');
  return value;
}
