import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { operationalDatabasePath } from "@pico/storage";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import {
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";
import { LocalRuntimeClient } from "@pico/pico-host/local-runtime-client";
import {
  TestRuntimeHostCandidateTracker,
  stopTestChildProcess,
} from "../helpers/test-runtime-daemon.js";

test(
  "真实 Electron 追踪：生产 IPC/daemon/SQLite 自动刷新、三页历史、选择折叠与剪贴板",
  { skip: !process.env.PICO_TEST_ELECTRON, timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-trace-electron-"));
    const picoHome = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(picoHome);
    await mkdir(workspace);
    const workspacePath = await realpath(workspace);
    const previousHome = process.env.PICO_HOME;
    process.env.PICO_HOME = picoHome;
    const candidates = new TestRuntimeHostCandidateTracker();
    const client = new LocalRuntimeClient({
      runtimeHostRootPath: picoHome,
      candidateLauncher: candidates.launcher,
    });
    t.after(async () => {
      restore();
      database?.close();
      database = undefined;
      client.close();
      await candidates.stopAll();
      if (previousHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    let calls = 0;
    let database: DatabaseSync | undefined;
    let renamed = false;
    let corrupted: { event_id: string; payload_json: string } | undefined;
    const restore = () => {
      if (renamed) {
        database!.exec("ALTER TABLE fixture_runtime_events RENAME TO runtime_events");
        renamed = false;
      }
      if (corrupted) {
        database!
          .prepare("UPDATE runtime_events SET payload_json=? WHERE event_id=?")
          .run(corrupted.payload_json, corrupted.event_id);
        corrupted = undefined;
      }
    };

    const server = createServer(async (req, res) => {
      if (["/fault", "/corrupt", "/restore"].includes(req.url ?? "")) {
        try {
          database ??= new DatabaseSync(
            operationalDatabasePath(resolvePicoPaths(workspacePath, { picoHome }).workspace.root),
          );
          if (req.url === "/fault") {
            database.exec("ALTER TABLE runtime_events RENAME TO fixture_runtime_events");
            renamed = true;
          } else if (req.url === "/corrupt") {
            corrupted = database
              .prepare(
                "SELECT event_id,payload_json FROM runtime_events WHERE kind='model.call.settled' ORDER BY event_seq DESC LIMIT 1",
              )
              .get() as typeof corrupted;
            assert.ok(corrupted);
            database
              .prepare(
                "UPDATE runtime_events SET payload_json=json_set(payload_json,'$.schemaVersion',999) WHERE event_id=?",
              )
              .run(corrupted.event_id);
          } else restore();
          res.end("ok");
        } catch (error) {
          res.writeHead(500);
          res.end(String(error));
        }
        return;
      }
      if (req.url === "/restart") {
        try {
          const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
          const registration = await readHostRegistration(
            join(resolveRootControlNamespace(), capability.rootId),
          );
          assert.ok(registration);
          await candidates.terminateOwned(registration.pid, "SIGTERM");
          await client.request("runtime.ping", {});
          res.end("restarted");
        } catch (error) {
          res.writeHead(500);
          res.end(String(error));
        }
        return;
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      calls++;
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
        res.end(
          frame({
            id: `fixture-${calls}`,
            choices: [{ index: 0, delta: { content: "fixture answer" }, finish_reason: null }],
          }) +
            frame({
              id: `fixture-${calls}`,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 3 },
            }) +
            "data: [DONE]\n\n",
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `fixture-${calls}`,
            object: "chat.completion",
            created: 1,
            model: "trace-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "fixture answer" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          }),
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    await client.connect();
    const providers = await client.request("provider.list", {});
    const updated = await client.request("provider.upsert", {
      provider: {
        id: "trace-fixture",
        protocol: "openai",
        auth: "none",
        apiKeyEnv: "PICO_FIXTURE_UNUSED",
        models: ["trace-model"],
        discoverModels: false,
        baseURL,
      },
      expectedRevision: providers.revision,
    });
    await client.request("config.user.update", {
      defaults: { modelRouteId: "trace-fixture/trace-model" },
      expectedRevision: updated.revision,
    });
    await client.request("workspace.register", { workspacePath });
    await client.request("workspace.trust", { workspacePath, trusted: true });
    const created = await client.request("session.create", { workspacePath });
    const scope = { workspacePath, sessionId: created.session.sessionId };
    for (let index = 0; index < 33; index++) {
      await client.request("session.send", {
        ...scope,
        input: { kind: "text", text: `seed ${index}` },
        idempotencyKey: `seed-${index}`,
      });
      let finished = false;
      for (let poll = 0; poll < 300; poll++) {
        const runs = await client.request("runs.list", scope);
        if (
          runs.runs.length >= index + 1 &&
          runs.runs.every((run) =>
            ["succeeded", "failed", "cancelled", "interrupted"].includes(run.status),
          )
        ) {
          assert.equal(runs.runs[0]!.status, "succeeded");
          finished = true;
          break;
        }
        await delay(20);
      }
      assert.ok(finished, `seed ${index} did not finish`);
    }
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
    await writeFile(
      join(root, "fixture.json"),
      JSON.stringify({
        picoHome,
        scope,
        // Each send records admission and execution runs, both visible in the trace.
        seedRuns: 66,
        controlURL: baseURL.replace("/v1", "/restart"),
      }),
    );
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><div id="root"></div><script src="renderer.js"></script>',
    );
    await Promise.all([
      build({
        entryPoints: [join(repo, "tests/fixtures/execution-trace-electron.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        external: ["electron"],
        outfile: join(root, "main.mjs"),
      }),
      build({
        entryPoints: [join(repo, "apps/desktop/src/preload/index.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: join(root, "preload.cjs"),
      }),
      build({
        entryPoints: [join(repo, "tests/fixtures/execution-trace-electron.renderer.tsx")],
        bundle: true,
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        outfile: join(root, "renderer.js"),
      }),
    ]);
    const child = spawn(process.env.PICO_TEST_ELECTRON!, [join(root, "main.mjs"), root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => stopTestChildProcess(child));
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(output))));
    });
    assert.match(output, /EXECUTION_TRACE_ELECTRON_OK/);
    console.log(output);
    assert.ok(calls >= 34);
  },
);
