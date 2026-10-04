import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import {
  configureRelayGateway,
  loadRelayIdentity,
  prepareRelayBinding,
  readGatewayConfiguration,
} from "../../../packages/remote-gateway/src/relay-config.js";
import { hashSecret } from "../../../packages/remote-gateway/src/state.js";
import { runRemoteCli } from "../../../packages/remote-gateway/src/cli.js";
import { acquireGatewayLock } from "../../../packages/remote-gateway/src/control.js";

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-relay-config-")));
  const runtimeHome = join(root, "runtime");
  const workspace = join(root, "project");
  await mkdir(runtimeHome);
  await mkdir(workspace);
  await new WorkspaceRegistrationStore(join(runtimeHome, "daemon-workspaces.json")).register(
    workspace,
  );
  await new WorkspaceTrustStore({ userStateDirectory: runtimeHome }).trust(workspace);
  return { root, runtimeHome, workspace, home: join(root, "gateway") };
}

test("个人中继免邀请保存，部署准备幂等且只输出摘要，显式轮换保留电脑身份与手机配对公钥", async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", () => {
    throw new Error("个人部署不使用公开注册接口");
  });
  const input = {
    relayUrl: "https://personal.example.com",
    workspaces: [{ path: fixture.workspace }],
    runtimeHostRootPath: fixture.runtimeHome,
  };
  const config = await configureRelayGateway(input, fixture.home);
  assert.ok(config.relay);
  const credentials = await loadRelayIdentity(fixture.home, config.relay);
  const output: string[] = [];
  assert.equal(
    await runRemoteCli(["relay", "prepare", "--url", input.relayUrl, "--home", fixture.home], {
      output: (value) => output.push(value),
    }),
    0,
  );
  const prepared = JSON.parse(output[0]!);
  assert.deepEqual(prepared, {
    version: 1,
    relayUrl: input.relayUrl,
    gatewayId: config.relay.gatewayId,
    tokenHash: hashSecret(credentials.token),
  });
  assert.equal(JSON.stringify(prepared).includes(credentials.token), false);
  assert.equal(JSON.stringify(prepared).includes(credentials.secretKey), false);
  assert.equal((await stat(join(fixture.home, "relay-identity.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await prepareRelayBinding(input, fixture.home), prepared);
  const release = await acquireGatewayLock(fixture.home);
  try {
    await assert.rejects(
      prepareRelayBinding({ ...input, rotateToken: true }, fixture.home),
      /运行|启动|锁/u,
    );
  } finally {
    await release();
  }
  assert.deepEqual(await prepareRelayBinding(input, fixture.home), prepared);
  const rotated = await prepareRelayBinding({ ...input, rotateToken: true }, fixture.home);
  assert.equal(rotated.gatewayId, prepared.gatewayId);
  assert.notEqual(rotated.tokenHash, prepared.tokenHash);
  assert.deepEqual(await prepareRelayBinding(input, fixture.home), rotated);
  const after = await configureRelayGateway(input, fixture.home);
  assert.deepEqual(after.relay, config.relay);
  assert.deepEqual(after.workspaces, config.workspaces);
  assert.equal(
    (await loadRelayIdentity(fixture.home, config.relay)).secretKey,
    credentials.secretKey,
  );
  assert.equal(network.mock.calls.length, 0);
});

test("Relay 配置仅授权本机可信项目，身份和项目ID跨重配保持稳定且公开投影无秘密", async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const enrollments: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://relay.example.com/v1/enroll");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    enrollments.push(JSON.parse(String(options.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ version: 1, enrolled: true }));
  });
  const input = {
    relayUrl: "https://relay.example.com",
    invitation: "one-time",
    workspaces: [{ path: fixture.workspace }],
    runtimeHostRootPath: fixture.runtimeHome,
  };
  const first = await configureRelayGateway(input, fixture.home);
  assert.ok(first.relay);
  const identity = await loadRelayIdentity(fixture.home, first.relay);
  assert.equal(enrollments[0]?.tokenHash, hashSecret(identity.token));
  const second = await configureRelayGateway({ ...input, invitation: undefined }, fixture.home);
  assert.equal(enrollments.length, 1);
  assert.deepEqual(second.relay, first.relay);
  assert.equal(second.workspaces[0]?.id, first.workspaces[0]?.id);
  const summary = await readGatewayConfiguration(fixture.home);
  assert.equal(summary.connectionMode, "relay");
  assert.doesNotMatch(JSON.stringify(summary), /secretKey|token|one-time/u);
  assert.deepEqual(await loadRelayIdentity(fixture.home, second.relay!), identity);
  await assert.rejects(
    loadRelayIdentity(fixture.home, { ...second.relay!, gatewayId: "other-host" }),
    /不匹配/u,
  );
  await new WorkspaceTrustStore({ userStateDirectory: fixture.runtimeHome }).setTrusted(
    fixture.workspace,
    false,
  );
  await assert.rejects(
    configureRelayGateway({ ...input, invitation: undefined }, fixture.home),
    /信任/u,
  );
  assert.equal(enrollments.length, 1);
});

test("Relay 注册响应丢失保留同一token重试，HTML成功页和重定向都不能伪装为注册成功", async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const tokenHashes: unknown[] = [];
  let accepted = false;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    tokenHashes.push(JSON.parse(String(options.body)).tokenHash);
    return new Response(
      accepted ? JSON.stringify({ version: 1, enrolled: true }) : "<html>proxy login</html>",
    );
  });
  const input = {
    relayUrl: "https://relay.example.com",
    invitation: "one-time",
    workspaces: [{ path: fixture.workspace }],
    runtimeHostRootPath: fixture.runtimeHome,
  };
  await assert.rejects(configureRelayGateway(input, fixture.home), /注册确认无效/u);
  assert.equal((await readGatewayConfiguration(fixture.home)).configured, false);
  const pending = JSON.parse(await readFile(join(fixture.home, "relay-identity.json"), "utf8"));
  assert.equal(pending.registrations["https://relay.example.com"].enrolled, false);
  assert.equal(pending.registrations["https://relay.example.com"].token.length, 43);
  accepted = true;
  const configured = await configureRelayGateway(input, fixture.home);
  assert.ok(configured.relay);
  assert.deepEqual(tokenHashes, [tokenHashes[0], tokenHashes[0]]);
  assert.equal(
    (await loadRelayIdentity(fixture.home, configured.relay)).token,
    pending.registrations["https://relay.example.com"].token,
  );
  await assert.rejects(
    configureRelayGateway({ ...input, relayUrl: "https://relay.example.com/other" }, fixture.home),
    /origin/u,
  );
  assert.equal(tokenHashes.length, 2);
});
