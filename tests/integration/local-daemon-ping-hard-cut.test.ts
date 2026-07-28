import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalRuntimeDaemon,
  pingLocalRuntimeDaemon,
  type DisposableLocalRuntimeService,
  type LocalDaemonEndpoint,
} from "../../src/daemon/index.js";
import {
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  type JsonValue,
} from "../../src/daemon/protocol.js";

test("singleton ping accepts only an authenticated current Runtime schema", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-ping-current-"));
  const endpoint = testEndpoint(root);
  let pingResult: JsonValue = currentPing(root);
  const daemon = new LocalRuntimeDaemon({
    endpoint,
    service: testService(() => pingResult),
  });
  context.after(async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });

  await daemon.start();
  assert.equal(await pingLocalRuntimeDaemon(endpoint), true);

  pingResult = { pong: true };
  assert.equal(await pingLocalRuntimeDaemon(endpoint), false);
});

test("singleton ping never probes a pre-authentication daemon", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-ping-pre-auth-"));
  const endpoint = testEndpoint(root);
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.end();
  });
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.address, resolve);
  });

  assert.equal(await pingLocalRuntimeDaemon(endpoint), false);
  assert.equal(connections, 0);
});

function testEndpoint(root: string): LocalDaemonEndpoint {
  return {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
}

function currentPing(picoHome: string): JsonValue {
  return {
    pong: true,
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    desktopSchemaRevision: DESKTOP_RUNTIME_SCHEMA_REVISION,
    capabilities: [DESKTOP_RUNTIME_SCHEMA_CAPABILITY, CAPABILITY_SCOPE_RUNTIME_CAPABILITY],
    picoHome,
  };
}

function testService(ping: () => JsonValue): DisposableLocalRuntimeService {
  return {
    handle: async (request) => (request.method === "runtime.ping" ? ping() : {}),
    replayEvents: async () => ({ events: [], hasMore: false }),
    subscribe: () => () => undefined,
    close: async () => undefined,
  };
}
