/**
 * 兼容旧 Storage 导入路径。codec 实现归属 @pico/storage；Engine 在
 * Transcript 位置保留更精确的展示层类型。
 */
import {
  assertRuntimeEvent as assertStorageRuntimeEvent,
  decodeRuntimeEvent as decodeStorageRuntimeEvent,
  decodeRuntimeEventJson as decodeStorageRuntimeEventJson,
} from "@pico/storage/runtime-event";
import type { RuntimeEvent } from "../engine/session-runtime-event.js";

export {
  RUNTIME_EVENT_DECODE_ERROR_CODES,
  RUNTIME_EVENT_KINDS,
  RUNTIME_EVENT_SCHEMA_VERSION,
  RuntimeEventDecodeError,
  RuntimeEventIntegrityError,
  isRuntimeMessageEvent,
  isRuntimeTerminalEvent,
  runtimeEventHasModelMessage,
} from "@pico/storage/runtime-event";
export type { RuntimeEventDecodeErrorCode } from "@pico/storage/runtime-event";
export type * from "../engine/session-runtime-event.js";

export function decodeRuntimeEvent(value: unknown): RuntimeEvent {
  return decodeStorageRuntimeEvent(value) as RuntimeEvent;
}

export function decodeRuntimeEventJson(raw: string): RuntimeEvent {
  return decodeStorageRuntimeEventJson(raw) as RuntimeEvent;
}

export function assertRuntimeEvent(value: unknown): asserts value is RuntimeEvent {
  assertStorageRuntimeEvent(value);
}
