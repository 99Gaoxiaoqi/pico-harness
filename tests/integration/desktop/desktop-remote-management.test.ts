import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createRemoteManagementBridge } from "../../../apps/desktop/src/preload/remote-management-bridge.js";
import {
  REMOTE_MANAGEMENT_CHANNEL,
  type RemoteConfiguration,
} from "../../../apps/desktop/src/preload/remote-management-contract.js";
import { registerRemoteManagementIpc } from "../../../apps/desktop/src/main/remote-management-ipc.js";
import { RemoteManagementService } from "../../../apps/desktop/src/main/remote-management-service.js";
import { pairingQrDataUrl } from "../../../apps/desktop/src/main/pairing-qr.js";

function ipcHarness(service: RemoteManagementService) {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>
  >();
  const trusted = {} as IpcMainInvokeEvent;
  const dispose = registerRemoteManagementIpc({
    service,
    trusted: (event) => event === trusted,
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    } as Pick<IpcMain, "handle" | "removeHandler">,
  });
  const bridge = createRemoteManagementBridge({
    invoke: async (channel, request) => handlers.get(channel)!(trusted, request),
  });
  return { bridge, dispose, handlers };
}

test("桌面手机连接通过可信桥接完成配置、唯一后台启动、二维码、本机批准和撤销，并持久化关闭状态", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-remote-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = { id: "project-one", name: "Project", path: "/trusted/project" };
  let config: RemoteConfiguration = { configured: false, workspaces: [] };
  let running = false;
  let spawns = 0;
  let devices: Record<string, unknown>[] = [];
  const expiresAt = Date.now() + 300_000;
  let qrPayload = "";
  const calls: string[] = [];
  const dependencies = {
    preferencesDirectory: root,
    readConfiguration: async () => config,
    configure: async (input: { relayUrl: string }) => {
      config = {
        configured: true,
        connectionMode: "relay",
        relayUrl: input.relayUrl,
        workspaces: [workspace],
      };
    },
    spawn: async () => {
      spawns++;
      running = true;
    },
    delay: async () => undefined,
    makeQr: (payload: string) => {
      qrPayload = payload;
      return pairingQrDataUrl(payload);
    },
    control: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      calls.push(method);
      if (!running) throw new Error("not running");
      if (method === "status")
        return {
          relay: { state: "online", hostToken: "must-not-leak" },
          runtime: { lastReachableAt: 12 },
        };
      if (method === "devices.list") return { devices };
      if (method === "pair.pending")
        return devices.length
          ? []
          : [{ pairingId: "pair-one", deviceName: "My phone", expiresAt, secret: "must-not-leak" }];
      if (method === "pair.offer")
        return {
          pairingId: "pair-one",
          version: 2,
          gatewayId: "gateway-one",
          publicUrl: "https://relay.example.com",
          secret: "short-lived",
          expiresAt,
        };
      if (method === "pair.approve") {
        devices = [{ id: "phone-one", name: "My phone", ...params, tokenHash: "must-not-leak" }];
        return {};
      }
      if (method === "devices.revoke") {
        devices = devices.map((device) => ({ ...device, revokedAt: Date.now() }));
        return {};
      }
      if (method === "stop") {
        running = false;
        return {};
      }
      throw new Error("unexpected method");
    },
  };
  const service = new RemoteManagementService(dependencies);
  const { bridge, dispose } = ipcHarness(service);
  t.after(dispose);
  const configured = await bridge.configure({
    relayUrl: "https://relay.example.com",
    invitation: "one-time",
    workspaces: [{ path: workspace.path }],
  });
  assert.equal(configured.ok, true);
  const starts = await Promise.all([bridge.start({}), bridge.start({})]);
  assert.ok(starts.every((result) => result.ok));
  assert.equal(spawns, 1);
  const qr = await bridge.offer({});
  assert.equal(qr.ok, true);
  if (!qr.ok) return;
  assert.match(qr.value.qrDataUrl, /^data:image\/svg\+xml;base64,/u);
  const svg = Buffer.from(qr.value.qrDataUrl.split(",")[1]!, "base64").toString("utf8");
  assert.match(svg, /shape-rendering="crispEdges"/u);
  assert.ok(svg.length > 1000);
  assert.equal(JSON.parse(qrPayload).secret, "short-lived");
  assert.equal(JSON.parse(qrPayload).pairingId, undefined);
  const approved = await bridge.approve({
    pairingId: "pair-one",
    permissions: ["workspace.read", "session.control"],
    workspaceIds: [workspace.id],
  });
  assert.equal(approved.ok, true);
  assert.doesNotMatch(JSON.stringify(approved), /must-not-leak|tokenHash|hostToken|secret/u);
  assert.equal(approved.ok && approved.value.devices.length, 1);
  const restored = new RemoteManagementService(dependencies);
  await restored.restore();
  assert.equal(spawns, 1);
  assert.equal((await bridge.revoke({ deviceId: "phone-one" })).ok, true);
  assert.equal((await bridge.stop({})).ok, true);
  assert.equal(running, false);
  assert.equal(
    JSON.parse(await readFile(join(root, "mobile-connection.json"), "utf8")).enabled,
    false,
  );
  await new RemoteManagementService(dependencies).restore();
  assert.equal(spawns, 1);
  assert.ok(!calls.some((method) => method.includes("shutdown")));
});

test("手机管理拒绝非可信页面、未知方法及多余字段，且不会把邀请或网关秘密放进错误响应", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-remote-desktop-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let controlCalls = 0;
  const service = new RemoteManagementService({
    preferencesDirectory: root,
    readConfiguration: async () => ({ configured: false, workspaces: [] }),
    configure: async () => {
      throw new Error("invitation=SECRET-INVITATION&hostToken=SECRET-TOKEN");
    },
    control: async () => {
      controlCalls++;
      throw new Error("not running");
    },
    spawn: async () => undefined,
    makeQr: pairingQrDataUrl,
  });
  const { bridge, handlers, dispose } = ipcHarness(service);
  t.after(dispose);
  assert.equal(
    (
      await bridge.configure({
        relayUrl: "http://insecure.example",
        workspaces: [{ path: "/project" }],
      })
    ).ok,
    false,
  );
  assert.equal((await bridge.start({ unexpected: "value" } as Record<string, never>)).ok, false);
  const unauthorized = await handlers.get(REMOTE_MANAGEMENT_CHANNEL)!({} as IpcMainInvokeEvent, {
    action: "start",
    params: {},
  });
  assert.deepEqual(unauthorized, {
    ok: false,
    error: { code: "UNAUTHORIZED_RENDERER", message: "已拒绝非受信任页面调用", retryable: false },
  });
  assert.equal(controlCalls, 0);
  const failed = await bridge.configure({
    relayUrl: "https://relay.example.com",
    invitation: "SECRET-INVITATION",
    workspaces: [{ path: "/project" }],
  });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET|invitation=|hostToken=/u);
});
