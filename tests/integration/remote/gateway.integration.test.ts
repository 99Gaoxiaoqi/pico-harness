import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { request } from "node:https";
import { readFile, mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { UserMcpConfigStore } from "@pico/pico-host/user-mcp-config-store";
import {
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
  MODEL_CATALOG_RUNTIME_CAPABILITY,
  CONFIG_SECRET_PATCH_RUNTIME_CAPABILITY,
  publicProviderEndpoint,
  REVIEW_IDEMPOTENCY_RUNTIME_CAPABILITY,
  MEMORY_PAGINATION_RUNTIME_CAPABILITY,
  TRANSCRIPT_PROJECTOR_VERSION,
  parseRuntimeResult,
} from "@pico/protocol";
import type { RuntimeMediaReference } from "@pico/protocol/mobile";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";
import type {
  RuntimeMethod,
  RuntimeParams,
  RuntimeResult,
  RuntimeNotification,
  RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";
import type {
  RemotePairingOffer,
  RemotePairingSubmitted,
  RemotePairingStatus,
  RemoteMethod,
  RemoteParams,
  RemoteResponse,
} from "@pico/protocol/remote";
import type { RuntimePort } from "../../../apps/mobile/src/core.js";
import { resolveMediaArtifact, verifyMediaIntegrity } from "../../../apps/mobile/src/media.js";
import {
  createRemoteGateway,
  requestGatewayControl,
  type GatewayRuntimeClient,
  type GatewayConfig,
} from "../../../packages/remote-gateway/src/index.js";

const session = {
  sessionId: "session-1",
  workspacePath: "/registered/workspace",
  title: "手机会话",
  status: "active",
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
};
const contents = Buffer.from("生成文件\n".repeat(6000));
const digest = createHash("sha256").update(contents).digest("hex");
const artifact = {
  artifactId: "artifact-1",
  title: "report.txt",
  mimeType: "text/plain",
  digest,
  sizeBytes: contents.length,
  createdAt: 1,
  updatedAt: 1,
};
function publicMcpRevision(revision: string): string {
  return createHash("sha256").update(`public:${revision}`).digest("hex");
}
function publicServer(server: Record<string, unknown>) {
  return {
    name: server["name"],
    transport: server["transport"],
    ...(server["transport"] === "stdio"
      ? {
          commandLabel: "node",
          hasArguments: true,
          envKeys: Object.keys((server["env"] ?? {}) as object),
        }
      : {
          endpointLabel: "https://example.com",
          headerKeys: Object.keys((server["headers"] ?? {}) as object),
        }),
    source: {
      scope: "user",
      sourceId: "user",
      sourceLabel: "用户",
      readOnly: false,
      effective: true,
    },
  };
}
class FixtureRuntime implements GatewayRuntimeClient {
  constructor(
    readonly mcpStore?: UserMcpConfigStore,
    readonly userStore?: UserConfigStore,
    readonly workspacePath = session.workspacePath,
  ) {}
  mutateBetweenMcpReads = false;
  mcpReads = 0;
  readonly calls: { method: RuntimeMethod; params: unknown }[] = [];
  listener?: (notification: RuntimeNotification) => void;
  frames?: (frame: RuntimeSessionSubscriptionFrame) => void;
  closed = false;
  disposed = 0;
  corruptArtifact = false;
  supportsModelCatalog = false;
  supportsSecretPatch = true;
  supportsReviewIdempotency = false;
  supportsMemoryPagination = false;
  recoveryRun = false;
  supportsOwnership = true;
  supportsCleanupIsolation = true;
  async request<M extends RuntimeMethod>(
    method: M,
    params: RuntimeParams<M>,
  ): Promise<RuntimeResult<M>> {
    this.calls.push({ method, params });
    const record = params as Record<string, unknown>;
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
          ...(this.supportsModelCatalog ? [MODEL_CATALOG_RUNTIME_CAPABILITY] : []),
          ...(this.supportsSecretPatch ? [CONFIG_SECRET_PATCH_RUNTIME_CAPABILITY] : []),
          ...(this.supportsReviewIdempotency ? [REVIEW_IDEMPOTENCY_RUNTIME_CAPABILITY] : []),
          ...(this.supportsMemoryPagination ? [MEMORY_PAGINATION_RUNTIME_CAPABILITY] : []),
        ],
        picoHome: "/pico",
      };
    else if (method === "memory.list")
      value = record["paged"]
        ? { items: [], pageInfo: { revision: 1, counts: { active: 0, archived: 0, total: 0 } } }
        : { items: [] };
    else if (method === "changes.review")
      value = { accepted: true, fingerprint: record["expectedFingerprint"] };
    else if (method === "catalog.models") {
      assert.equal(record["workspacePath"], this.workspacePath);
      value = {
        routes: [
          {
            id: "fixture/catalog-model",
            providerId: "fixture",
            model: "catalog-model",
            displayName: "Catalog model",
            reasoningLevels: ["low", "high"],
          },
        ],
        defaultModelRouteId: "fixture/catalog-model",
      };
    } else if (method === "session.get") {
      if (record["sessionId"] !== session.sessionId)
        throw Object.assign(new Error("private details never cross transport"), {
          code: "NOT_FOUND",
        });
      value = { session };
    } else if (method === "session.list") value = { sessions: [session] };
    else if (method === "session.send") value = { session, disposition: "started" };
    else if (method === "runs.list")
      value = {
        runs: this.recoveryRun
          ? [
              {
                runId: "run-1",
                workspacePath: this.workspacePath,
                sessionId: session.sessionId,
                description: "fixture",
                status: "succeeded",
                startedAt: 1,
                updatedAt: 1,
                version: 1,
              },
            ]
          : [],
      };
    else if (method === "terminal.ownershipCapabilities") {
      if (!this.supportsOwnership)
        throw Object.assign(new Error("old daemon"), { code: "METHOD_NOT_FOUND" });
      value = {
        ownerIsolation: true,
        ...(this.supportsCleanupIsolation ? { sessionCleanupIsolation: true } : {}),
      };
    } else if (method === "terminal.list") value = { terminals: [] };
    else if (method === "terminal.create") throw new Error("fixture terminal unsupported");
    else if (method === "session.artifacts.query") {
      if (record["sessionId"] !== session.sessionId || record["artifactId"] !== artifact.artifactId)
        throw Object.assign(new Error("wrong owner"), { code: "NOT_FOUND" });
      if (record["action"] === "get") value = { revision: 1, artifacts: [artifact] };
      else {
        const offset = Number(record["offsetBytes"]);
        const end = Math.min(contents.length, offset + Number(record["limitBytes"]));
        const bytes = Buffer.from(contents.subarray(offset, end));
        if (this.corruptArtifact && bytes.length) bytes[0] = 0;
        value = {
          artifact,
          contentBase64: bytes.toString("base64"),
          offsetBytes: offset,
          endOffsetBytes: end,
          totalBytes: contents.length,
          truncated: end < contents.length,
        };
      }
    } else if (method === "session.subscription.open") {
      this.frames?.({
        hostEpoch: "host",
        subscriptionId: "session-sub",
        sessionId: session.sessionId,
        sequence: 1,
        type: "subscription.resource_changed",
        resource: "tasks",
        revision: 2,
      });
      value = {
        session,
        hostEpoch: "host",
        subscriptionId: "session-sub",
        nextSequence: 1,
        watermark: {
          historyEpoch: "history",
          projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
          throughSequence: 0,
        },
        durableTail: [],
        activeOverlay: [],
        queuedInputs: [],
      };
    } else if (method === "session.subscription.close") value = { closed: true };
    else if (method === "config.user.get" && this.userStore) {
      const current = await this.userStore.read();
      value = {
        config: {
          version: 1,
          defaults: {},
          providers: Object.entries(current.config.providers).map(([id, provider]) => {
            const { apiKey: _apiKey, ...safe } = provider;
            return { id, ...safe };
          }),
        },
        revision: publicMcpRevision(current.revision),
      };
    } else if (method === "provider.upsert" && this.userStore) {
      const current = await this.userStore.read();
      const { id, ...provider } = record["provider"] as { id: string } & Parameters<
        UserConfigStore["write"]
      >[0]["providers"][string];
      assert.equal(record["inputMode"], "public-patch");
      const previous = current.config.providers[id];
      if (previous?.baseURL && provider.baseURL === publicProviderEndpoint(previous.baseURL)) {
        provider.baseURL = previous.baseURL;
      }
      assert.equal(record["expectedRevision"], publicMcpRevision(current.revision));
      const next = await this.userStore.write(
        { ...current.config, providers: { ...current.config.providers, [id]: provider } },
        { expectedRevision: current.revision },
      );
      value = {
        provider: {
          id,
          ...provider,
          origin: "user",
          fingerprint: "fingerprint",
          credentialStatus: "ready",
          credentialSource: "config",
          storedCredentialPresent: false,
        },
        revision: publicMcpRevision(next.revision),
      };
    } else if (method === "config.get")
      value = {
        config: {
          lspServers: [
            {
              command: "lsp-command-secret",
              args: ["--token", "lsp-argument-secret"],
              env: { KEY: "lsp-secret" },
            },
          ],
        },
        version: 1,
      };
    else if (method === "plugin.manage")
      value = {
        result: {
          plugin: {
            env: { TOKEN: "plugin-secret" },
            manifest: { secret: "manifest-secret" },
            commands: [{ command: "echo secret" }],
            name: "safe-name",
          },
        },
      };
    else if (method === "hooks.manage")
      value = {
        result: {
          review: {
            handler: { command: "echo command-secret", env: { TOKEN: "hook-secret" } },
            handlerId: "safe-id",
            fingerprint: "safe-fingerprint",
          },
        },
      };
    else if (method === "mcp.user.list" && this.mcpStore) {
      this.mcpReads++;
      if (this.mutateBetweenMcpReads && this.mcpReads === 2) {
        const old = await this.mcpStore.read();
        await this.mcpStore.upsert(
          {
            name: "service",
            transport: "http",
            url: "https://example.com/private",
            headers: { Authorization: "new-concurrent-secret" },
          },
          { expectedRevision: old.revision, idempotencyKey: "concurrent-change" },
        );
      }
      const snapshot = await this.mcpStore.read();
      value = {
        revision: publicMcpRevision(snapshot.revision),
        servers: Object.values(snapshot.config.mcpServers).map((server) =>
          publicServer(server as unknown as Record<string, unknown>),
        ),
      };
    } else if (method === "mcp.user.upsert" && this.mcpStore) {
      const snapshot = await this.mcpStore.read();
      if (record["expectedRevision"] !== publicMcpRevision(snapshot.revision))
        throw Object.assign(new Error("stale revision"), { code: "MCP_CONFIG_REVISION_CONFLICT" });
      const server = record["server"] as Parameters<UserMcpConfigStore["upsert"]>[0];
      assert.equal(record["inputMode"], "public-patch");
      const result = await this.mcpStore.upsertPublicPatch(
        server,
        record["secretEdits"] as Parameters<UserMcpConfigStore["upsertPublicPatch"]>[1],
        {
          expectedRevision: snapshot.revision,
          idempotencyKey: String(record["idempotencyKey"]),
        },
      );
      value = {
        server: publicServer(
          result.snapshot.config.mcpServers[server.name] as unknown as Record<string, unknown>,
        ),
        revision: publicMcpRevision(result.resultRevision),
      };
    } else throw Object.assign(new Error("fixture unsupported"), { code: "METHOD_NOT_FOUND" });
    return value as RuntimeResult<M>;
  }
  async subscribe(
    _params: RuntimeParams<"events.subscribe">,
    listener: (event: RuntimeNotification) => void,
  ): Promise<{ replay: RuntimeResult<"events.subscribe">; dispose: () => void }> {
    this.listener = listener;
    return {
      replay: { subscribed: true, events: [], hasMore: false },
      dispose: () => {
        this.disposed++;
      },
    };
  }
  subscribeSessionFrames(listener: (frame: RuntimeSessionSubscriptionFrame) => void): {
    dispose: () => void;
  } {
    this.frames = listener;
    return {
      dispose: () => {
        this.frames = undefined;
      },
    };
  }
  close(): void {
    this.closed = true;
  }
}
async function fixture(options: { now?: () => number; ordinaryWorkspace?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pico-gateway-"));
  const key = join(root, "server.key");
  const cert = join(root, "server.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "ca.key"),
      "-out",
      join(root, "ca.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=Pico Integration CA",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      join(root, "server.csr"),
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(root, "extensions.cnf"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      join(root, "server.csr"),
      "-CA",
      join(root, "ca.pem"),
      "-CAkey",
      join(root, "ca.key"),
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-extfile",
      join(root, "extensions.cnf"),
    ],
    { stdio: "ignore" },
  );
  const net = createNetServer();
  net.listen(0, "127.0.0.1");
  await once(net, "listening");
  const port = (net.address() as { port: number }).port;
  await new Promise<void>((resolve) => net.close(() => resolve()));
  const home = join(root, "private");
  const workspacePath = options.ordinaryWorkspace
    ? join(root, "ordinary-folder")
    : session.workspacePath;
  if (options.ordinaryWorkspace) await mkdir(workspacePath);
  const config: GatewayConfig = {
    version: 1,
    publicUrl: `https://localhost:${port}`,
    port,
    certificatePath: cert,
    privateKeyPath: key,
    listenHosts: ["127.0.0.1"],
    workspaces: [{ id: "workspace-1", name: "project", path: workspacePath }],
    runtimeHostRootPath: join(root, "pico-home"),
  };
  const mcpStore = new UserMcpConfigStore({ picoHome: config.runtimeHostRootPath });
  const userStore = new UserConfigStore({ picoHome: config.runtimeHostRootPath });
  const runtimes = new Map<string, FixtureRuntime>();
  const gateway = await createRemoteGateway(config, {
    home,
    ...options,
    createRuntimeClient: (id) => {
      const runtime = new FixtureRuntime(mcpStore, userStore, workspacePath);
      runtimes.set(id, runtime);
      return runtime;
    },
  });
  await gateway.start();
  const ca = await readFile(join(root, "ca.pem"));
  const http = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    trust = true,
  ): Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    bytes: Buffer;
    json: unknown;
  }> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          method,
          path,
          ...(trust ? { ca } : {}),
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(data
              ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const bytes = Buffer.concat(chunks);
            let json: unknown;
            try {
              json = JSON.parse(bytes.toString("utf8"));
            } catch {
              /* binary download */
            }
            resolve({ status: res.statusCode!, headers: res.headers, bytes, json });
          });
        },
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  const pair = async () => {
    const offer = (await requestGatewayControl(home, "pair.offer")) as RemotePairingOffer & {
      pairingId: string;
    };
    const submitted = (
      await http("POST", "/v1/pairings", undefined, {
        version: 1,
        gatewayId: offer.gatewayId,
        secret: offer.secret,
        deviceName: "测试手机",
        platform: "ios",
      })
    ).json as RemotePairingSubmitted;
    await requestGatewayControl(home, "pair.approve", { pairingId: submitted.pairingId });
    const granted = (
      await http("GET", `/v1/pairings/${submitted.pairingId}`, submitted.pairingToken)
    ).json as Extract<RemotePairingStatus, { status: "approved" }>;
    assert.equal(granted.status, "approved");
    return { offer, submitted, granted };
  };
  return {
    root,
    home,
    config,
    gateway,
    ca,
    port,
    runtimes,
    mcpStore,
    userStore,
    http,
    pair,
    cleanup: async () => {
      await gateway.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("HTTPS 配对、本机批准与 ACK、RPC 授权、摘要下载和撤销构成完整链路", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.http("GET", "/v1/health", undefined, undefined, false));
    assert.equal((await f.http("GET", "/v1/workspaces")).status, 401);
    const { offer, submitted, granted } = await f.pair();
    assert.equal(
      (await f.http("GET", "/v1/workspaces", granted.deviceToken)).status,
      401,
      "未 ACK 的设备不能访问业务",
    );
    assert.equal(
      (await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken))
        .status,
      200,
    );
    assert.equal(
      (await f.http("GET", `/v1/pairings/${submitted.pairingId}`, submitted.pairingToken)).json &&
        JSON.stringify(
          (await f.http("GET", `/v1/pairings/${submitted.pairingId}`, submitted.pairingToken)).json,
        ).includes(granted.deviceToken),
      false,
      "ACK 后不再返回明文令牌",
    );
    const persisted = await readFile(join(f.home, "devices.json"), "utf8");
    assert.equal(persisted.includes(granted.deviceToken), false);
    assert.equal(
      (
        await f.http("POST", "/v1/pairings", undefined, {
          version: 1,
          gatewayId: offer.gatewayId,
          secret: offer.secret,
          deviceName: "duplicate",
          platform: "android",
        })
      ).status,
      410,
    );
    const workspaces = await f.http("GET", "/v1/workspaces", granted.deviceToken);
    assert.equal(workspaces.status, 200);
    assert.deepEqual(workspaces.json, { workspaces: [{ id: "workspace-1", label: "project" }] });
    const rpc = (method: string, params: unknown = {}, workspaceId = "workspace-1") =>
      f.http("POST", "/v1/rpc", granted.deviceToken, {
        version: 1,
        requestId: "request-1",
        workspaceId,
        method,
        params,
      });
    assert.equal((await rpc("session.list")).status, 200);
    const runtime = f.runtimes.get(granted.deviceId)!;
    assert.deepEqual(runtime.calls.find((call) => call.method === "session.list")?.params, {
      workspacePath: session.workspacePath,
    });
    assert.equal((await rpc("session.list", {}, "other-workspace")).status, 403);
    assert.equal((await rpc("session.list", { workspacePath: "/escape" })).status, 403);
    assert.equal(
      (
        await rpc("session.settings.update", {
          sessionId: session.sessionId,
          permissionMode: "full-access",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await rpc("session.send", {
          input: { kind: "text", text: "hi" },
          idempotencyKey: "initial-1",
          initialSettings: { permissionMode: "full-access" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await rpc("sideChat.create", {
          sourceSessionId: "foreign-session",
          panelId: "panel",
          idempotencyKey: "side-1",
        })
      ).status,
      404,
    );
    assert.equal((await rpc("terminal.create", { sessionId: session.sessionId })).status, 403);
    assert.equal((await rpc("terminal.stopAll")).status, 400, "unknown methods never forward");
    assert.equal(
      runtime.calls.some((call) => call.method === "terminal.stopAll"),
      false,
    );
    const missing = await rpc("session.send", {
      sessionId: "foreign-session",
      input: { kind: "text", text: "hello" },
      idempotencyKey: "idem-1",
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.bytes.includes(Buffer.from("private details")), false);
    const download = await f.http(
      "GET",
      `/v1/workspaces/workspace-1/sessions/${session.sessionId}/artifacts/${artifact.artifactId}/content`,
      granted.deviceToken,
    );
    assert.equal(download.status, 200);
    assert.deepEqual(download.bytes, contents);
    assert.equal(download.headers["x-pico-sha256"], digest);
    assert.equal(
      (
        await f.http(
          "GET",
          `/v1/workspaces/workspace-1/sessions/foreign-session/artifacts/${artifact.artifactId}/content`,
          granted.deviceToken,
        )
      ).status,
      404,
    );
    runtime.corruptArtifact = true;
    await assert.rejects(
      f.http(
        "GET",
        `/v1/workspaces/workspace-1/sessions/${session.sessionId}/artifacts/${artifact.artifactId}/content`,
        granted.deviceToken,
      ),
    );
    await requestGatewayControl(f.home, "devices.revoke", { deviceId: granted.deviceId });
    assert.equal((await f.http("GET", "/v1/workspaces", granted.deviceToken)).status, 401);
    assert.equal(runtime.closed, true);
    if (process.platform !== "win32") {
      assert.equal((await stat(f.home)).mode & 0o777, 0o700);
      assert.equal((await stat(join(f.home, "devices.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await f.cleanup();
  }
});

test("HTTPS 请求体尚未读完时也占用设备的并发预算", async () => {
  const f = await fixture();
  const partials: import("node:http").ClientRequest[] = [];
  try {
    const { submitted, granted } = await f.pair();
    await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken);
    for (let index = 0; index < 16; index++) {
      const req = request({
        hostname: "127.0.0.1",
        port: f.port,
        method: "POST",
        path: "/v1/rpc",
        ca: f.ca,
        headers: {
          Authorization: `Bearer ${granted.deviceToken}`,
          "Content-Type": "application/json",
          "Content-Length": 512,
          Expect: "100-continue",
        },
      });
      req.on("error", () => {});
      partials.push(req);
      const continued = once(req, "continue");
      req.flushHeaders();
      await continued;
      req.write("{");
    }
    const overflow = await f.http("POST", "/v1/rpc", granted.deviceToken, {
      version: 1,
      requestId: "overflow",
      workspaceId: "workspace-1",
      method: "session.list",
      params: {},
    });
    assert.equal(overflow.status, 429);
    assert.equal(
      f.runtimes.get(granted.deviceId)!.calls.some((call) => call.method === "session.list"),
      false,
    );
  } finally {
    for (const req of partials) req.destroy();
    await f.cleanup();
  }
});

test("手机聊天媒体通过 HTTPS 登记和校验后交付，失效引用、伪造内容和撤销设备被拒绝", async () => {
  const f = await fixture();
  try {
    const { submitted, granted } = await f.pair();
    assert.equal(
      (await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken))
        .status,
      200,
    );
    const port: RuntimePort = {
      request: async <M extends RemoteMethod>(method: M, params: RemoteParams<M>) => {
        const response = await f.http("POST", "/v1/rpc", granted.deviceToken, {
          version: 1,
          requestId: "mobile-media",
          workspaceId: "workspace-1",
          method,
          params,
        });
        const body = response.json as RemoteResponse;
        if (!body.ok) throw Object.assign(new Error(body.error.message), { code: body.error.code });
        assert.equal(response.status, 200);
        return parseRuntimeResult(method, body.value);
      },
    };
    await port.request("session.list", {});
    const runtime = f.runtimes.get(granted.deviceId)!;
    const originalRequest = runtime.request.bind(runtime);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sVQAAAAASUVORK5CYII=",
      "base64",
    );
    const fakePng = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const resources = new Map(
      [png, fakePng].map((bytes, index) => {
        const metadata = {
          ...artifact,
          artifactId: `media-${index}`,
          title: `image-${index}.png`,
          mimeType: "image/png",
          sizeBytes: bytes.length,
          digest: createHash("sha256").update(bytes).digest("hex"),
        };
        return [metadata.artifactId, { metadata, bytes }] as const;
      }),
    );
    const metadata = resources.get("media-0")!.metadata;
    const media: RuntimeMediaReference = {
      artifactId: metadata.artifactId,
      mimeType: metadata.mimeType,
      sizeBytes: metadata.sizeBytes,
      digest: metadata.digest,
      kind: "image",
      alt: "生成图片",
    };
    let corrupt = false;
    runtime.request = async <M extends RuntimeMethod>(method: M, params: RuntimeParams<M>) => {
      if (method === "session.subscription.open") {
        const snapshot = (await originalRequest(
          method,
          params,
        )) as RuntimeResult<"session.subscription.open">;
        return {
          ...snapshot,
          watermark: { ...snapshot.watermark, throughSequence: 1 },
          durableTail: [
            {
              itemId: "answer-media",
              itemRevision: 1,
              positionSequence: 1,
              positionOrdinal: 0,
              item: {
                id: "answer-media",
                kind: "assistantMessage",
                content: "生成图片",
                media: [media],
              },
            },
          ],
        } as RuntimeResult<M>;
      }
      if (method !== "session.artifacts.query") return originalRequest(method, params);
      runtime.calls.push({ method, params });
      const query = params as RuntimeParams<"session.artifacts.query">;
      const resource = resources.get(query.artifactId ?? "");
      if (query.sessionId !== session.sessionId || !resource)
        throw Object.assign(new Error("wrong media owner"), { code: "NOT_FOUND" });
      if (query.action === "get")
        return { revision: 1, artifacts: [resource.metadata] } as RuntimeResult<M>;
      const offset = query.offsetBytes!;
      const end = Math.min(resource.bytes.length, offset + query.limitBytes!);
      const bytes = Buffer.from(resource.bytes.subarray(offset, end));
      if (corrupt && bytes.length) bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      return {
        artifact: resource.metadata,
        contentBase64: bytes.toString("base64"),
        offsetBytes: offset,
        endOffsetBytes: end,
        totalBytes: resource.bytes.length,
        truncated: end < resource.bytes.length,
      } as RuntimeResult<M>;
    };
    const snapshot = await port.request("session.subscription.open", {
      sessionId: session.sessionId,
    });
    const received = snapshot.durableTail[0]!.item;
    assert.equal(received.kind, "assistantMessage");
    assert.deepEqual(received.media, [media]);
    const registered = await resolveMediaArtifact(port, session.sessionId, media);
    assert.equal(registered.artifactId, media.artifactId);
    const download = (id = media.artifactId, sessionId = session.sessionId) =>
      f.http(
        "GET",
        `/v1/workspaces/workspace-1/sessions/${sessionId}/artifacts/${id}/content`,
        granted.deviceToken,
      );
    const result = await download();
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, png);
    assert.equal(result.headers["x-pico-sha256"], media.digest);
    verifyMediaIntegrity(
      media,
      result.bytes.length,
      createHash("sha256").update(result.bytes).digest("hex"),
      result.bytes,
    );
    for (const [id, sessionId] of [
      ["unknown-media", session.sessionId],
      [media.artifactId, "foreign-session"],
    ]) {
      await assert.rejects(resolveMediaArtifact(port, sessionId!, { ...media, artifactId: id! }), {
        code: "NOT_FOUND",
      });
      assert.equal((await download(id, sessionId)).status, 404);
    }
    await assert.rejects(
      resolveMediaArtifact(port, session.sessionId, { ...media, digest: "0".repeat(64) }),
      /登记信息已改变/,
    );
    const fake = resources.get("media-1")!.metadata;
    const fakeMedia = {
      ...media,
      artifactId: fake.artifactId,
      sizeBytes: fake.sizeBytes,
      digest: fake.digest,
    };
    await resolveMediaArtifact(port, session.sessionId, fakeMedia);
    const forged = await download(fakeMedia.artifactId);
    assert.equal(forged.status, 200, "摘要正确的伪造格式由手机内容校验拒绝");
    assert.throws(
      () => verifyMediaIntegrity(fakeMedia, forged.bytes.length, fakeMedia.digest, forged.bytes),
      /内容与声明格式不符/,
    );
    corrupt = true;
    assert.equal((await download()).status, 502, "摘要损坏的媒体不能完成下载");
    await requestGatewayControl(f.home, "devices.revoke", { deviceId: granted.deviceId });
    assert.equal((await download()).status, 401);
  } finally {
    await f.cleanup();
  }
});

test("WSS 认证、工作区订阅、连接替换和设备撤销不取消电脑任务", async () => {
  const f = await fixture();
  try {
    const { submitted, granted } = await f.pair();
    await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken);
    const url = `wss://127.0.0.1:${f.port}/v1/events`;
    const open = () =>
      new WebSocket(url, {
        ca: f.ca,
        headers: { Authorization: `Bearer ${granted.deviceToken}` },
      });
    const socket = open();
    const ready = once(socket, "message");
    await once(socket, "open");
    assert.equal(JSON.parse(String((await ready)[0])).type, "ready");
    const subscribed = once(socket, "message");
    socket.send(
      JSON.stringify({ type: "subscribe", subscriptionId: "events-1", workspaceId: "workspace-1" }),
    );
    assert.equal(JSON.parse(String((await subscribed)[0])).type, "subscribed");
    const denied = once(socket, "message");
    socket.send(JSON.stringify({ type: "subscribe", subscriptionId: "bad", workspaceId: "other" }));
    assert.equal(JSON.parse(String((await denied)[0])).error.code, "FORBIDDEN");
    const runtime = f.runtimes.get(granted.deviceId)!;
    const earlyFrame = once(socket, "message");
    const opened = await f.http("POST", "/v1/rpc", granted.deviceToken, {
      version: 1,
      requestId: "open-session",
      workspaceId: "workspace-1",
      method: "session.subscription.open",
      params: { sessionId: session.sessionId },
    });
    assert.equal(opened.status, 200);
    assert.equal(
      JSON.parse(String((await earlyFrame)[0])).frame.sequence,
      1,
      "先于 RPC 响应的已授权会话帧被补齐",
    );
    const previousClosed = once(socket, "close");
    const replacement = open();
    await once(replacement, "open");
    await previousClosed;
    assert.ok(runtime.disposed >= 1);
    const closed = once(replacement, "close");
    await requestGatewayControl(f.home, "devices.revoke", { deviceId: granted.deviceId });
    await closed;
    assert.equal(
      runtime.calls.some((call) =>
        ["run.cancel", "terminal.stopAll", "terminal.stopOwned"].includes(call.method),
      ),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("未 ACK 配对在网关重启后失效，状态目录符号链接与重复实例被拒绝", async () => {
  const f = await fixture();
  try {
    const { granted } = await f.pair();
    const other = await createRemoteGateway(f.config, {
      home: f.home,
      createRuntimeClient: () => new FixtureRuntime(),
    });
    await assert.rejects(other.start(), /已有远程网关/);
    await f.gateway.close();
    const replacement = await createRemoteGateway(f.config, {
      home: f.home,
      createRuntimeClient: () => new FixtureRuntime(),
    });
    await replacement.start();
    try {
      assert.equal((await f.http("GET", "/v1/workspaces", granted.deviceToken)).status, 401);
    } finally {
      await replacement.close();
    }
    if (process.platform !== "win32") {
      const linked = join(f.root, "linked");
      await symlink(f.home, linked);
      await assert.rejects(createRemoteGateway(f.config, { home: linked }), /符号链接/);
    }
  } finally {
    await f.cleanup();
  }
});

test("MCP 秘密默认保留、显式编辑、并发 revision 拒绝与旧终端宿主失效保护", async () => {
  const f = await fixture();
  try {
    const { submitted, granted } = await f.pair();
    await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken);
    await requestGatewayControl(f.home, "devices.grant", {
      deviceId: granted.deviceId,
      permissions: ["workspace.read", "session.control", "host.admin", "terminal.control"],
      workspaceIds: ["workspace-1"],
    });
    const initial = await f.mcpStore.read();
    await f.mcpStore.upsert(
      {
        name: "service",
        transport: "http",
        url: "https://example.com/private?key=hidden",
        headers: { Authorization: "original-secret", "X-Remove": "remove-secret" },
      },
      { expectedRevision: initial.revision, idempotencyKey: "seed" },
    );
    const before = await f.mcpStore.read();
    const update = await f.http("POST", "/v1/rpc", granted.deviceToken, {
      version: 1,
      requestId: "mcp-1",
      method: "mcp.user.upsert",
      params: {
        server: { name: "service", transport: "http", enabled: false },
        expectedRevision: publicMcpRevision(before.revision),
        idempotencyKey: "update-1",
      },
      secretEdits: {
        headers: {
          "X-Remove": { action: "remove" },
          "X-New": { action: "set", value: "new-secret" },
        },
      },
    });
    assert.equal(update.status, 200);
    const after = await f.mcpStore.read();
    const saved = after.config.mcpServers["service"] as {
      url: string;
      headers: Record<string, string>;
    };
    assert.equal(saved.url, "https://example.com/private?key=hidden");
    assert.equal(saved.headers["Authorization"], "original-secret");
    assert.equal(saved.headers["X-Remove"], undefined);
    assert.equal(saved.headers["X-New"], "new-secret");
    assert.equal(update.bytes.includes(Buffer.from("original-secret")), false);
    assert.equal(update.bytes.includes(Buffer.from("new-secret")), false);
    assert.equal(update.bytes.includes(Buffer.from("key=hidden")), false);
    const runtime = f.runtimes.get(granted.deviceId)!;
    runtime.mcpReads = 0;
    await f.mcpStore.upsert(
      {
        name: "service",
        transport: "http",
        url: "https://example.com/private",
        headers: { Authorization: "new-concurrent-secret" },
      },
      { expectedRevision: after.revision, idempotencyKey: "concurrent-change" },
    );
    const conflict = await f.http("POST", "/v1/rpc", granted.deviceToken, {
      version: 1,
      requestId: "mcp-2",
      method: "mcp.user.upsert",
      params: {
        server: { name: "service", transport: "http", enabled: true },
        expectedRevision: publicMcpRevision(after.revision),
        idempotencyKey: "update-2",
      },
    });
    assert.equal(conflict.status, 409);
    assert.equal(runtime.calls.filter((call) => call.method === "mcp.user.upsert").length, 2);
    assert.equal(runtime.mcpReads, 0, "Gateway must not read raw configuration before patching");
    runtime.supportsSecretPatch = false;
    const oldHost = await f.http("GET", "/v1/capabilities", granted.deviceToken);
    assert.equal(
      (oldHost.json as { methods: string[] }).methods.includes("mcp.user.upsert"),
      false,
    );
    assert.equal(
      (oldHost.json as { methods: string[] }).methods.includes("provider.upsert"),
      false,
    );
    const unavailable = await f.http("POST", "/v1/rpc", granted.deviceToken, {
      version: 1,
      requestId: "old-patch",
      method: "mcp.user.upsert",
      params: {
        server: { name: "service", transport: "http" },
        expectedRevision: publicMcpRevision(after.revision),
        idempotencyKey: "old-patch",
      },
    });
    assert.equal(unavailable.status, 409);
    assert.equal(runtime.calls.filter((call) => call.method === "mcp.user.upsert").length, 2);
    const concurrent = (await f.mcpStore.read()).config.mcpServers["service"] as {
      headers: Record<string, string>;
    };
    assert.equal(concurrent.headers["Authorization"], "new-concurrent-secret");
    runtime.supportsCleanupIsolation = false;
    const legacyCapabilities = await f.http("GET", "/v1/capabilities", granted.deviceToken);
    assert.equal(
      (legacyCapabilities.json as { methods: string[] }).methods.includes("session.list"),
      false,
    );
    for (const method of ["session.list", "session.delete", "sideChat.create", "sideChat.close"]) {
      const before = runtime.calls.filter((call) => call.method === method).length;
      const cleanup = await f.http("POST", "/v1/rpc", granted.deviceToken, {
        version: 1,
        requestId: `legacy-${method}`,
        method,
        workspaceId: "workspace-1",
        params: { sessionId: session.sessionId },
      });
      assert.equal(cleanup.status, 409);
      assert.equal(runtime.calls.filter((call) => call.method === method).length, before);
    }
    runtime.supportsOwnership = false;
    const terminal = await f.http("POST", "/v1/rpc", granted.deviceToken, {
      version: 1,
      requestId: "terminal-1",
      method: "terminal.create",
      workspaceId: "workspace-1",
      params: { sessionId: session.sessionId },
    });
    assert.equal(terminal.status, 403);
    assert.equal(
      runtime.calls.some((call) => call.method === "terminal.create"),
      false,
    );
    const capabilities = await f.http("GET", "/v1/capabilities", granted.deviceToken);
    assert.equal(
      (capabilities.json as { features: { terminal: { available: boolean } } }).features.terminal
        .available,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("五分钟配对有效期和持久化 ACK 后的授权重启恢复", async () => {
  // Certificate generation may cross a second boundary; freeze only after TLS startup.
  let now: number | undefined;
  const f = await fixture({ now: () => now ?? Date.now() });
  now = Date.now();
  try {
    const expired = (await requestGatewayControl(f.home, "pair.offer")) as RemotePairingOffer;
    now += 5 * 60_000 + 1;
    assert.equal(
      (
        await f.http("POST", "/v1/pairings", undefined, {
          version: 1,
          gatewayId: expired.gatewayId,
          secret: expired.secret,
          deviceName: "late",
          platform: "ios",
        })
      ).status,
      410,
    );
    const { submitted, granted } = await f.pair();
    await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken);
    await f.gateway.close();
    const replacement = await createRemoteGateway(f.config, {
      home: f.home,
      now: () => now ?? Date.now(),
      createRuntimeClient: () => new FixtureRuntime(),
    });
    await replacement.start();
    try {
      assert.equal((await f.http("GET", "/v1/workspaces", granted.deviceToken)).status, 200);
    } finally {
      await replacement.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("配置、Provider URL、插件与 Hooks 不返回秘密，非敏感 Provider 编辑保留原 query", async () => {
  const f = await fixture();
  try {
    const { submitted, granted } = await f.pair();
    await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken);
    await requestGatewayControl(f.home, "devices.grant", {
      deviceId: granted.deviceId,
      permissions: ["workspace.read", "host.admin"],
      workspaceIds: ["workspace-1"],
    });
    const initial = await f.userStore.read();
    await f.userStore.write(
      {
        version: 1,
        providers: {
          example: {
            protocol: "openai",
            baseURL: "https://example.com/v1?key=query-secret",
            apiKeyEnv: "EXAMPLE_KEY",
            models: ["model"],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: initial.revision },
    );
    const rpc = (method: string, params: unknown, workspaceId?: string) =>
      f.http("POST", "/v1/rpc", granted.deviceToken, {
        version: 1,
        requestId: method,
        method,
        params,
        ...(workspaceId ? { workspaceId } : {}),
      });
    const user = await rpc("config.user.get", {});
    assert.equal(user.status, 200);
    assert.equal(user.bytes.includes(Buffer.from("query-secret")), false);
    const projected = (
      user.json as { value: { revision: string; config: { providers: Record<string, unknown>[] } } }
    ).value;
    const provider = projected.config.providers[0]!;
    assert.equal(provider["baseURL"], "https://example.com/v1");
    const updated = await rpc("provider.upsert", {
      provider: { ...provider, models: ["new-model"] },
      expectedRevision: projected.revision,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.bytes.includes(Buffer.from("query-secret")), false);
    assert.equal(
      (await f.userStore.read()).config.providers["example"]?.baseURL,
      "https://example.com/v1?key=query-secret",
    );
    for (const [method, params] of [
      ["config.get", {}],
      ["plugin.manage", { action: "inspect", id: "plugin", scope: "user" }],
      ["hooks.manage", { action: "review", handlerId: "handler" }],
    ] as const) {
      const result = await rpc(method, params, "workspace-1");
      assert.equal(result.status, 200);
      assert.equal(result.bytes.toString("utf8").includes("-secret"), false);
    }
  } finally {
    await f.cleanup();
  }
});

test("模型目录能力兼容旧 Host，项目读取不扩大普通目录的配置管理权限", async () => {
  const f = await fixture({ ordinaryWorkspace: true });
  try {
    const { submitted, granted } = await f.pair();
    await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken);
    await requestGatewayControl(f.home, "devices.grant", {
      deviceId: granted.deviceId,
      permissions: ["workspace.read"],
      workspaceIds: ["workspace-1"],
    });
    const rpc = (method: RemoteMethod, params: unknown = {}, workspaceId = "workspace-1") =>
      f.http("POST", "/v1/rpc", granted.deviceToken, {
        version: 1,
        requestId: `catalog-${method}`,
        method,
        workspaceId,
        params,
      });
    const capabilities = () => f.http("GET", "/v1/capabilities", granted.deviceToken);
    const old = await capabilities();
    const runtime = f.runtimes.get(granted.deviceId)!;
    const oldValue = old.json as {
      methods: string[];
      features: { modelCatalog: { available: boolean; reason?: string } };
    };
    assert.equal(oldValue.methods.includes("catalog.models"), false);
    assert.equal(oldValue.features.modelCatalog.available, false);
    assert.match(oldValue.features.modelCatalog.reason ?? "", /更新/u);
    const unsupported = await rpc("catalog.models");
    assert.equal(unsupported.status, 404);
    assert.equal((unsupported.json as RemoteResponse).ok, false);
    assert.equal(
      runtime.calls.some((call) => call.method === "catalog.models"),
      false,
      "old Host methods are never dispatched even if the client calls them directly",
    );

    runtime.supportsModelCatalog = true;
    const modern = await capabilities();
    const modernValue = modern.json as {
      methods: string[];
      features: { modelCatalog: { available: boolean } };
    };
    assert.equal(modernValue.methods.includes("catalog.models"), true);
    assert.equal(modernValue.features.modelCatalog.available, true);
    const catalog = await rpc("catalog.models");
    assert.equal(catalog.status, 200);
    assert.deepEqual((catalog.json as { value: unknown }).value, {
      routes: [
        {
          id: "fixture/catalog-model",
          providerId: "fixture",
          model: "catalog-model",
          displayName: "Catalog model",
          reasoningLevels: ["low", "high"],
        },
      ],
      defaultModelRouteId: "fixture/catalog-model",
    });
    const workspacePath = f.config.workspaces[0]!.path;
    assert.deepEqual(runtime.calls.find((call) => call.method === "catalog.models")?.params, {
      workspacePath,
    });
    assert.equal(catalog.bytes.includes(Buffer.from(workspacePath)), false);
    await assert.rejects(
      stat(join(workspacePath, ".git")),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
    const catalogCalls = runtime.calls.filter((call) => call.method === "catalog.models").length;
    assert.equal((await rpc("catalog.models", {}, "unapproved-workspace")).status, 403);
    assert.equal((await rpc("catalog.models", { workspacePath: "/escape" })).status, 403);
    assert.equal(
      runtime.calls.filter((call) => call.method === "catalog.models").length,
      catalogCalls,
    );
    for (const method of [
      "provider.list",
      "config.get",
      "config.user.get",
      "provider.credential.status",
    ] as const) {
      assert.equal(modernValue.methods.includes(method), false);
      const before = runtime.calls.filter((call) => call.method === method).length;
      assert.equal(
        (
          await rpc(
            method,
            method === "provider.credential.status" ? { providerId: "fixture" } : {},
          )
        ).status,
        403,
      );
      assert.equal(runtime.calls.filter((call) => call.method === method).length, before);
    }
    const beforeAdmin = runtime.calls.length;
    assert.equal(
      (
        await rpc("config.user.update", {
          defaults: { permissionMode: "full-access" },
          expectedRevision: "opaque",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await rpc("provider.upsert", {
          provider: {
            id: "fixture",
            protocol: "openai",
            baseURL: "https://fixture.invalid/v1",
            apiKeyEnv: "FIXTURE_KEY",
            models: ["catalog-model"],
            discoverModels: false,
          },
          expectedRevision: "opaque",
        })
      ).status,
      403,
    );
    assert.equal(
      runtime.calls.length,
      beforeAdmin,
      "selection access never dispatches admin configuration commands",
    );

    await requestGatewayControl(f.home, "devices.grant", {
      deviceId: granted.deviceId,
      permissions: ["session.control"],
      workspaceIds: ["workspace-1"],
    });
    await capabilities();
    f.runtimes.get(granted.deviceId)!.supportsModelCatalog = true;
    const noRead = await capabilities();
    const noReadValue = noRead.json as {
      methods: string[];
      features: { modelCatalog: { available: boolean; reason?: string } };
    };
    assert.equal(noReadValue.methods.includes("catalog.models"), false);
    assert.equal(noReadValue.features.modelCatalog.available, false);
    assert.match(noReadValue.features.modelCatalog.reason ?? "", /读取权限/u);
    assert.equal((await rpc("catalog.models")).status, 403);
  } finally {
    await f.cleanup();
  }
});

test("审阅幂等和记忆分页仅向支持的 Host 转发，沿用原权限与旧响应", async () => {
  const f = await fixture({ ordinaryWorkspace: true });
  try {
    const { submitted, granted } = await f.pair();
    await f.http("POST", `/v1/pairings/${submitted.pairingId}/ack`, submitted.pairingToken);
    await requestGatewayControl(f.home, "devices.grant", {
      deviceId: granted.deviceId,
      permissions: ["workspace.read", "session.control", "host.admin"],
      workspaceIds: ["workspace-1"],
    });
    const rpc = (method: RemoteMethod, params: unknown) =>
      f.http("POST", "/v1/rpc", granted.deviceToken, {
        version: 1,
        requestId: `recovery-${method}`,
        method,
        workspaceId: "workspace-1",
        params,
      });
    await f.http("GET", "/v1/capabilities", granted.deviceToken);
    const runtime = f.runtimes.get(granted.deviceId)!;
    runtime.recoveryRun = true;
    const review = {
      runId: "run-1",
      decision: "request_changes",
      message: "请修正",
      expectedFingerprint: "fp",
      idempotencyKey: "operation-1",
    };
    assert.equal((await rpc("changes.review", review)).status, 404);
    assert.equal((await rpc("memory.list", { paged: true, limit: 50 })).status, 404);
    assert.equal(
      runtime.calls.some(
        (call) => call.method === "changes.review" || call.method === "memory.list",
      ),
      false,
    );
    assert.deepEqual((await rpc("memory.list", { limit: 50 })).json, {
      requestId: "recovery-memory.list",
      ok: true,
      value: { items: [] },
    });
    runtime.supportsReviewIdempotency = true;
    runtime.supportsMemoryPagination = true;
    const caps = (await f.http("GET", "/v1/capabilities", granted.deviceToken)).json as {
      features: Record<string, { available: boolean }>;
    };
    assert.equal(caps.features.reviewIdempotency!.available, true);
    assert.equal(caps.features.memoryPagination!.available, true);
    assert.equal((await rpc("changes.review", review)).status, 200);
    assert.deepEqual(runtime.calls.find((call) => call.method === "changes.review")!.params, {
      ...review,
      workspacePath: runtime.workspacePath,
    });
    const page = await rpc("memory.list", { paged: true, limit: 50 });
    assert.equal(page.status, 200);
    assert.equal(
      (page.json as { value: { pageInfo: { revision: number } } }).value.pageInfo.revision,
      1,
    );
    await requestGatewayControl(f.home, "devices.grant", {
      deviceId: granted.deviceId,
      permissions: ["workspace.read"],
      workspaceIds: ["workspace-1"],
    });
    const ordinary = (await f.http("GET", "/v1/capabilities", granted.deviceToken)).json as {
      features: Record<string, { available: boolean }>;
    };
    assert.equal(ordinary.features.reviewIdempotency!.available, false);
    assert.equal(ordinary.features.memoryPagination!.available, false);
    assert.equal((await rpc("memory.list", { paged: true, limit: 50 })).status, 403);
    assert.equal((await rpc("changes.review", review)).status, 403);
  } finally {
    await f.cleanup();
  }
});

test("supervised Gateway rejects stale intent before binding and reports its running build across manifest updates", async () => {
  const f = await fixture();
  try {
    await f.gateway.close();
    const {
      setGatewayDesiredRunning,
      beginGatewayMaintenance,
      readGatewayServiceState,
      writeActiveGatewayRuntime,
    } = await import("../../../packages/remote-gateway/src/supervision-state.js");
    const runtime = {
      schemaVersion: 1 as const,
      buildId: "registered-new",
      executablePath: process.execPath,
      gatewayPath: f.config.certificatePath,
      runtimeHome: f.config.runtimeHostRootPath!,
      pathEntries: [],
    };
    await writeActiveGatewayRuntime(f.home, runtime);
    const enabled = await setGatewayDesiredRunning(f.home, true);
    let bootstraps = 0;
    const gateway = await createRemoteGateway(f.config, {
      home: f.home,
      buildId: "running-old",
      supervisionGeneration: enabled.generation,
      createRuntimeClient: () => {
        bootstraps++;
        return new FixtureRuntime();
      },
    });
    await gateway.start();
    try {
      await writeActiveGatewayRuntime(f.home, { ...runtime, buildId: "registered-next" });
      assert.equal(
        ((await gateway.manage("status", {})) as { buildId: string }).buildId,
        "running-old",
      );
    } finally {
      await gateway.close();
    }
    await beginGatewayMaintenance(f.home, "running-old");
    const attempts = [enabled.generation, (await readGatewayServiceState(f.home)).generation, NaN];
    for (const generation of attempts) {
      const rejected = await createRemoteGateway(f.config, {
        home: f.home,
        supervisionGeneration: generation,
        createRuntimeClient: () => {
          bootstraps++;
          return new FixtureRuntime();
        },
      });
      await assert.rejects(rejected.start(), /GATEWAY_SUPERVISION_INTENT_CHANGED/);
    }
    await setGatewayDesiredRunning(f.home, false);
    const stopped = await readGatewayServiceState(f.home);
    const rejected = await createRemoteGateway(f.config, {
      home: f.home,
      supervisionGeneration: stopped.generation,
      createRuntimeClient: () => {
        bootstraps++;
        return new FixtureRuntime();
      },
    });
    await assert.rejects(rejected.start(), /GATEWAY_SUPERVISION_INTENT_CHANGED/);
    assert.equal(bootstraps, 1, "rejected intents must not connect or start Runtime");
  } finally {
    await f.cleanup();
  }
});
