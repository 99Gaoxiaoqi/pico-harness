/**
 * @pico/runtime-host — Runtime Host kernel + connection skeleton.
 *
 * 3-A 骨架阶段：移植自 runtime-host 宿主模式的机制层（transport/control/protocol/
 * server/client + root-authority flock 选主）。不接 pico 业务——领域 operation
 * handler 通过 compositionFactory 在 3-B 注入。
 */

// control: endpoint / registration / storage-root authority
export {
  prepareRuntimeHostEndpoint,
  type RuntimeHostEndpoint,
} from "./control/endpoint.js";
export {
  readHostRegistration,
  removeHostRegistration,
  writeHostRegistration,
} from "./control/registration.js";
export {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  discoverMarkedStorageRoot,
  prepareStorageRootControlDirectory,
  resolveExistingStorageRoot,
  resolveExistingStorageRootControlDirectory,
  resolveStorageRoot,
  resolveRootControlNamespace,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
  type InteractiveRootReader,
  type StorageRootCapability,
  type StorageRootKind,
} from "./control/root-authority.js";

// transport
export { FramedTransport, RuntimeHostTransportError } from "./transport/framed-transport.js";

// protocol（裁剪版：核心帧 + bootstrap 操作）
export * from "./protocol/index.js";

// server
export { RuntimeHostKernel } from "./server/host-kernel.js";
export type {
  RuntimeHostComposition,
  RuntimeHostCompositionContext,
  RuntimeHostCompositionFactory,
  RuntimeHostKernelOptions,
} from "./server/host-kernel.js";
export {
  startRuntimeHostCandidate,
  type RuntimeHostCandidateOptions,
  type RuntimeHostCandidateResult,
} from "./server/candidate.js";
export { runRuntimeHostProcessLifecycle } from "./server/process-lifecycle.js";
export { parseRuntimeHostCandidateArguments } from "./candidate-cli.js";

// client
export {
  connectExistingRuntimeHost,
  connectResolvedRuntimeHost,
  connectRuntimeHost,
  RuntimeHostOperationError,
  type ConnectRuntimeHostResult,
  type RuntimeHostConnection,
  type RuntimeHostUnavailableReason,
} from "./client/connection.js";
export {
  connectOrSpawnRuntimeHost,
  connectOrSpawnRuntimeHostWithDependencies,
  type ConnectOrSpawnRuntimeHostInput,
  type ConnectOrSpawnRuntimeHostResult,
} from "./client/connect-or-spawn.js";
