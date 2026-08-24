import type { RuntimeOwnerFence } from "../storage/runtime-event-store-contracts.js";

/**
 * Nominal Engine owner accepted by Runtime capability issuance.
 *
 * Keeping the private brand outside Session lets runtime-port validate an actual
 * owner without loading the concrete Session module at runtime.
 */
export abstract class EngineRuntimeCapabilityOwner {
  #engineRuntimeCapabilityOwnerBrand = true;

  static isOwner(value: unknown): value is EngineRuntimeCapabilityOwner {
    return (
      typeof value === "object" && value !== null && #engineRuntimeCapabilityOwnerBrand in value
    );
  }

  abstract readonly id: string;
  abstract readonly workDir: string;

  abstract assertRuntimeEventAuthority(authority: object): void;
  abstract assertRuntimeEventWriteAllowed(): Promise<RuntimeOwnerFence>;
}
