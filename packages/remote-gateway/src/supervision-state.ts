import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { withFileLock } from "@pico/storage/local-file-storage";
import { ensureGatewayHome, isErrno, readPrivateJson, writePrivateJson } from "./state.js";

export interface GatewayExit {
  readonly at: number;
  readonly code?: number | null;
  readonly signal?: string | null;
  readonly buildId?: string;
}
export interface GatewayServiceState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly desiredRunning: boolean;
  readonly maintenance?: { readonly generation: number; readonly expiresAt: number; readonly buildId?: string };
  readonly lastExit?: GatewayExit;
}
export interface ActiveGatewayRuntime {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly executablePath: string;
  readonly gatewayPath: string;
  readonly runtimeHome: string;
  readonly pathEntries: readonly string[];
  readonly shellPath?: string;
}
const initialState = (): GatewayServiceState => ({ schemaVersion: 1, generation: 0, desiredRunning: false });

/** Reuse the repository's heartbeat-backed cross-process lease for short atomic state transitions. */
async function locked<T>(home: string, action: (canonicalHome: string) => Promise<T>): Promise<T> {
  const canonical = await ensureGatewayHome(home);
  return withFileLock(join(canonical, "service-state.lock"), `${process.pid}:${randomUUID()}`, () => action(canonical), { timeoutMs: 15_000 });
}
function validateState(value: GatewayServiceState): GatewayServiceState {
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0 || typeof value.desiredRunning !== "boolean" ||
      (value.maintenance && (value.maintenance.generation !== value.generation || !Number.isFinite(value.maintenance.expiresAt))))
    throw new Error("GATEWAY_SERVICE_STATE_INVALID");
  return value;
}
async function load(home: string, legacyPreferencePath?: string): Promise<GatewayServiceState> {
  const path = join(home, "service-state.json");
  let state = await readPrivateJson<GatewayServiceState>(path);
  if (!state) {
    let enabled = false;
    if (legacyPreferencePath) {
      try { enabled = (JSON.parse(await readFile(legacyPreferencePath, "utf8")) as { enabled?: unknown }).enabled === true; }
      catch (error) { if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError)) throw error; }
    }
    state = { ...initialState(), desiredRunning: enabled };
    await writePrivateJson(path, state);
  }
  validateState(state);
  if (state.maintenance && state.maintenance.expiresAt <= Date.now()) {
    const { maintenance: _expired, ...rest } = state;
    state = { ...rest, generation: state.generation + 1 };
    await writePrivateJson(path, state);
  }
  return state;
}
export function readGatewayServiceState(home: string, legacyPreferencePath?: string): Promise<GatewayServiceState> {
  return locked(home, (canonical) => load(canonical, legacyPreferencePath));
}
export function setGatewayDesiredRunning(home: string, desiredRunning: boolean): Promise<GatewayServiceState> {
  return locked(home, async (canonical) => {
    const current = await load(canonical);
    const { maintenance: _maintenance, ...rest } = current;
    const next: GatewayServiceState = { ...rest, generation: current.generation + 1, desiredRunning };
    await writePrivateJson(join(canonical, "service-state.json"), next);
    return next;
  });
}
export function beginGatewayMaintenance(home: string, buildId?: string, durationMs = 300_000): Promise<GatewayServiceState> {
  return locked(home, async (canonical) => {
    const current = await load(canonical);
    const generation = current.generation + 1;
    const next: GatewayServiceState = { ...current, generation, maintenance: { generation, expiresAt: Date.now() + Math.max(1, Math.min(durationMs, 300_000)), ...(buildId ? { buildId } : {}) } };
    await writePrivateJson(join(canonical, "service-state.json"), next);
    return next;
  });
}
/** Clear only the update's own generation. Never re-enable a subsequent stop. */
export function finishGatewayMaintenance(home: string, generation: number): Promise<boolean> {
  return locked(home, async (canonical) => {
    const current = await load(canonical);
    if (current.generation !== generation || current.maintenance?.generation !== generation) return false;
    const { maintenance: _maintenance, ...rest } = current;
    await writePrivateJson(join(canonical, "service-state.json"), { ...rest, generation: generation + 1 });
    return true;
  });
}
export function recordGatewayExit(home: string, lastExit: GatewayExit): Promise<void> {
  return locked(home, async (canonical) => {
    const current = await load(canonical);
    await writePrivateJson(join(canonical, "service-state.json"), { ...current, lastExit });
  });
}
export function validateActiveGatewayRuntime(value: ActiveGatewayRuntime): ActiveGatewayRuntime {
  if (value.schemaVersion !== 1 || !value.buildId || ![value.executablePath, value.gatewayPath, value.runtimeHome].every(isAbsolute) ||
      !Array.isArray(value.pathEntries) || value.pathEntries.some((path) => !isAbsolute(path) || /[\0\r\n]/u.test(path)) ||
      (value.shellPath !== undefined && (!isAbsolute(value.shellPath) || /[\0\r\n]/u.test(value.shellPath))))
    throw new Error("GATEWAY_ACTIVE_RUNTIME_INVALID");
  return value;
}
export async function readActiveGatewayRuntime(home: string): Promise<ActiveGatewayRuntime | undefined> {
  const canonical = await ensureGatewayHome(home);
  const value = await readPrivateJson<ActiveGatewayRuntime>(join(canonical, "active-runtime.json"));
  return value ? validateActiveGatewayRuntime(value) : undefined;
}
export async function writeActiveGatewayRuntime(home: string, value: ActiveGatewayRuntime): Promise<void> {
  const canonical = await ensureGatewayHome(home);
  await writePrivateJson(join(canonical, "active-runtime.json"), validateActiveGatewayRuntime(value));
}
