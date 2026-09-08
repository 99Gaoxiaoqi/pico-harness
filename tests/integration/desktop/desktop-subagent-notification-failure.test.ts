import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../../src/daemon/index.js";
import {
  isJsonObject,
  parseRuntimeResult,
  type RuntimeNotification,
  type RuntimeSubagentPreset,
} from "../../../src/daemon/protocol.js";
import { WorkspaceRegistrationStore } from "../../../src/daemon/workspace-registration.js";
import { UserConfigStore } from "../../../src/input/user-config-store.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { logger } from "../../../src/observability/logger.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { operationalDatabasePath } from "../../../src/storage/sqlite/sqlite-database.js";
import { prepareCurrentWorkspaceSqliteStorageSync } from "../../../src/storage/sqlite/workspace-scopes.js";

test(
  "committed subagent settings survive notification failures and admit output reading in healthy workspaces",
  { timeout: 10_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-subagent-notify-"));
    const picoHome = join(root, "home");
    const registrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
    await mkdir(join(root, "a-unadopted"));
    await mkdir(join(root, "z-healthy"));
    const faultyWorkspace = await registrationStore.register(join(root, "a-unadopted"));
    const healthyWorkspace = await registrationStore.register(join(root, "z-healthy"));
    // Recreate the reported physical-root mismatch using only disposable fixture data.
    const faultyRoot = resolvePicoPaths(faultyWorkspace, { picoHome }).workspace.root;
    prepareCurrentWorkspaceSqliteStorageSync(faultyRoot).lease.release();
    await rename(faultyRoot, `${faultyRoot}-original`);
    await cp(`${faultyRoot}-original`, faultyRoot, { recursive: true });
    assert.throws(
      () => prepareCurrentWorkspaceSqliteStorageSync(faultyRoot),
      /requires explicit adoption/u,
    );
    const originalFaultyDatabase = await readFile(operationalDatabasePath(faultyRoot));

    const userConfigStore = new UserConfigStore({ picoHome });
    const initial = await userConfigStore.read();
    await userConfigStore.write(
      {
        version: 1,
        defaults: { modelRouteId: "fixture/model" },
        providers: {
          fixture: {
            protocol: "openai",
            baseURL: "http://127.0.0.1:1/v1",
            apiKeyEnv: "UNUSED_FIXTURE_KEY",
            auth: "none",
            models: ["model"],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: initial.revision },
    );
    const env = { PICO_HOME: picoHome };
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(healthyWorkspace);
    const dispatched = Promise.withResolvers<readonly string[] | undefined>();
    const runtime = new WorkspaceRuntimeService({
      env,
      execute: async ({ execution }) => {
        dispatched.resolve(execution?.allowedTools);
      },
    });
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      registrationStore,
      userConfigStore,
      trustStore,
      env,
    });
    context.after(async () => {
      await desktop.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    });
    const warnings: unknown[][] = [];
    context.mock.method(logger, "warn", (...args: unknown[]) => {
      warnings.push(args);
    });
    const notifications: RuntimeNotification[] = [];
    const unsubscribe = desktop.subscribe((notification) => {
      notifications.push(notification);
    });
    context.after(unsubscribe);
    const preset: RuntimeSubagentPreset = {
      id: "reader",
      name: "Reader",
      description: "",
      profile: "local_read",
      connectionSlug: "fixture",
      model: "model",
      enabled: true,
    };
    const before = parseRuntimeResult(
      "subagents.get",
      await desktop.handle(createRuntimeRequest("subagents.get", {})),
    );
    const saved = parseRuntimeResult(
      "subagents.update",
      await desktop.handle(
        createRuntimeRequest("subagents.update", {
          presets: [preset],
          expectedRevision: before.revision,
        }),
      ),
    );
    assert.equal(saved.presets[0]?.id, preset.id);
    assert.notEqual(saved.revision, before.revision);
    assert.equal((await userConfigStore.read()).config.subagents?.presets[0]?.id, preset.id);
    assert.ok(
      notifications.some(
        (notification) =>
          notification.topic === "config.updated" &&
          notification.scope.workspacePath === healthyWorkspace &&
          isJsonObject(notification.payload) &&
          notification.payload["revision"] === saved.revision,
      ),
    );
    assert.ok(
      warnings.some(
        ([fields]) =>
          typeof fields === "object" &&
          fields !== null &&
          "workspacePath" in fields &&
          fields.workspacePath === faultyWorkspace,
      ),
    );
    assert.throws(
      () => prepareCurrentWorkspaceSqliteStorageSync(faultyRoot),
      /requires explicit adoption/u,
    );
    assert.deepEqual(
      await readFile(operationalDatabasePath(faultyRoot)),
      originalFaultyDatabase,
      "notification delivery must not adopt or mutate the refused database",
    );

    // The service commit boundary also protects failures outside an individual workspace publish.
    const listFailure = context.mock.method(registrationStore, "list", async () => {
      throw new Error("fixture registry unavailable after commit");
    });
    const updated = parseRuntimeResult(
      "subagents.update",
      await desktop.handle(
        createRuntimeRequest("subagents.update", {
          presets: [{ ...preset, name: "Updated reader" }],
          expectedRevision: saved.revision,
        }),
      ),
    );
    listFailure.mock.restore();
    assert.equal(updated.presets[0]?.name, "Updated reader");
    assert.deepEqual(
      parseRuntimeResult(
        "subagents.get",
        await desktop.handle(createRuntimeRequest("subagents.get", {})),
      ),
      updated,
    );
    assert.ok(
      warnings.some(
        ([, message]) => message === "Subagent presets committed but refresh notification failed",
      ),
    );
    const sent = parseRuntimeResult(
      "session.send",
      await desktop.handle(
        createRuntimeRequest("session.send", {
          workspacePath: healthyWorkspace,
          input: {
            kind: "agent",
            name: "Updated reader",
            subagentId: preset.id,
            task: "Spawn the child and read its output",
          },
          idempotencyKey: "preset-with-output",
        }),
      ),
    );
    assert.equal(sent.disposition, "started");
    assert.deepEqual(await dispatched.promise, ["agent_spawn", "agent_output"]);
  },
);
