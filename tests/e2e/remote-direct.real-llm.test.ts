import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalRuntimeClient } from "@pico/pico-host/local-runtime-client";
import {
  UserConfigStore,
  EMPTY_USER_CONFIG_REVISION,
} from "@pico/pico-host/input/user-config-store";
import { launchDetachedRuntimeHostCandidate } from "../../packages/runtime-host/src/client/launcher.js";
import type {
  RuntimeNotification,
  RuntimeSessionSubscriptionFrame,
  RuntimeTranscriptItemRecord,
  RuntimeTranscriptPageCursor,
} from "@pico/protocol/mobile";
import type { RemotePairingOffer } from "@pico/protocol/remote";
import { RemoteRuntimeClient } from "../../packages/remote-client/src/index.js";
import {
  createRemoteGateway,
  configureRemoteGateway,
} from "../../packages/remote-gateway/src/index.js";
import { TestRuntimeHostCandidateTracker } from "../integration/helpers/test-runtime-daemon.js";
import { createTestTlsFixture } from "../integration/remote/tls-fixture.js";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "remote HTTPS/WSS completes an isolated real-model Chinese turn without duplicate execution",
  { timeout: 240_000 },
  async (t) => {
    // Load the actual user route before creating a hermetic daemon. Never persist or print its credential.
    const model = await loadUserDefaultRealModel();
    assert.ok(model.config.apiKey, "真实模型配置缺少凭据");
    const base = new URL(model.config.baseURL);
    assert.equal(
      base.username + base.password + base.search,
      "",
      "测试不能把可能含凭据的URL参数复制到配置文件",
    );
    const root = await mkdtemp(join(tmpdir(), "pico-remote-real-"));
    const runtimeHome = join(root, "runtime");
    const gatewayHome = join(root, "gateway");
    const workspaceDirectory = join(root, "workspace");
    await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
    await mkdir(join(workspaceDirectory, ".pico"), { recursive: true });
    const workspacePath = await realpath(workspaceDirectory);
    const apiKeyEnv = `PICO_REMOTE_E2E_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    await writeFile(
      join(workspacePath, ".pico", "config.json"),
      JSON.stringify({
        compatibility: {
          claude: { enabled: false, projectResources: false, userResources: false },
        },
      }),
    );
    const userConfigStore = new UserConfigStore({ picoHome: runtimeHome });
    await userConfigStore.write(
      {
        version: 1,
        defaults: {
          modelRouteId: model.route.id,
          permissionMode: "ask",
          collaborationMode: "agent",
          orchestrationMode: "default",
          thinkingEffort: "off",
          webSearch: { enabled: false, source: "model" },
        },
        providers: {
          [model.route.providerId]: {
            protocol: model.provider,
            baseURL: model.config.baseURL,
            apiKeyEnv,
            models: [model.route.model],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: EMPTY_USER_CONFIG_REVISION },
    );
    // This random env name exists only in the exact test-owned child. There is no key file and no mutation of process.env.
    const candidates = new TestRuntimeHostCandidateTracker({
      launchCandidate: (input) =>
        launchDetachedRuntimeHostCandidate({
          ...input,
          env: { ...input.env, PICO_HOME: runtimeHome, [apiKeyEnv]: model.config.apiKey },
        }),
    });
    const local = new LocalRuntimeClient({
      runtimeHostRootPath: runtimeHome,
      terminalOwnerId: "desktop:real-model-test",
      surface: "desktop",
      candidateLauncher: candidates.launcher,
    });
    const tls = await createTestTlsFixture();
    let gateway: Awaited<ReturnType<typeof createRemoteGateway>> | undefined;
    const cleanup: { remote?: RemoteRuntimeClient } = {};
    t.after(async () => {
      cleanup.remote?.close();
      await gateway?.close(); // Must not cancel a run or stop the daemon.
      try {
        await local.shutdownDaemon();
      } finally {
        local.close();
        await candidates.stopAll();
        await tls.close();
        await rm(root, { recursive: true, force: true });
      }
    });
    await local.connect();
    await local.request("workspace.register", { workspacePath });
    await local.request("workspace.trust", { workspacePath, trusted: true });
    const port = await availablePort();
    const publicUrl = `https://127.0.0.1:${port}`;
    const config = {
      version: 1 as const,
      publicUrl,
      port,
      certificatePath: tls.certPath,
      privateKeyPath: tls.keyPath,
      listenHosts: ["127.0.0.1"],
      workspaces: [{ id: "workspace-a", name: "真实模型隔离目录", path: workspacePath }],
      runtimeHostRootPath: runtimeHome,
    };
    await configureRemoteGateway(config, gatewayHome);
    gateway = await createRemoteGateway(config, {
      home: gatewayHome,
      createRuntimeClient: (deviceId) =>
        new LocalRuntimeClient({
          runtimeHostRootPath: runtimeHome,
          terminalOwnerId: `remote:${deviceId}`,
          surface: "inspect",
          candidateLauncher: candidates.launcher,
        }),
    });
    await gateway.start();
    const offer = (await gateway.manage("pair.offer", {})) as RemotePairingOffer;
    const pairing = await RemoteRuntimeClient.submitPairing(
      offer,
      { deviceName: "真实模型验收手机", platform: "ios" },
      tls.fetcher,
    );
    assert.equal(
      (await RemoteRuntimeClient.pairingStatus(publicUrl, pairing, tls.fetcher)).status,
      "pending",
    );
    await gateway.manage("pair.approve", {
      pairingId: pairing.pairingId,
      permissions: ["workspace.read", "session.control"],
      workspaceIds: ["workspace-a"],
    });
    const approved = await RemoteRuntimeClient.pairingStatus(publicUrl, pairing, tls.fetcher);
    assert.equal(approved.status, "approved");
    if (approved.status !== "approved") throw new Error("配对未批准");
    await RemoteRuntimeClient.acknowledgePairing(publicUrl, pairing, tls.fetcher);
    const remote = new RemoteRuntimeClient({
      publicUrl,
      gatewayId: approved.gatewayId,
      deviceToken: approved.deviceToken,
      fetch: tls.fetcher,
      createWebSocket: tls.createWebSocket,
    });
    cleanup.remote = remote;
    await remote.connect();
    const workspace = { workspaceId: "workspace-a" };
    const notifications: RuntimeNotification[] = [];
    const eventSubscription = await remote.subscribe(workspace, (event) =>
      notifications.push(event),
    );
    const sessionId = (
      await remote.request("session.create", { title: "远程真实模型验收" }, workspace)
    ).session.sessionId;
    const frames: RuntimeSessionSubscriptionFrame[] = [];
    const frameSubscription = remote.subscribeSessionFrames((frame) => frames.push(frame));
    await remote.request("session.subscription.open", { sessionId, tailLimit: 1 }, workspace);
    const input = {
      sessionId,
      input: {
        kind: "text" as const,
        text: "这是一次连接验收。不要调用任何工具，不要读写文件，只用中文回复：远程连接成功。",
      },
      idempotencyKey: `remote-turn-${randomUUID()}`,
    };
    const submitted = await remote.request("session.send", input, workspace);
    assert.ok(submitted.run, "发送必须启动真实模型任务");
    const runId = submitted.run.runId;
    const repeated = await remote.request("session.send", input, workspace);
    assert.equal(repeated.run?.runId, runId, "相同幂等键不能启动第二次模型调用");
    await until(async () => {
      const run = (await remote.request("runs.list", {}, workspace)).runs.find(
        (candidate) => candidate.runId === runId,
      );
      if (run?.status === "failed")
        throw new Error("真实模型任务失败；诊断保留在临时宿主，未记录凭据");
      return run?.status === "succeeded";
    }, 180_000);
    await until(
      async () =>
        notifications.some(
          (event) => event.topic === "run.finished" && event.scope.runId === runId,
        ),
      10_000,
    );
    await until(
      async () =>
        frames.some(
          (frame) =>
            frame.sessionId === sessionId && frame.type === "subscription.transcript_advanced",
        ),
      10_000,
    );
    assert.ok(
      frames.some((frame) => frame.type === "subscription.session_delta" && frame.kind === "text"),
      "真实回复通过WSS会话增量到达",
    );
    // Closing the gateway releases transport only. The completed daemon run remains queryable.
    const snapshot = await remote.request(
      "session.subscription.open",
      { sessionId, tailLimit: 1 },
      workspace,
    );
    const items: RuntimeTranscriptItemRecord[] = [];
    let cursor: RuntimeTranscriptPageCursor | undefined;
    let pages = 0;
    do {
      const page = await remote.request(
        "session.transcript.page",
        { sessionId, through: snapshot.watermark, limit: 1, ...(cursor ? { cursor } : {}) },
        workspace,
      );
      assert.equal(page.fragments?.length ?? 0, 0, "短文本验收不应产生需要另外组装的分片");
      items.push(...page.items);
      cursor = page.nextCursor;
      assert.ok(++pages < 64, "短对话分页必须有界完成");
    } while (cursor);
    assert.ok(pages > 1, "limit=1实际验证历史分页");
    const assistants = items
      .map((record) => record.item)
      .filter((item) => item.kind === "assistantMessage");
    assert.ok(
      assistants.some(
        (item) => item.kind === "assistantMessage" && item.content.includes("远程连接成功"),
      ),
      "正式历史包含真实模型中文回复",
    );
    assert.equal(items.filter((record) => record.item.kind === "userMessage").length, 1);
    assert.equal(items.filter((record) => record.item.kind === "tool").length, 0, "验收不执行工具");
    assert.equal(
      (await remote.request("runs.list", {}, workspace)).runs.filter(
        (run) => run.sessionId === sessionId,
      ).length,
      1,
    );
    eventSubscription.dispose();
    frameSubscription.dispose();
    await gateway.close();
    gateway = undefined;
    assert.equal(
      (await local.request("runs.list", { workspacePath })).runs.find((run) => run.runId === runId)
        ?.status,
      "succeeded",
    );
    assert.ok(
      !(await readFile(join(runtimeHome, "config.json"), "utf8")).includes(model.config.apiKey),
      "配置只保存随机环境变量引用",
    );
  },
);

async function availablePort(): Promise<number> {
  const probe = createPortProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function until(condition: () => Promise<boolean>, timeout: number): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await condition())) {
    assert.ok(performance.now() < deadline, "真实模型远程验收超时");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
