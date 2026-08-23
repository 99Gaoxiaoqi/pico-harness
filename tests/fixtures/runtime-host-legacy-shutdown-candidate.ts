import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import {
  FramedTransport,
  parseRuntimeHostCandidateArguments,
  prepareRuntimeHostEndpoint,
  removeHostRegistration,
  resolveExistingStorageRoot,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_KIND,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  tryAcquireInteractiveRootOwner,
  writeHostRegistration,
  type InteractiveRootOwner,
  type RuntimeHostEndpoint,
} from "@pico/runtime-host";
import {
  ensurePicoRuntimeHostShutdownOperationRegistered,
  LocalDaemonInstanceLock,
  resolveLocalDaemonEndpoint,
} from "../../src/daemon/index.js";
import { OwnerLease } from "../../src/storage/owner-lease.js";

ensurePicoRuntimeHostShutdownOperationRegistered();

type LegacyShutdownMode = "eof-exit" | "eof-stay" | "response-exit" | "response-stay";

const mode = readMode(process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"]);

function readMode(value: string | undefined): LegacyShutdownMode {
  if (
    value !== "eof-exit" &&
    value !== "eof-stay" &&
    value !== "response-exit" &&
    value !== "response-stay"
  ) {
    throw new Error(
      "PICO_TEST_LEGACY_SHUTDOWN_MODE must be eof-exit, eof-stay, response-exit, or response-stay",
    );
  }
  return value;
}

const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
const legacyLock = await LocalDaemonInstanceLock.acquire({
  endpoint: resolveLocalDaemonEndpoint({ env: process.env }),
});
let owner: InteractiveRootOwner | undefined;
let endpoint: RuntimeHostEndpoint | undefined;
let server: Server | undefined;
let hostEpoch = "";
let closing = false;

try {
  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: "interactive",
    expectedRootId: options.expectedRootId,
  });
  owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) {
    await legacyLock.release();
    process.exit(2);
  }
  const sessionLeaseDirectory = process.env["PICO_TEST_LEGACY_SESSION_LEASE_DIRECTORY"];
  if (sessionLeaseDirectory) {
    // Deliberately abandon this fresh lease on process exit to reproduce daemons
    // that predate the SessionManager clearAndDrain shutdown fence.
    await OwnerLease.acquire({
      leaseDirectory: sessionLeaseDirectory,
      ownerId: "legacy-shutdown-fixture",
    });
  }
  hostEpoch = randomUUID();
  endpoint = await prepareRuntimeHostEndpoint({ rootId: capability.rootId, hostEpoch });
  server = createServer((socket) => {
    const transport = new FramedTransport(socket);
    void serveConnection(transport).catch(() => transport.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(endpoint!.path, resolve);
  });
  await endpoint.prepareAfterListen();
  await writeHostRegistration(owner.controlDirectory, {
    kind: RUNTIME_HOST_REGISTRATION_KIND,
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: capability.rootId,
    hostEpoch,
    endpoint: endpoint.path,
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    state: "ready",
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
} catch (error) {
  await cleanup();
  throw error;
}

process.once("SIGTERM", () => void cleanup().finally(() => process.exit(0)));
process.once("SIGINT", () => void cleanup().finally(() => process.exit(0)));

async function serveConnection(transport: FramedTransport): Promise<void> {
  const hello = (await transport.read(10_000)) as { kind?: unknown };
  if (hello.kind !== "hello") throw new Error("expected hello");
  await transport.write({
    kind: "accepted",
    hostEpoch,
    connectionId: randomUUID(),
    selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    state: "ready",
  });
  const request = (await transport.read(0)) as { requestId?: unknown; operation?: unknown };
  if (request.operation !== "runtime.shutdown") throw new Error("expected runtime.shutdown");
  if (typeof request.requestId !== "string") throw new Error("expected requestId");

  // 模拟两类升级前版本：接受关停后不回包即断连，或成功回包但不一定真正退出。
  if (mode.startsWith("response-")) {
    await transport.write({
      requestId: request.requestId,
      operation: "runtime.shutdown",
      ok: true,
      result: {},
    });
  }
  if (mode.startsWith("eof-")) transport.destroy();
  if (mode.endsWith("-exit")) {
    if (mode.startsWith("response-")) transport.destroyAfterFlush();
    await cleanup();
    process.exit(0);
  }
}

async function cleanup(): Promise<void> {
  if (closing) return;
  closing = true;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve())).catch(() => undefined);
  }
  if (owner && hostEpoch) {
    await removeHostRegistration(owner.controlDirectory, hostEpoch).catch(() => undefined);
  }
  await endpoint?.cleanup().catch(() => undefined);
  await owner?.close().catch(() => undefined);
  await legacyLock.release().catch(() => undefined);
}
