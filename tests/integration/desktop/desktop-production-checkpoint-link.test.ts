import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createRuntimeRequest, type RuntimeResult } from "@pico/protocol";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "@pico/pico-host/agent-runtime";
import { createProductionRuntimeServices } from "@pico/pico-host/production-host";
import { globalSessionManager } from "@pico/pico-host/session";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test(
  "production Desktop first send binds its committed checkpoint through restart and input replay",
  { timeout: 30_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-checkpoint-link-"));
    const picoHome = join(root, "home");
    await mkdir(picoHome);
    await mkdir(join(root, "workspace"));
    const workspacePath = await realpath(join(root, "workspace"));
    const git = promisify(execFile);
    await git("git", ["init", "-b", "main", workspacePath]);
    await writeDesktopModelRouting(picoHome);
    let executions = 0;
    const agentRuntime = new (class extends AgentRuntime {
      override execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
        executions++;
        let step = 0;
        return super.execute(options, {
          ...dependencies,
          isolatedHeadless: true,
          provider: {
            modelName: "test/checkpoint-link",
            generate: async () => {
              if (step++ === 0)
                return {
                  role: "assistant" as const,
                  content: "",
                  toolCalls: [
                    {
                      id: `write-${executions}`,
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "delivery.txt",
                        content: `${options.prompt}\n`,
                      }),
                    },
                  ],
                };
              return { role: "assistant" as const, content: "written" };
            },
          },
        });
      }
    })();
    const makeServices = () =>
      createProductionRuntimeServices({
        env: { PICO_HOME: picoHome, PICO_TEST_TOKEN: "synthetic-token" },
        agentRuntime,
      });
    let services = makeServices();
    const sessionIds: string[] = [];
    context.after(async () => {
      await services.desktopService.close();
      for (const sessionId of sessionIds)
        await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    });
    await services.trustStore.trust(workspacePath);
    await services.service.handle(createRuntimeRequest("workspace.register", { workspacePath }));
    const firstRequest = createRuntimeRequest("session.send", {
      workspacePath,
      input: { kind: "text", text: "first delivery" },
      initialSettings: { permissionMode: "auto", orchestrationMode: "default" },
      idempotencyKey: "first-input",
    });
    const first = (await services.desktopService.handle(
      firstRequest,
    )) as unknown as RuntimeResult<"session.send">;
    const sessionId = first.session.sessionId;
    sessionIds.push(sessionId);
    assert.ok(first.run);
    const runtime = await services.service.getWorkspaceRuntime(workspacePath);
    const finished = await runtime.waitForRun(first.run.runId);
    assert.equal(finished.status, "succeeded", finished.error);
    assert.equal(await readFile(join(workspacePath, "delivery.txt"), "utf8"), "first delivery\n");
    assert.match(finished.checkpointId ?? "", /^desktop-input:/u);
    const firstChanges = (await services.desktopService.handle(
      createRuntimeRequest("changes.list", { workspacePath, runId: finished.runId }),
    )) as unknown as RuntimeResult<"changes.list">;
    assert.deepEqual(firstChanges.changes, [
      { path: "delivery.txt", status: "added", additions: 1, deletions: 0 },
    ]);
    const firstDiff = (await services.desktopService.handle(
      createRuntimeRequest("changes.diff", {
        workspacePath,
        runId: finished.runId,
        path: "delivery.txt",
      }),
    )) as unknown as RuntimeResult<"changes.diff">;
    assert.match(firstDiff.patch, /\+first delivery/u);

    await services.desktopService.close();
    await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    services = makeServices();
    const replay = (await services.desktopService.handle(
      firstRequest,
    )) as unknown as RuntimeResult<"session.send">;
    assert.equal(replay.run?.runId, finished.runId);
    assert.equal(executions, 1, "idempotent replay must not dispatch or create another checkpoint");
    const persisted = await services.service.getWorkspaceRun(workspacePath, finished.runId);
    assert.equal(persisted?.checkpointId, finished.checkpointId);
    assert.deepEqual(
      await services.desktopService.handle(
        createRuntimeRequest("changes.list", { workspacePath, runId: finished.runId }),
      ),
      firstChanges,
    );

    const next = (await services.desktopService.handle(
      createRuntimeRequest("session.send", {
        workspacePath,
        sessionId,
        input: { kind: "text", text: "second delivery" },
        idempotencyKey: "second-input",
      }),
    )) as unknown as RuntimeResult<"session.send">;
    assert.ok(next.run);
    const nextRuntime = await services.service.getWorkspaceRuntime(workspacePath);
    const nextFinished = await nextRuntime.waitForRun(next.run.runId);
    assert.equal(nextFinished.status, "succeeded", nextFinished.error);
    assert.notEqual(nextFinished.checkpointId, finished.checkpointId);
    const nextChanges = (await services.desktopService.handle(
      createRuntimeRequest("changes.list", { workspacePath, runId: nextFinished.runId }),
    )) as unknown as RuntimeResult<"changes.list">;
    assert.deepEqual(nextChanges.changes, [
      { path: "delivery.txt", status: "modified", additions: 1, deletions: 1 },
    ]);
    const nextDiff = (await services.desktopService.handle(
      createRuntimeRequest("changes.diff", {
        workspacePath,
        runId: nextFinished.runId,
        path: "delivery.txt",
      }),
    )) as unknown as RuntimeResult<"changes.diff">;
    assert.match(nextDiff.patch, /-first delivery/u);
    assert.match(nextDiff.patch, /\+second delivery/u);
    await writeFile(join(workspacePath, "delivery.txt"), "external edit\n");
    await assert.rejects(
      services.desktopService.handle(
        createRuntimeRequest("changes.review", {
          workspacePath,
          runId: nextFinished.runId,
          decision: "approve",
          expectedFingerprint: nextChanges.fingerprint,
        }),
      ),
      /指纹已变化/u,
    );
  },
);
