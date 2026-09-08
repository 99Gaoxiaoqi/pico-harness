import type { JsonRecord } from "../model.js";

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function recordArray(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
