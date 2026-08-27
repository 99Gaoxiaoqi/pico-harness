import {
  EvidenceArchive,
  formatEvidenceUri,
  parseEvidenceUri,
} from "../context/evidence-archive.js";
import { graphResourceIdFor } from "../agent-graph/core/ids.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphResourceRefRecord,
} from "../storage/sqlite/agent-graph-store-types.js";
import { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";
import { SqliteSessionWorkbarRepository } from "../storage/sqlite/sqlite-session-workbar-repository.js";

export interface RetainAgentGraphOutputResourcesInput {
  readonly claim: AgentGraphActivationClaimRecord;
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
}

export interface AgentGraphResourceAuthorityPort {
  retainOutputResources(
    input: RetainAgentGraphOutputResourcesInput,
  ): Promise<readonly AgentGraphResourceRefRecord[]>;
  listClaimResources(claimId: string): readonly AgentGraphResourceRefRecord[];
}

export interface AgentGraphResourceAuthorityOptions {
  readonly storageRoot: string;
  readonly evidenceBaseDir: string;
  readonly store: SqliteAgentGraphControlStore;
}

/** Validates external resources and converts them into restart-safe Graph facts. */
export class AgentGraphResourceAuthority implements AgentGraphResourceAuthorityPort {
  private readonly artifacts: SqliteSessionWorkbarRepository;
  private readonly evidence: EvidenceArchive;

  constructor(private readonly options: AgentGraphResourceAuthorityOptions) {
    this.artifacts = new SqliteSessionWorkbarRepository({ storageRoot: options.storageRoot });
    this.evidence = new EvidenceArchive({
      baseDir: options.evidenceBaseDir,
      storageRoot: options.storageRoot,
    });
  }

  async retainOutputResources(
    input: RetainAgentGraphOutputResourcesInput,
  ): Promise<readonly AgentGraphResourceRefRecord[]> {
    const retained: AgentGraphResourceRefRecord[] = [];
    for (const sourceRef of input.evidenceRefs) {
      retained.push(await this.retainEvidence(input.claim, sourceRef));
    }
    for (const sourceRef of input.artifactRefs) {
      retained.push(this.retainArtifact(input.claim, sourceRef));
    }
    return retained;
  }

  listClaimResources(claimId: string): readonly AgentGraphResourceRefRecord[] {
    return this.options.store.listResourceRefsByClaim(claimId);
  }

  private async retainEvidence(
    claim: AgentGraphActivationClaimRecord,
    sourceRef: string,
  ): Promise<AgentGraphResourceRefRecord> {
    const reference = parseEvidenceUri(sourceRef);
    if (
      reference.sessionId !== claim.targetSessionId ||
      formatEvidenceUri(reference) !== sourceRef
    ) {
      throw new Error(`Graph evidence ref must belong to activation Session: ${sourceRef}`);
    }
    const page = await this.evidence.readEvidencePage(reference, { limitBytes: 1 });
    const blob =
      page.kind === "tool-exchange"
        ? (await this.evidence.readRuntimeToolExchange({ ...reference, kind: "tool-exchange" }))
            .content.rawOutput
        : (
            await this.evidence.readSubagentReportEvidence({
              ...reference,
              kind: "subagent-report",
            })
          ).content.report;
    if (blob.sizeBytes !== page.totalBytes) {
      throw new Error(`Graph evidence size does not match its manifest: ${sourceRef}`);
    }
    return this.options.store.putResourceRef({
      resourceId: graphResourceIdFor(claim.graphId, claim.claimId, "evidence", sourceRef),
      graphId: claim.graphId,
      claimId: claim.claimId,
      kind: "evidence",
      sourceRef,
      sourceSessionId: claim.targetSessionId,
      sourceResourceId: reference.contentHash,
      contentDigest: blob.digest,
      contentBytes: blob.sizeBytes,
      mediaType: "text/plain; charset=utf-8",
      metadata: {
        schemaVersion: reference.schemaVersion,
        contentHash: reference.contentHash,
        evidenceKind: page.kind,
      },
    }).record;
  }

  private retainArtifact(
    claim: AgentGraphActivationClaimRecord,
    sourceRef: string,
  ): AgentGraphResourceRefRecord {
    const reference = parseAgentGraphArtifactRef(sourceRef);
    if (reference.sessionId !== claim.targetSessionId) {
      throw new Error(`Graph artifact ref must belong to activation Session: ${sourceRef}`);
    }
    const artifact = this.artifacts.queryArtifacts({
      sessionId: reference.sessionId,
      artifactId: reference.artifactId,
    }).artifacts[0]!;
    if (artifact.digest !== reference.digest) {
      throw new Error(`Graph artifact digest does not match committed artifact: ${sourceRef}`);
    }
    const firstPage = this.artifacts.readArtifactChunk({
      sessionId: reference.sessionId,
      artifactId: reference.artifactId,
      limitBytes: 1,
    });
    if (firstPage.totalBytes !== artifact.sizeBytes) {
      throw new Error(`Graph artifact size does not match committed blob: ${sourceRef}`);
    }
    return this.options.store.putResourceRef({
      resourceId: graphResourceIdFor(claim.graphId, claim.claimId, "artifact", sourceRef),
      graphId: claim.graphId,
      claimId: claim.claimId,
      kind: "artifact",
      sourceRef,
      sourceSessionId: claim.targetSessionId,
      sourceResourceId: artifact.artifactId,
      contentDigest: artifact.digest,
      contentBytes: artifact.sizeBytes,
      mediaType: artifact.mimeType,
      title: artifact.title,
      metadata: { artifactUpdatedAt: artifact.updatedAt },
    }).record;
  }
}

export interface AgentGraphArtifactReference {
  readonly sessionId: string;
  readonly artifactId: string;
  readonly digest: string;
}

export function formatAgentGraphArtifactRef(reference: AgentGraphArtifactReference): string {
  assertReferencePart(reference.sessionId, "artifact sessionId");
  assertReferencePart(reference.artifactId, "artifactId");
  assertDigest(reference.digest);
  return `pico://artifact/${encodeURIComponent(reference.sessionId)}/${encodeURIComponent(reference.artifactId)}/${reference.digest}`;
}

export function parseAgentGraphArtifactRef(value: string): AgentGraphArtifactReference {
  const match = /^pico:\/\/artifact\/([^/]+)\/([^/]+)\/([a-f0-9]{64})$/u.exec(value);
  if (!match) throw new Error(`Graph artifact ref is invalid: ${value}`);
  let sessionId: string;
  let artifactId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
    artifactId = decodeURIComponent(match[2]!);
  } catch {
    throw new Error(`Graph artifact ref has invalid encoding: ${value}`);
  }
  const reference = { sessionId, artifactId, digest: match[3]! };
  if (formatAgentGraphArtifactRef(reference) !== value) {
    throw new Error(`Graph artifact ref is not canonical: ${value}`);
  }
  return reference;
}

function assertReferencePart(value: string, name: string): void {
  if (!value || value.trim() !== value || /\p{Cc}/u.test(value)) {
    throw new Error(`${name} must be an exact non-empty identity`);
  }
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("artifact digest must be a lowercase SHA-256 digest");
  }
}
