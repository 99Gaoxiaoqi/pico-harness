import type { RuntimeOwnerFence } from "@pico/storage";
import { EngineRuntimeCapabilityOwner } from "./runtime-capability-owner.js";

/**
 * Opaque durable authority carried by a live Runtime Session.
 *
 * Runtime deliberately does not name the backing store here: the concrete
 * SQLite authority remains an outer Storage/Host implementation detail.
 */
export type EngineRuntimeAuthority = object;

const engineRuntimeCapabilityBrand: unique symbol = Symbol("EngineRuntimeCapability");
const issuedEngineRuntimeCapabilities = new WeakSet<object>();

/** The narrow write capability required by a live canonical run. */
export interface EngineRuntimeWriteGuard {
  /** Bind issuance to the durable authority actually owned by this guard. */
  assertRuntimeEventAuthority(authority: EngineRuntimeAuthority): void;
  assertRuntimeEventWriteAllowed(): Promise<RuntimeOwnerFence>;
}

/**
 * An exact-identity capability, rather than a structural bag of session data.
 *
 * The legacy `Engine` prefix is intentionally retained: it is a public
 * compatibility name used by the ReAct adapter while ownership has moved to
 * Runtime.
 */
export interface EngineRuntimeCapability {
  readonly [engineRuntimeCapabilityBrand]: true;
  readonly sessionId: string;
  readonly workDir: string;
  readonly runtimeAuthority: EngineRuntimeAuthority;
  readonly writeGuard: EngineRuntimeWriteGuard;
  assertBound(scope: EngineRuntimeCapability): void;
}

export interface EngineRuntimeCapabilityInput {
  readonly owner: EngineRuntimeCapabilityOwner;
  readonly runtimeAuthority: EngineRuntimeAuthority;
}

/** Issue an exact-identity capability that cannot be recreated by object spread. */
export function createEngineRuntimeCapability(
  input: EngineRuntimeCapabilityInput,
): EngineRuntimeCapability {
  if (!EngineRuntimeCapabilityOwner.isOwner(input.owner)) {
    throw new Error("Runtime capability owner must be an actual Session");
  }
  const sessionId = input.owner.id;
  const workDir = input.owner.workDir;
  const assertAuthority = (): void => {
    input.owner.assertRuntimeEventAuthority(input.runtimeAuthority);
  };
  assertAuthority();
  const capability: EngineRuntimeCapability = Object.freeze({
    [engineRuntimeCapabilityBrand]: true as const,
    sessionId,
    workDir,
    runtimeAuthority: input.runtimeAuthority,
    writeGuard: input.owner,
    assertBound: (scope: EngineRuntimeCapability): void => {
      if (scope !== capability) {
        throw new Error(`Runtime capability is not bound to Session ${sessionId}`);
      }
      assertAuthority();
    },
  });
  issuedEngineRuntimeCapabilities.add(capability);
  return capability;
}

/** Runtime adapters must reject structural lookalikes before using their authority. */
export function assertIssuedEngineRuntimeCapability(capability: EngineRuntimeCapability): void {
  if (!issuedEngineRuntimeCapabilities.has(capability)) {
    throw new Error(`Runtime capability for Session ${capability.sessionId} was not issued`);
  }
  capability.assertBound(capability);
}
