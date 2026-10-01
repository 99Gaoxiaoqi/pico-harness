import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createRuntimeRequest, type RuntimeResult } from "@pico/protocol";
import { createProductionRuntimeServices } from "@pico/pico-host/production-host";
import {
  UserConfigStore,
  EMPTY_USER_CONFIG_REVISION,
} from "@pico/pico-host/input/user-config-store";
import { globalSessionManager } from "@pico/pico-host/session";
import { SessionSubscriptionRegistry } from "@pico/pico-host/session-subscription-owner";
import { SqliteSessionContinuitySource } from "@pico/pico-host/sqlite-session-continuity-source";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

test(
  "real model: two controlled Desktop skills compose into one task answer",
  { timeout: 180_000 },
  async (context) => {
    const model = await loadUserDefaultRealModel({
      modelRouteId: process.env["PICO_MULTI_SKILLS_E2E_MODEL_ROUTE"],
    }).catch((error: unknown) => {
      if (error instanceof Error && /缺少凭证环境变量|defaults.modelRouteId/u.test(error.message))
        return undefined;
      throw error;
    });
    if (!model) {
      context.skip("No configured real-model credentials");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "pico-multi-skills-real-"));
    const picoHome = join(root, "home");
    await mkdir(join(root, "workspace"));
    const workspacePath = await realpath(join(root, "workspace"));
    for (const [name, body] of [
      [
        "first-marker",
        "Your final answer must contain the exact token ALPHA_731. Do not call tools.",
      ],
      [
        "second-marker",
        "Your final answer must contain the exact token BETA_924 and the user task result. Do not call tools.",
      ],
    ]) {
      const directory = join(workspacePath, ".pico", "skills", name!);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: controlled E2E fixture\nallowed-tools: []\n---\n${body}\n`,
      );
    }
    const userConfigStore = new UserConfigStore({ picoHome });
    const secretEnv = "PICO_MULTI_SKILLS_REAL_KEY";
    await userConfigStore.write(
      {
        version: 1,
        defaults: {
          modelRouteId: model.route.id,
          collaborationMode: "agent",
          permissionMode: "full-access",
          orchestrationMode: "default",
        },
        providers: {
          [model.route.providerId]: {
            protocol: model.provider,
            baseURL: model.config.baseURL,
            apiKeyEnv: secretEnv,
            ...(model.route.auth ? { auth: model.route.auth } : {}),
            discoverModels: false,
            models: [model.route.model],
          },
        },
      },
      { expectedRevision: EMPTY_USER_CONFIG_REVISION },
    );
    const services = createProductionRuntimeServices({
      env: { ...process.env, PICO_HOME: picoHome, [secretEnv]: model.config.apiKey },
      userConfigStore,
    });
    let sessionId = "";
    const registry = new SessionSubscriptionRegistry(
      "real-multi-skills",
      new SqliteSessionContinuitySource({
        picoHome,
        readMetadata: (workspace, id) =>
          services.desktopService.readSessionContinuityMetadata(workspace, id),
      }),
    );
    context.after(async () => {
      registry.shutdown();
      await services.desktopService.close();
      if (sessionId)
        await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    });
    await services.trustStore.trust(workspacePath);
    const result = (await services.desktopService.handle(
      createRuntimeRequest("session.send", {
        workspacePath,
        input: {
          kind: "text",
          text: "Compute 7 plus 5. Include both skill tokens and the numeric result only.",
          skills: [{ name: "first-marker" }, { name: "second-marker" }],
        },
        idempotencyKey: "multi-skills-real",
      }),
    )) as RuntimeResult<"session.send">;
    sessionId = result.session.sessionId;
    assert.ok(result.run);
    const deadline = Date.now() + 150_000;
    let run: RuntimeResult<"runs.list">["runs"][number];
    do {
      await delay(200);
      const current = (await services.desktopService.handle(
        createRuntimeRequest("runs.list", { workspacePath, sessionId }),
      )) as RuntimeResult<"runs.list">;
      run = current.runs.find((candidate) => candidate.runId === result.run!.runId)!;
    } while (["running", "queued", "cancelling"].includes(run.status) && Date.now() < deadline);
    assert.equal(run.status, "succeeded", run.error ?? "real model run did not finish");
    const projection = await registry.open(
      { workspacePath, sessionId },
      { connectionId: "test", push: async () => undefined },
    );
    const answers = projection.durableTail.filter(({ item }) => item.kind === "assistantMessage");
    const text = answers.map(({ item }) => item.content).join("\n");
    assert.match(text, /ALPHA_731/);
    assert.match(text, /BETA_924/);
    assert.match(text, /12/);
    const runs = (await services.desktopService.handle(
      createRuntimeRequest("runs.list", { workspacePath, sessionId }),
    )) as RuntimeResult<"runs.list">;
    assert.equal(runs.runs.length, 1);
    const sessions = (await services.desktopService.handle(
      createRuntimeRequest("session.list", { workspacePath }),
    )) as RuntimeResult<"session.list">;
    assert.equal(
      sessions.sessions.find((session) => session.sessionId === sessionId)?.title,
      "Compute 7 plus 5. Include both skill tokens and the numeric result only.",
    );
  },
);
