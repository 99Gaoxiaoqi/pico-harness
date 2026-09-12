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
import { ensurePicoRuntimeHostShutdownOperationRegistered } from "../../src/daemon/index.js";

ensurePicoRuntimeHostShutdownOperationRegistered();

const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
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
  if (!owner) process.exit(2);
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
  const request = (await transport.read(0)) as { operation?: unknown };
  if (request.operation !== "runtime.shutdown") throw new Error("expected runtime.shutdown");

  // Deliberately violate the current response-flushed shutdown contract. The client must
  // propagate this EOF and must not infer success from the connection disappearing.
  transport.destroy();
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
}
