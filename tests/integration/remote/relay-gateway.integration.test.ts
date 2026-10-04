import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import {
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
  parseRuntimeResult,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";
import type { RemotePairingOffer } from "@pico/protocol/remote";
import {
  RemoteRuntimeClient,
  type RemoteSocket,
} from "../../../packages/remote-client/src/index.js";
import {
  createRemoteGateway,
  configureRelayGateway,
  readGatewayConfiguration,
  prepareRelayBinding,
  type GatewayRuntimeClient,
} from "../../../packages/remote-gateway/src/index.js";
import { loadRelayIdentity } from "../../../packages/remote-gateway/src/relay-config.js";
import { startRelayServer, requestRelayControl } from "../../../packages/remote-relay/src/index.js";
import { createTestTlsFixture } from "./tls-fixture.js";

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "状态未在预算内到达");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const setupMode of ["invitation", "prebound"] as const)
  test(
    `real Relay + gateway + mobile client preserve pairing, permission, event and unknown-outcome contracts (${setupMode})`,
    { timeout: 30_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "pico-relay-path-"));
      const gatewayHome = join(root, "gateway");
      const runtimeHome = join(root, "runtime");
      await mkdir(runtimeHome);
      await mkdir(join(root, "workspace"));
      const workspacePath = await realpath(join(root, "workspace"));
      await new WorkspaceRegistrationStore(join(runtimeHome, "daemon-workspaces.json")).register(
        workspacePath,
      );
      await new WorkspaceTrustStore({ userStateDirectory: runtimeHome }).trust(workspacePath);
      const tls = await createTestTlsFixture();
      const relayHome = join(root, "relay");
      const relay = await startRelayServer({
        home: relayHome,
        port: 0,
        tls: { cert: tls.cert, key: tls.key },
      });
      t.mock.method(globalThis, "fetch", tls.fetcher);
      const invitation =
        setupMode === "invitation"
          ? ((await requestRelayControl(relayHome, "invite", {})) as { invitation: string })
          : undefined;
      const input = {
        relayUrl: relay.origin,
        ...(invitation ? { invitation: invitation.invitation } : {}),
        workspaces: [{ path: workspacePath }],
        runtimeHostRootPath: runtimeHome,
      };
      if (setupMode === "prebound") {
        const binding = await prepareRelayBinding(input, gatewayHome);
        assert.deepEqual(
          await requestRelayControl(relayHome, "bind", {
            gatewayId: binding.gatewayId,
            tokenHash: binding.tokenHash,
          }),
          { version: 1, bound: true },
        );
      } else
        await assert.rejects(
          configureRelayGateway(
            { ...input, invitation: "invalid-invitation-" + "a".repeat(40) },
            gatewayHome,
          ),
          /拒绝注册/,
        );
      const config = await configureRelayGateway(input, gatewayHome);
      assert.ok(config.relay);
      const credentials = await loadRelayIdentity(gatewayHome, config.relay);
      assert.deepEqual(
        await configureRelayGateway(input, gatewayHome),
        config,
        "saving configuration does not rotate accepted token",
      );
      assert.deepEqual(await loadRelayIdentity(gatewayHome, config.relay), credentials);
      const replacementInvite =
        setupMode === "invitation"
          ? ((await requestRelayControl(relayHome, "invite", {})) as { invitation: string })
          : undefined;
      if (replacementInvite)
        await assert.rejects(
          configureRelayGateway(
            { ...input, invitation: replacementInvite.invitation },
            gatewayHome,
          ),
          /拒绝注册/,
        );
      assert.deepEqual(
        await loadRelayIdentity(gatewayHome, config.relay),
        credentials,
        "a rejected replacement preserves the active host token",
      );
      const summary = await readGatewayConfiguration(gatewayHome);
      assert.equal(summary.connectionMode, "relay");
      assert.ok(!JSON.stringify(summary).includes(credentials.token));
      assert.ok(!JSON.stringify(config).includes(credentials.secretKey));
      const session = {
        sessionId: "session-1",
        workspacePath,
        title: "relay private title",
        status: "active" as const,
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
      };
      let sends = 0;
      let disconnectRuntime: (() => void) | undefined;
      let interruptSend: (() => void) | undefined;
      const runtimes: GatewayRuntimeClient[] = [];
      const createRuntimeClient = (): GatewayRuntimeClient => {
        const runtime: GatewayRuntimeClient = {
          async request<M extends RuntimeMethod>(
            method: M,
            _params: RuntimeParams<M>,
          ): Promise<RuntimeResult<M>> {
            let value: unknown;
            if (method === "runtime.ping")
              value = {
                pong: true,
                protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
                desktopSchemaRevision: DESKTOP_RUNTIME_SCHEMA_REVISION,
                capabilities: [
                  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
                  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
                  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
                ],
                picoHome: runtimeHome,
              };
            else if (method === "terminal.ownershipCapabilities")
              value = { ownerIsolation: true, sessionCleanupIsolation: true };
            else if (method === "session.get") value = { session };
            else if (method === "session.list") value = { sessions: [session] };
            else if (method === "runs.list") value = { runs: [] };
            else if (method === "session.send") {
              sends++;
              interruptSend?.();
              value = { session, disposition: "started" };
            } else throw new Error(`Unexpected method ${method}`);
            return parseRuntimeResult(method, value);
          },
          async subscribe() {
            return { replay: { subscribed: true, events: [], hasMore: false }, dispose() {} };
          },
          subscribeSessionFrames(_listener, onDisconnect) {
            disconnectRuntime = onDisconnect;
            return { dispose() {} };
          },
          close() {},
        };
        runtimes.push(runtime);
        return runtime;
      };
      const hostSockets: WebSocket[] = [];
      const gateway = await createRemoteGateway(config, {
        home: gatewayHome,
        createRuntimeClient,
        createRelayWebSocket: (url) => {
          const socket = new WebSocket(url, { ca: tls.cert });
          hostSockets.push(socket);
          return socket;
        },
      });
      const sockets: WebSocket[] = [];
      const wire: string[] = [];
      const createWebSocket = (
        url: string,
        _headers: Readonly<Record<string, string>>,
      ): RemoteSocket => {
        const socket = new WebSocket(url, { ca: tls.cert });
        sockets.push(socket);
        const send = socket.send.bind(socket);
        socket.send = ((data: WebSocket.Data) => {
          wire.push(String(data));
          send(data);
        }) as typeof socket.send;
        socket.on("message", (data) => wire.push(data.toString()));
        return socket as unknown as RemoteSocket;
      };
      const transport = { relay: config.relay, randomBytes, createWebSocket };
      const cleanup: { remote?: RemoteRuntimeClient } = {};
      let connectionState = "disconnected";
      t.after(async () => {
        cleanup.remote?.close();
        for (const socket of sockets) socket.terminate();
        await gateway.close();
        await relay.close();
        await tls.close();
        await rm(root, { recursive: true, force: true });
      });
      await gateway.start();
      await until(
        async () =>
          ((await gateway.manage("status", {})) as { relay: { state: string } }).relay.state ===
          "online",
      );
      assert.deepEqual(
        ((await gateway.manage("status", {})) as { listening: unknown[] }).listening,
        [],
        "relay does not open an inbound computer listener",
      );
      const offer = (await gateway.manage("pair.offer", {})) as RemotePairingOffer;
      const pairing = await RemoteRuntimeClient.submitPairing(
        offer,
        { deviceName: "Relay phone", platform: "android" },
        tls.fetcher,
        transport,
      );
      const pending = await RemoteRuntimeClient.pairingStatus(
        relay.origin,
        pairing,
        tls.fetcher,
        transport,
      );
      assert.equal(pending.status, "pending");
      const workspaceId = config.workspaces[0]!.id;
      await gateway.manage("pair.approve", {
        pairingId: pairing.pairingId,
        workspaceIds: [workspaceId],
        permissions: ["workspace.read", "session.control"],
      });
      const approved = await RemoteRuntimeClient.pairingStatus(
        relay.origin,
        pairing,
        tls.fetcher,
        transport,
      );
      assert.equal(approved.status, "approved");
      if (approved.status !== "approved") throw new Error("approval missing");
      await RemoteRuntimeClient.acknowledgePairing(relay.origin, pairing, tls.fetcher, transport);
      const remote = new RemoteRuntimeClient({
        publicUrl: relay.origin,
        gatewayId: approved.gatewayId,
        deviceToken: approved.deviceToken,
        ...transport,
        onState: (state) => {
          connectionState = state;
        },
      });
      cleanup.remote = remote;
      await remote.connect();
      assert.equal((await remote.capabilities()).features.relayConnection?.available, true);
      assert.equal(
        (await remote.request("session.list", {}, { workspaceId })).sessions[0]?.title,
        session.title,
      );
      await assert.rejects(remote.request("session.list", {}, { workspaceId: "another-project" }), {
        code: "FORBIDDEN",
      });
      await assert.rejects(remote.request("config.user.get", {}), { code: "FORBIDDEN" });
      const subscription = await remote.subscribe({ workspaceId }, () => {});
      assert.equal(subscription.replay.subscribed, true);
      subscription.dispose();
      await remote.request(
        "session.send",
        { sessionId: session.sessionId, input: { kind: "text", text: "private relay message" } },
        { workspaceId, idempotencyKey: "relay-message-1" },
      );
      assert.equal(sends, 1);
      for (const secret of [
        offer.secret,
        pairing.pairingToken,
        approved.deviceToken,
        "private relay message",
        session.title,
      ])
        assert.equal(
          wire.some((frame) => frame.includes(secret)),
          false,
          "no application data in outer relay frames",
        );
      interruptSend = () => sockets.at(-1)?.terminate();
      await assert.rejects(
        remote.request(
          "session.send",
          { sessionId: session.sessionId, input: { kind: "text", text: "lost response message" } },
          { workspaceId, idempotencyKey: "relay-message-2" },
        ),
        { outcome: "unknown" },
      );
      interruptSend = undefined;
      await until(() => connectionState === "connected");
      assert.equal(sends, 2, "transport must not replay a command after reconnect");
      const beforeBackpressure = sockets.length;
      const hostSocket = hostSockets.at(-1)!;
      Object.defineProperty(hostSocket, "bufferedAmount", {
        configurable: true,
        get: () => 16 * 1024 * 1024,
      });
      assert.doesNotThrow(
        () => disconnectRuntime?.(),
        "relay backpressure never propagates into Runtime callbacks",
      );
      delete (hostSocket as unknown as { bufferedAmount?: number }).bufferedAmount;
      await until(() => sockets.length > beforeBackpressure && connectionState === "connected");
      await remote.revoke();
      assert.ok(
        (
          (await gateway.manage("devices.list", {})) as {
            devices: { id: string; revokedAt?: number }[];
          }
        ).devices.find((d) => d.id === approved.deviceId)?.revokedAt,
        "self-revoke ACK is delivered before the channel closes",
      );
      await assert.rejects(remote.request("session.list", {}, { workspaceId }));
      assert.ok(runtimes.length > 0);
      assert.ok(hostSockets.length >= 1);
      await requestRelayControl(relayHome, "revoke", { gatewayId: config.relay.gatewayId });
      await until(
        async () =>
          ((await gateway.manage("status", {})) as { relay: { state: string } }).relay.state ===
          "unauthorized",
      );
      assert.equal(
        JSON.stringify(
          JSON.parse(await readFile(join(gatewayHome, "devices.json"), "utf8")),
        ).includes(approved.deviceToken),
        false,
      );
      await gateway.close();
      if (setupMode === "prebound") {
        const prior = await prepareRelayBinding(input, gatewayHome);
        await assert.rejects(
          requestRelayControl(relayHome, "bind", {
            gatewayId: prior.gatewayId,
            tokenHash: prior.tokenHash,
          }),
          { code: "HOST_REVOKED" },
        );
        const renewed = await prepareRelayBinding({ ...input, rotateToken: true }, gatewayHome);
        await requestRelayControl(relayHome, "bind", {
          gatewayId: renewed.gatewayId,
          tokenHash: renewed.tokenHash,
        });
      }
      const recovered = await configureRelayGateway(
        { ...input, ...(replacementInvite ? { invitation: replacementInvite.invitation } : {}) },
        gatewayHome,
      );
      assert.deepEqual(
        recovered.relay,
        config.relay,
        "re-enrollment keeps the QR pinned computer identity",
      );
      assert.notEqual(
        (await loadRelayIdentity(gatewayHome, recovered.relay!)).token,
        credentials.token,
        "explicit re-binding replaces a revoked host token",
      );
    },
  );
