import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_PROPOSAL_TTL_MS = 5 * 60_000;
const MAX_PENDING_PROPOSALS = 32;

export interface AutomationCredentialProposalBinding {
  readonly routeId: string;
  readonly providerId: string;
  readonly credentialRef: string;
  readonly providerProtocol: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKeyEnv: string;
  readonly providerConfigFingerprint: string;
  readonly secret: string;
}

export interface AutomationCredentialProposal {
  readonly proposalId: string;
  readonly expiresAt: number;
}

export type AutomationCredentialProposalConsumption =
  | { readonly status: "accepted" }
  | { readonly status: "missing" | "expired" | "changed" };

interface StoredProposal {
  readonly expiresAt: number;
  readonly routeId: string;
  readonly providerId: string;
  readonly credentialRef: string;
  readonly authorityFingerprint: string;
  readonly secretFingerprint: string;
}

/**
 * Process-local, command-session scoped confirmation state. It deliberately
 * stores only authority metadata and keyed fingerprints, never credential text.
 */
export class AutomationCredentialImportProposalStore {
  readonly #now: () => number;
  readonly #createProposalId: () => string;
  readonly #ttlMs: number;
  readonly #fingerprintKey: Buffer;
  readonly #proposals = new Map<string, StoredProposal>();

  constructor(
    options: {
      readonly now?: () => number;
      readonly createProposalId?: () => string;
      readonly ttlMs?: number;
      readonly fingerprintKey?: Uint8Array;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#createProposalId = options.createProposalId ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new RangeError("Automation credential proposal ttlMs must be positive");
    }
    this.#fingerprintKey = Buffer.from(options.fingerprintKey ?? randomBytes(32));
    if (this.#fingerprintKey.byteLength < 16) {
      throw new RangeError("Automation credential proposal fingerprint key is too short");
    }
  }

  issue(binding: AutomationCredentialProposalBinding): AutomationCredentialProposal {
    const now = this.#now();
    this.#discardExpired(now);
    while (this.#proposals.size >= MAX_PENDING_PROPOSALS) {
      const oldest = this.#proposals.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#proposals.delete(oldest);
    }
    const proposalId = this.#createProposalId();
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(proposalId)) {
      throw new Error("Automation credential proposal id is invalid");
    }
    const expiresAt = now + this.#ttlMs;
    this.#proposals.set(proposalId, {
      expiresAt,
      routeId: binding.routeId,
      providerId: binding.providerId,
      credentialRef: binding.credentialRef,
      authorityFingerprint: authorityFingerprint(binding),
      secretFingerprint: this.#secretFingerprint(binding.secret),
    });
    return { proposalId, expiresAt };
  }

  /** Matching, expired, and changed proposals are consumed to prevent replay. */
  consume(
    proposalId: string,
    binding: AutomationCredentialProposalBinding,
  ): AutomationCredentialProposalConsumption {
    const proposal = this.#proposals.get(proposalId);
    if (!proposal) return { status: "missing" };
    this.#proposals.delete(proposalId);
    if (proposal.expiresAt <= this.#now()) return { status: "expired" };
    if (
      proposal.routeId !== binding.routeId ||
      proposal.providerId !== binding.providerId ||
      proposal.credentialRef !== binding.credentialRef ||
      proposal.authorityFingerprint !== authorityFingerprint(binding) ||
      !sameFingerprint(proposal.secretFingerprint, this.#secretFingerprint(binding.secret))
    ) {
      return { status: "changed" };
    }
    return { status: "accepted" };
  }

  #secretFingerprint(secret: string): string {
    return createHmac("sha256", this.#fingerprintKey).update(secret, "utf8").digest("hex");
  }

  #discardExpired(now: number): void {
    for (const [proposalId, proposal] of this.#proposals) {
      if (proposal.expiresAt <= now) this.#proposals.delete(proposalId);
    }
  }
}

function authorityFingerprint(binding: AutomationCredentialProposalBinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.routeId,
        binding.providerId,
        binding.credentialRef,
        binding.providerProtocol,
        binding.model,
        binding.baseURL,
        binding.apiKeyEnv,
        binding.providerConfigFingerprint,
      ]),
    )
    .digest("hex");
}

function sameFingerprint(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
