import {
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
} from "../control/root-authority.js";
import { RuntimeHostKernel } from "./host-kernel.js";

export interface RuntimeHostCandidateOptions {
  rootPath: string;
  expectedRootId: string;
  legacyConfigurationRoot?: string;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  operationDeadlineMs?: number;
}

export type RuntimeHostCandidateResult =
  | { kind: "loser" }
  | { kind: "winner"; host: RuntimeHostKernel };

export async function startRuntimeHostCandidate(
  options: RuntimeHostCandidateOptions,
): Promise<RuntimeHostCandidateResult> {
  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: "interactive",
    expectedRootId: options.expectedRootId,
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) return { kind: "loser" };
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: options.idleGraceMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    operationDeadlineMs: options.operationDeadlineMs,
  });
  return { kind: "winner", host };
}
