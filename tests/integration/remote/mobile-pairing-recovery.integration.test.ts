import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  type RuntimeMethod,
  type RuntimeResult,
} from "@pico/protocol";
import type { RemotePairingOffer, RemotePairingSubmitted } from "@pico/protocol/remote";
import {
  PENDING_PAIRING_KEY,
  RecoverablePairing,
  type PairingPort,
  type PendingPairing,
} from "../../../apps/mobile/src/pairing.js";
import type { SavedHost } from "../../../apps/mobile/src/core.js";
import {
  RemoteProtocolError,
  RemoteRuntimeClient,
} from "../../../packages/remote-client/src/index.js";
import {
  createRemoteGateway,
  type RemoteGateway,
} from "../../../packages/remote-gateway/src/server.js";
import type {
  GatewayPairings,
  PairingConfirmation,
} from "../../../packages/remote-gateway/src/pairing.js";
import type { GatewayRuntimeClient } from "../../../packages/remote-gateway/src/policy.js";
import type { GatewayConfig } from "../../../packages/remote-gateway/src/state.js";
import { createTestTlsFixture } from "./tls-fixture.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "配对测试未到达预期状态");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const errorIs = (code: string) => (error: unknown) =>
  error instanceof RemoteProtocolError && error.code === code;

async function fixture(t: TestContext) {
  const tls = await createTestTlsFixture();
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const config: GatewayConfig = {
    version: 1,
    publicUrl: `https://127.0.0.1:${address.port}`,
    port: address.port,
    certificatePath: tls.certPath,
    privateKeyPath: tls.keyPath,
    listenHosts: ["127.0.0.1"],
    workspaces: [{ id: "workspace-a", name: "project", path: tls.directory }],
  };
  let now = Date.now();
  let gateway: RemoteGateway;
  let confirmationWrites = 0;
  let acknowledgementAttempts = 0;
  let confirmationGate: ReturnType<typeof deferred<void>> | undefined;
  let failConfirmation = false;
  let dropAckReply = false;
  let verificationUnavailable = false;
  let submitGate: ReturnType<typeof deferred<void>> | undefined;
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const home = join(tls.directory, "gateway");
  const runtime: GatewayRuntimeClient = {
    async request<M extends RuntimeMethod>(method: M): Promise<RuntimeResult<M>> {
      if (method !== "runtime.ping") throw new Error("fixture has no execution runtime");
      return {
        pong: true,
        protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        desktopSchemaRevision: DESKTOP_RUNTIME_SCHEMA_REVISION,
        capabilities: [
          DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
          CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
          TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
        ],
        picoHome: tls.directory,
      } as RuntimeResult<M>;
    },
    async subscribe() {
      throw new Error("fixture does not subscribe");
    },
    subscribeSessionFrames() {
      return { dispose() {} };
    },
    close() {},
  };
  async function boot() {
    gateway = await createRemoteGateway(config, {
      home,
      now: () => now,
      createRuntimeClient: () => runtime,
    });
    // Fault injection stays inside the fixture; HTTPS and the production staged
    // persistence/confirmation code still perform every accepted operation.
    const internal = gateway as unknown as {
      persist(confirmation?: PairingConfirmation): Promise<void>;
      pairings: Pick<GatewayPairings, "acknowledge">;
    };
    const acknowledge = internal.pairings.acknowledge.bind(internal.pairings);
    internal.pairings.acknowledge = (...args) => {
      acknowledgementAttempts++;
      return acknowledge(...args);
    };
    const persist = internal.persist.bind(gateway);
    internal.persist = async (confirmation) => {
      if (confirmation) {
        confirmationWrites++;
        if (confirmationGate) await confirmationGate.promise;
        if (failConfirmation) throw new Error("fixture disk commit failed");
      }
      await persist(confirmation);
    };
    await gateway.start();
  }
  t.after(async () => {
    await gateway?.close();
    await tls.close();
  });
  await boot();
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, authorization: new Headers(init?.headers).get("authorization") });
    if (path === "/v1/capabilities" && verificationUnavailable)
      throw new Error("fixture verification path unavailable");
    const response = await tls.fetcher(input, init);
    if (path === "/v1/pairings" && submitGate) await submitGate.promise;
    if (path.endsWith("/ack") && dropAckReply)
      throw new Error("fixture lost the committed ack reply");
    return response;
  };
  const hosts = new Map<string, SavedHost>();
  const installedTokens = new Map<string, string>();
  function phone() {
    const secure = new Map<string, string>();
    const storage = {
      getItemAsync: async (key: string) => secure.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => {
        secure.set(key, value);
      },
      deleteItemAsync: async (key: string) => {
        secure.delete(key);
      },
    };
    const port: PairingPort = {
      async submit(offer, name) {
        const submitted = await RemoteRuntimeClient.submitPairing(
          offer,
          { deviceName: name, platform: "ios" },
          fetcher,
        );
        await gateway.manage("pair.approve", { pairingId: submitted.pairingId });
        return submitted;
      },
      status: (url, claim) => RemoteRuntimeClient.pairingStatus(url, claim, fetcher),
      acknowledge: (url, claim) => RemoteRuntimeClient.acknowledgePairing(url, claim, fetcher),
      async verify(host, token) {
        const client = new RemoteRuntimeClient({
          publicUrl: host.baseUrl,
          gatewayId: host.gatewayId,
          deviceToken: token,
          fetch: fetcher,
        });
        try {
          await client.capabilities();
        } finally {
          client.close();
        }
      },
      async install(host, token) {
        hosts.set(host.id, host);
        installedTokens.set(host.id, token);
      },
      async revoke(host, token) {
        const client = new RemoteRuntimeClient({
          publicUrl: host.baseUrl,
          gatewayId: host.gatewayId,
          deviceToken: token,
          fetch: fetcher,
        });
        try {
          await client.revoke();
        } finally {
          client.close();
        }
      },
      async forget(host) {
        hosts.delete(host.id);
        installedTokens.delete(host.id);
      },
      changed() {},
      now: () => now,
    };
    return {
      controller: () => new RecoverablePairing(storage, port),
      pending: () => {
        const raw = secure.get(PENDING_PAIRING_KEY);
        return raw ? (JSON.parse(raw) as PendingPairing) : undefined;
      },
    };
  }
  return {
    phone,
    hosts,
    installedTokens,
    requests,
    get gateway() {
      return gateway;
    },
    get confirmationWrites() {
      return confirmationWrites;
    },
    get acknowledgementAttempts() {
      return acknowledgementAttempts;
    },
    offer: async () => (await gateway.manage("pair.offer", {})) as RemotePairingOffer,
    device: (id: string) => gateway.state.devices.find((device) => device.id === id)!,
    disk: async () =>
      JSON.parse(await readFile(join(home, "devices.json"), "utf8")) as RemoteGateway["state"],
    advance(ms: number) {
      now += ms;
    },
    async restart() {
      await gateway.close();
      await boot();
    },
    holdConfirmation() {
      confirmationGate = deferred<void>();
      return confirmationGate;
    },
    releaseConfirmation() {
      confirmationGate = undefined;
    },
    failConfirmation(active: boolean) {
      failConfirmation = active;
    },
    loseAckReply(active: boolean) {
      dropAckReply = active;
    },
    failVerification(active: boolean) {
      verificationUnavailable = active;
    },
    holdSubmit() {
      submitGate = deferred<void>();
      return submitGate;
    },
    releaseSubmit() {
      submitGate = undefined;
    },
    verify: async (pending: PendingPairing) => {
      assert.ok(pending.approved);
      const client = new RemoteRuntimeClient({
        publicUrl: pending.publicUrl,
        gatewayId: pending.gatewayId,
        deviceToken: pending.approved.deviceToken,
        fetch: fetcher,
      });
      try {
        return await client.capabilities();
      } finally {
        client.close();
      }
    },
    ack: (claim: RemotePairingSubmitted) =>
      RemoteRuntimeClient.acknowledgePairing(config.publicUrl, claim, fetcher),
  };
}

test("手机保留丢失确认回执的安全 pending，重启后用原设备认证恢复正式配对", async (t) => {
  const f = await fixture(t);
  const phone = f.phone();
  f.loseAckReply(true);
  f.failVerification(true);
  await assert.rejects(phone.controller().start(await f.offer(), "手机"), /确认结果未确认/);
  const pending = phone.pending()!;
  assert.ok(pending.approved);
  assert.equal(f.hosts.size, 0);
  const device = f.device(pending.approved.deviceId);
  assert.ok(device.pairedAt);
  assert.equal((await f.disk()).devices[0]?.pairedAt, device.pairedAt);
  await f.restart();
  f.advance(5 * 60_000 + 1);
  f.loseAckReply(false);
  f.failVerification(false);
  const installed = await phone.controller().resume();
  assert.ok(installed);
  assert.equal(f.installedTokens.get(installed.id), pending.approved.deviceToken);
  assert.equal(f.hosts.size, 1);
  assert.equal(phone.pending(), undefined);
  assert.equal(f.requests.filter((request) => request.path === "/v1/pairings").length, 1);
  assert.equal(f.requests.at(-1)?.authorization, `Bearer ${pending.approved.deviceToken}`);
});

test("确认落盘失败不发布 pairedAt，重复确认共享提交，未确认过期或网关重启不能假成功", async (t) => {
  const f = await fixture(t);
  const phone = f.phone();
  const controller = phone.controller();
  const gate = f.holdConfirmation();
  const started = assert.rejects(controller.start(await f.offer(), "手机"), /确认结果未确认/);
  await until(() => f.confirmationWrites === 1);
  const pending = phone.pending()!;
  assert.ok(pending.approved);
  assert.equal(f.device(pending.approved.deviceId).pairedAt, undefined);
  assert.equal((await f.disk()).devices[0]?.pairedAt, undefined);
  await assert.rejects(f.verify(pending), errorIs("DEVICE_REVOKED"));
  const duplicate = assert.rejects(f.ack(pending.submitted), errorIs("INTERNAL_ERROR"));
  await until(() => f.acknowledgementAttempts === 2);
  assert.equal(f.confirmationWrites, 1);
  gate.reject(new Error("fixture blocked disk commit failed"));
  await Promise.all([started, duplicate]);
  assert.equal(f.device(pending.approved.deviceId).pairedAt, undefined);
  assert.equal((await f.disk()).devices[0]?.pairedAt, undefined);
  assert.equal(f.hosts.size, 0);
  f.releaseConfirmation();
  assert.ok(await controller.resume());
  const pairedAt = f.device(pending.approved.deviceId).pairedAt;
  f.advance(1_000);
  await f.ack(pending.submitted);
  assert.equal(f.device(pending.approved.deviceId).pairedAt, pairedAt);
  assert.equal(f.confirmationWrites, 2);

  for (const failure of ["expired", "restart"] as const) {
    const unconfirmed = f.phone();
    f.failConfirmation(true);
    await assert.rejects(
      unconfirmed.controller().start(await f.offer(), "未确认手机"),
      /确认结果未确认/,
    );
    const held = unconfirmed.pending()!;
    assert.ok(held.approved);
    assert.equal(f.device(held.approved.deviceId).pairedAt, undefined);
    f.failConfirmation(false);
    if (failure === "expired") {
      f.advance(5 * 60_000 + 1);
      await f.gateway.manage("pair.pending", {});
    } else await f.restart();
    await assert.rejects(unconfirmed.controller().resume(), /配对已过期或设备未获确认/);
    assert.equal(unconfirmed.pending(), undefined);
    assert.equal(f.hosts.size, 1, "原已确认配对保留，未确认设备不能进入正式 hosts");
    assert.ok(f.device(held.approved.deviceId).revokedAt);
  }
});

test("取消后的迟到 submit 不复活，后台迟到 claim 仅保存待下次前台继续", async (t) => {
  const f = await fixture(t);
  const cancelledPhone = f.phone();
  const cancelled = cancelledPhone.controller();
  const cancelledGate = f.holdSubmit();
  const cancelledOffer = await f.offer();
  const first = cancelled.start(cancelledOffer, "取消手机");
  await until(() => f.requests.some((request) => request.path === "/v1/pairings"));
  assert.equal(cancelledPhone.pending(), undefined);
  assert.equal(
    await cancelled.inspectGatewayId(),
    cancelledOffer.gatewayId,
    "本机清理必须能识别尚未收到 claim 的同网关申请",
  );
  await cancelled.cancel();
  cancelledGate.resolve();
  assert.equal(await first, undefined);
  assert.equal(cancelledPhone.pending(), undefined);
  assert.equal(await cancelled.inspectGatewayId(), undefined);
  assert.equal(f.hosts.size, 0);
  f.releaseSubmit();

  const backgroundPhone = f.phone();
  const background = backgroundPhone.controller();
  const backgroundGate = f.holdSubmit();
  const second = background.start(await f.offer(), "后台手机");
  await until(() => f.requests.filter((request) => request.path === "/v1/pairings").length === 2);
  background.setForeground(false);
  backgroundGate.resolve();
  assert.equal(await second, undefined);
  assert.ok(backgroundPhone.pending()?.submitted);
  assert.equal(backgroundPhone.pending()?.approved, undefined);
  assert.equal(await background.resume(), undefined);
  assert.equal(f.hosts.size, 0);
  assert.equal(f.requests.filter((request) => request.path.endsWith("/ack")).length, 0);
  f.releaseSubmit();
  background.setForeground(true);
  assert.ok(await background.resume());
  assert.equal(backgroundPhone.pending(), undefined);
  assert.equal(f.hosts.size, 1);
  assert.equal(f.requests.filter((request) => request.path === "/v1/pairings").length, 2);
});
