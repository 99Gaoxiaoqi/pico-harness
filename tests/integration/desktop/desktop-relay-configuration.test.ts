import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import {
  configureRelayGateway,
  loadRelayIdentity,
  readGatewayConfiguration,
} from "../../../packages/remote-gateway/src/relay-config.js";
import { hashSecret } from "../../../packages/remote-gateway/src/state.js";

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
