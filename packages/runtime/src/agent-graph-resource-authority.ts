import { graphResourceIdFor } from "@pico/core/agent-graph-identities";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphResourceRefRecord,
} from "@pico/core/agent-graph-store-contracts";
import type {
  AgentGraphResourceAuthorityPort,
  RetainAgentGraphOutputResourcesInput,
} from "@pico/core/agent-graph-resource-contracts";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";

export type {
  AgentGraphResourceAuthorityPort,
  RetainAgentGraphOutputResourcesInput,
} from "@pico/core/agent-graph-resource-contracts";

export interface AgentGraphResourceAuthorityOptions {
  readonly storageRoot: string;
  readonly store: SqliteAgentGraphControlStore;
}

/** Validates external resources and converts them into restart-safe Graph facts. */
export class AgentGraphResourceAuthority implements AgentGraphResourceAuthorityPort {
  private readonly artifacts: SqliteSessionWorkbarRepository;

  constructor(private readonly options: AgentGraphResourceAuthorityOptions) {
    this.artifacts = new SqliteSessionWorkbarRepository({ storageRoot: options.storageRoot });
  }

  async retainOutputResources(
    input: RetainAgentGraphOutputResourcesInput,
  ): Promise<readonly AgentGraphResourceRefRecord[]> {
    const retained: AgentGraphResourceRefRecord[] = [];
    if (input.evidenceRefs.length > 0) {
      throw new Error(
        "agent_output 的 evidence_refs 已退役；请将来源与读取结果写入 output，制品使用 artifact_refs。",
      );
    }
    for (const sourceRef of input.artifactRefs) {
      retained.push(this.retainArtifact(input.claim, sourceRef));
    }
    return retained;
  }

  listClaimResources(claimId: string): readonly AgentGraphResourceRefRecord[] {
    return this.options.store.listResourceRefsByClaim(claimId);
  }

  private retainArtifact(
    claim: AgentGraphActivationClaimRecord,
    sourceRef: string,
  ): AgentGraphResourceRefRecord {
    let reference;
    try {
      reference = parseAgentGraphArtifactRef(sourceRef);
    } catch {
      throw new Error(
        "agent_output 的 artifact_refs 必须使用已提交制品返回的 pico://artifact/<sessionId>/<artifactId>/<digest> URI，不能填文件路径。没有制品 URI 时，请省略 artifact_refs 或传 []。",
      );
    }
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
