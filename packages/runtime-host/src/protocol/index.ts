import { TextDecoder } from 'node:util';
import { requireCount, requireId, requireRecord, requireShapedRecord, requireString } from './codec.js';
import { invalidProtocolFrame, RuntimeHostProtocolError } from './errors.js';
import { requireHostLifecycleState } from './host-status.js';
import {
  decodeRequestFrame,
  decodeResponseFrame,
  type HostLifecycleState,
  type RequestFrame,
  type ResponseFrame,
} from './operations.js';

export { RuntimeHostProtocolError, invalidProtocolFrame } from './errors.js';
export * from './codec.js';
export * from './host-status.js';
export * from './operations.js';
export { defineOperation, composeOperationSpecMaps } from './operation-spec.js';
export type { OperationSpec } from './operation-spec.js';

export const RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION = 1 as const;
export const RUNTIME_HOST_PROTOCOL_VERSION = 0 as const;
// The wire version remains v0 before the first release. This independent epoch
// lets a new Client retire a stale same-version Host whose closed schema is no
// longer safe to use.
export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 1 as const;
// 帧上限对齐 daemon IPC 的 1MiB（3-B-3 硬切后所有 daemon 方法结果都走本协议，
// transcript/会话历史类大结果不能被控制面级小帧卡死）。队列字节上限随之放大
// （writer/transport 各 8MB = 8 满帧余量）。
export const RUNTIME_HOST_MAX_FRAME_BYTES = 1024 * 1024;
export const RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS = 64;

export const RUNTIME_HOST_REGISTRATION_KIND = 'pico-runtime-host' as const;

export type ClientSurface = 'desktop' | 'tui' | 'run' | 'activation' | 'bot' | 'inspect';

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface ClientHello {
  kind: 'hello';
  clientInstanceId: string;
  surface: ClientSurface;
  protocolMin: number;
  protocolMax: number;
  /** A missing pre-epoch v0 wire field is decoded as epoch 0. */
  compatibilityEpoch: number;
}

export interface HostAccepted {
  kind: 'accepted';
  hostEpoch: string;
  connectionId: string;
  selectedProtocol: number;
  /** A missing pre-epoch v0 wire field is decoded as epoch 0. */
  compatibilityEpoch: number;
  state: Exclude<HostLifecycleState, 'draining'>;
}

export interface HostIncompatible {
  kind: 'incompatible';
  hostEpoch: string;
  protocolMin: number;
  protocolMax: number;
  /** A missing pre-epoch v0 wire field is decoded as epoch 0. */
  compatibilityEpoch: number;
  state: HostLifecycleState;
  replacement: 'blocked_by_residency' | 'wait_for_idle_exit';
}

export interface HostDraining {
  kind: 'draining';
  hostEpoch: string;
}

export type HostHandshakeResult = HostAccepted | HostIncompatible | HostDraining;

/**
 * Host-initiated push frame (3-B-2): the only post-handshake frame the Host may emit
 * outside a request/response exchange. The payload is an opaque JSON record — the
 * mechanism layer deliberately does not model domain event shapes; the bridging
 * composition validates them before pushing and the consuming client after decoding.
 */
export interface HostEventFrame {
  kind: 'event';
  event: Record<string, unknown>;
}

// 3-A 骨架 + 3-B-2 事件推送：订阅确认走订阅操作的普通 response；客户端能力 /
// 配置变更 / 会话目录变更帧（3-C 接入业务时）仍缺。
export type ClientFrame = ClientHello | RequestFrame;
export type HostFrame = HostHandshakeResult | ResponseFrame | HostEventFrame;

export interface HostRegistration {
  kind: typeof RUNTIME_HOST_REGISTRATION_KIND;
  schemaVersion: typeof RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION;
  rootId: string;
  hostEpoch: string;
  endpoint: string;
  protocolMin: number;
  protocolMax: number;
  /** A missing pre-epoch v0 registration field is decoded as epoch 0. */
  compatibilityEpoch: number;
  state: HostLifecycleState;
  pid: number;
  createdAt: string;
}

export function negotiateProtocol(client: ProtocolRange, host: ProtocolRange): number | undefined {
  validateProtocolRange(client);
  validateProtocolRange(host);
  const selected = Math.min(client.max, host.max);
  return selected >= Math.max(client.min, host.min) ? selected : undefined;
}

export function validateProtocolRange(range: ProtocolRange): void {
  if (
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw invalidProtocolFrame('Invalid protocol range');
  }
}

export function requireClientInstanceId(value: unknown): string {
  return requireId(value, 'clientInstanceId');
}

export function decodeClientFrame(value: unknown): ClientFrame {
  const frame = requireRecord(value, 'client frame');
  if (frame.kind === 'hello') {
    requireShapedRecord(
      frame,
      'hello frame',
      ['kind', 'clientInstanceId', 'surface', 'protocolMin', 'protocolMax'],
      ['compatibilityEpoch'],
    );
    const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
    const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
    validateProtocolRange({ min: protocolMin, max: protocolMax });
    return {
      kind: 'hello',
      clientInstanceId: requireClientInstanceId(frame.clientInstanceId),
      surface: requireSurface(frame.surface),
      protocolMin,
      protocolMax,
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
    } satisfies ClientHello;
  }
  return decodeRequestFrame(frame);
}

export function decodeHostFrame(value: unknown): HostFrame {
  const frame = requireRecord(value, 'host frame');
  if (frame.kind === 'accepted') {
    requireShapedRecord(
      frame,
      'accepted frame',
      ['kind', 'hostEpoch', 'connectionId', 'selectedProtocol', 'state'],
      ['compatibilityEpoch'],
    );
    return {
      kind: 'accepted',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      connectionId: requireId(frame.connectionId, 'connectionId'),
      selectedProtocol: requireProtocolVersion(frame.selectedProtocol, 'selectedProtocol'),
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
      state: requireAcceptedState(frame.state),
    } satisfies HostAccepted;
  }
  if (frame.kind === 'incompatible') {
    requireShapedRecord(
      frame,
      'incompatible frame',
      ['kind', 'hostEpoch', 'protocolMin', 'protocolMax', 'state', 'replacement'],
      ['compatibilityEpoch'],
    );
    const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
    const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
    validateProtocolRange({ min: protocolMin, max: protocolMax });
    return {
      kind: 'incompatible',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      protocolMin,
      protocolMax,
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
      state: requireHostLifecycleState(frame.state),
      replacement: requireReplacement(frame.replacement),
    } satisfies HostIncompatible;
  }
  if (frame.kind === 'draining') {
    requireShapedRecord(frame, 'draining frame', ['kind', 'hostEpoch'], []);
    return {
      kind: 'draining',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
    };
  }
  if (frame.kind === 'event') {
    requireShapedRecord(frame, 'event frame', ['kind', 'event'], []);
    return {
      kind: 'event',
      event: requireRecord(frame.event, 'event frame payload'),
    };
  }
  return decodeResponseFrame(frame);
}

export function decodeHostRegistration(value: unknown): HostRegistration {
  const registration = requireShapedRecord(
    value,
    'host registration',
    [
      'kind',
      'schemaVersion',
      'rootId',
      'hostEpoch',
      'endpoint',
      'protocolMin',
      'protocolMax',
      'state',
      'pid',
      'createdAt',
    ],
    ['compatibilityEpoch'],
  );
  if (registration.kind !== RUNTIME_HOST_REGISTRATION_KIND) {
    throw invalidProtocolFrame('Invalid registration kind');
  }
  if (registration.schemaVersion !== RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported registration schema');
  }
  const protocolMin = requireProtocolVersion(registration.protocolMin, 'protocolMin');
  const protocolMax = requireProtocolVersion(registration.protocolMax, 'protocolMax');
  validateProtocolRange({ min: protocolMin, max: protocolMax });
  const rootId = requireString(registration.rootId, 'rootId', 128);
  if (!/^[a-f0-9]{64}$/.test(rootId)) throw invalidProtocolFrame('Invalid rootId');
  const pid = requireCount(registration.pid, 'pid');
  if (pid === 0) throw invalidProtocolFrame('Invalid pid');
  return {
    kind: RUNTIME_HOST_REGISTRATION_KIND,
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId,
    hostEpoch: requireId(registration.hostEpoch, 'hostEpoch'),
    endpoint: requireString(registration.endpoint, 'endpoint', 512),
    protocolMin,
    protocolMax,
    compatibilityEpoch:
      registration.compatibilityEpoch === undefined
        ? 0
        : requireCompatibilityEpoch(registration.compatibilityEpoch),
    state: requireHostLifecycleState(registration.state),
    pid,
    createdAt: requireString(registration.createdAt, 'createdAt', 64),
  };
}

export function encodeProtocolFrame(value: ClientFrame | HostFrame): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (encoded.byteLength > RUNTIME_HOST_MAX_FRAME_BYTES) {
    throw new RuntimeHostProtocolError(
      'frame_too_large',
      'Runtime Host frame exceeds the byte limit',
    );
  }
  return encoded;
}

export class ProtocolFrameDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const segment = Buffer.from(chunk.subarray(offset, end));
      const delimiterBytes = newline === -1 ? 0 : 1;
      if (
        this.#pending.byteLength + segment.byteLength + delimiterBytes >
        RUNTIME_HOST_MAX_FRAME_BYTES
      ) {
        throw new RuntimeHostProtocolError(
          'frame_too_large',
          'Runtime Host frame exceeds the byte limit',
        );
      }
      if (segment.byteLength > 0) this.#pending = Buffer.concat([this.#pending, segment]);
      if (newline === -1) break;
      frames.push(this.#decodePending());
      this.#pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    return frames;
  }

  end(): void {
    if (this.#pending.byteLength !== 0) {
      throw new RuntimeHostProtocolError(
        'invalid_frame',
        'Runtime Host stream ended with a partial frame',
      );
    }
  }

  #decodePending(): unknown {
    if (this.#pending.byteLength === 0) {
      throw invalidProtocolFrame('Runtime Host frame is empty');
    }
    let text: string;
    try {
      const bytes = this.#pending.at(-1) === 0x0d ? this.#pending.subarray(0, -1) : this.#pending;
      text = this.#decoder.decode(bytes);
    } catch {
      throw new RuntimeHostProtocolError('invalid_utf8', 'Runtime Host frame is not valid UTF-8');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RuntimeHostProtocolError('invalid_json', 'Runtime Host frame is not valid JSON');
    }
  }
}

function requireProtocolVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}

function requireCompatibilityEpoch(value: unknown): number {
  const epoch = requireProtocolVersion(value, 'compatibilityEpoch');
  if (epoch > 1_000_000) throw invalidProtocolFrame('Invalid compatibilityEpoch');
  return epoch;
}

function decodeCompatibilityEpoch(value: unknown): number {
  return value === undefined ? 0 : requireCompatibilityEpoch(value);
}

function requireSurface(value: unknown): ClientSurface {
  if (
    value === 'desktop' ||
    value === 'tui' ||
    value === 'run' ||
    value === 'activation' ||
    value === 'bot' ||
    value === 'inspect'
  )
    return value;
  throw invalidProtocolFrame('Invalid surface');
}

function requireAcceptedState(value: unknown): Exclude<HostLifecycleState, 'draining'> {
  const state = requireHostLifecycleState(value);
  if (state === 'draining') throw invalidProtocolFrame('Accepted Host cannot be draining');
  return state;
}

function requireReplacement(value: unknown): HostIncompatible['replacement'] {
  if (value === 'blocked_by_residency' || value === 'wait_for_idle_exit') return value;
  throw invalidProtocolFrame('Invalid replacement disposition');
}
