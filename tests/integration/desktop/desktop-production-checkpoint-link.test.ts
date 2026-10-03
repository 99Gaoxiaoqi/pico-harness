import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { MobileReview } from "../../../apps/mobile/src/review-controller.js";
import {
  ReviewRequestStorage,
  type ReviewStoragePort,
} from "../../../apps/mobile/src/review-request-storage.js";
import type { RuntimePort } from "../../../apps/mobile/src/core.js";
import { RemoteProtocolError } from "@pico/protocol/remote";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test(
  "production Desktop checkpoints survive replay and remain readable during a running task",
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
    const secondEntered = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
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
              if (executions === 2 && step === 0) {
                secondEntered.resolve();
                await releaseSecond.promise;
              }
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
      releaseSecond.resolve();
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
      // The deterministic fixture runs without a managed /tmp write grant, so temporary checkouts stay trusted.
      initialSettings: { permissionMode: "full-access", orchestrationMode: "default" },
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
    await secondEntered.promise;
    const ref = { workspacePath, sessionId };
    async function readWhileRunning<T>(request: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("preview waited for the active Run")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      await assert.rejects(
        services.desktopService.handle(
          createRuntimeRequest("changes.list", { workspacePath, runId: next.run.runId }),
        ),
        /尚未结束/u,
      );
      const points = (await readWhileRunning(
        services.desktopService.handle(createRuntimeRequest("rewind.list", ref)),
      )) as unknown as RuntimeResult<"rewind.list">;
      assert.ok(points.checkpoints.some((point) => point.checkpointId === finished.checkpointId));
      const checkpointRef = { ...ref, checkpointId: finished.checkpointId! };
      const preview = (await readWhileRunning(
        services.desktopService.handle(createRuntimeRequest("rewind.preview", checkpointRef)),
      )) as unknown as RuntimeResult<"rewind.preview">;
      assert.equal(preview.changes[0]?.path, "delivery.txt");
      const changes = (await readWhileRunning(
        services.desktopService.handle(createRuntimeRequest("rewind.changes", checkpointRef)),
      )) as unknown as RuntimeResult<"rewind.changes">;
      assert.equal(changes.files[0]?.path, "delivery.txt");
      await assert.rejects(
        services.desktopService.handle(
          createRuntimeRequest("rewind.apply", {
            ...checkpointRef,
            mode: "code",
            expectedFingerprint: preview.fingerprint,
            idempotencyKey: "blocked-active-rewind",
          }),
        ),
        /活动 Run/u,
      );
      await assert.rejects(
        services.desktopService.handle(
          createRuntimeRequest("rewind.restoreFile", {
            ...checkpointRef,
            path: "delivery.txt",
            expectedFingerprint: changes.files[0]!.fingerprint,
          }),
        ),
        /活动 Run/u,
      );
      assert.equal(await readFile(join(workspacePath, "delivery.txt"), "utf8"), "first delivery\n");
      assert.equal(
        (await services.service.getWorkspaceRun(workspacePath, next.run.runId))?.status,
        "running",
      );
    } finally {
      releaseSecond.resolve();
    }
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
    const deliveryPath = join(workspacePath, "delivery.txt");
    const fileBefore = await stat(deliveryPath, { bigint: true });
    const stagedBefore = await git("git", ["-C", workspacePath, "diff", "--cached", "--binary"]);
    const approved = (await services.desktopService.handle(
      createRuntimeRequest("changes.review", {
        workspacePath,
        runId: nextFinished.runId,
        decision: "approve",
        expectedFingerprint: nextChanges.fingerprint,
      }),
    )) as unknown as RuntimeResult<"changes.review">;
    const applied = (await services.desktopService.handle(
      createRuntimeRequest("changes.apply", {
        workspacePath,
        runId: nextFinished.runId,
        expectedFingerprint: nextChanges.fingerprint,
      }),
    )) as unknown as RuntimeResult<"changes.apply">;
    assert.equal(approved.accepted, true);
    assert.equal(applied.applied, true);
    assert.equal(await readFile(deliveryPath, "utf8"), "second delivery\n");
    assert.equal((await stat(deliveryPath, { bigint: true })).mtimeNs, fileBefore.mtimeNs);
    assert.equal(
      (await git("git", ["-C", workspacePath, "diff", "--cached", "--binary"])).stdout,
      stagedBefore.stdout,
      "approve and apply record confirmation without staging or rewriting files",
    );
    await assert.rejects(
      services.desktopService.handle(
        createRuntimeRequest("changes.review", {
          workspacePath,
          runId: nextFinished.runId,
          decision: "request_changes",
          message: "  ",
          expectedFingerprint: nextChanges.fingerprint,
        }),
      ),
      /必须说明原因/u,
    );
    assert.equal(executions, 2, "blank revision prompts must not dispatch another Run");
    await writeFile(deliveryPath, "external edit\n");
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
    await assert.rejects(
      services.desktopService.handle(
        createRuntimeRequest("changes.review", {
          workspacePath,
          runId: nextFinished.runId,
          decision: "request_changes",
          message: "revision delivery",
          expectedFingerprint: nextChanges.fingerprint,
        }),
      ),
      /指纹已变化/u,
    );
    assert.equal(executions, 2, "stale revision prompts must not dispatch another Run");
    const currentChanges = (await services.desktopService.handle(
      createRuntimeRequest("changes.list", { workspacePath, runId: nextFinished.runId }),
    )) as unknown as RuntimeResult<"changes.list">;
    const revisionRequest = createRuntimeRequest("changes.review", {
      workspacePath,
      runId: nextFinished.runId,
      decision: "request_changes",
      message: "  revision delivery  ",
      expectedFingerprint: currentChanges.fingerprint,
      idempotencyKey: "review-revision",
    });
    let receiptVisibleAtRunNotification = false;
    const unlisten = services.service.subscribe((event) => {
      if (event.topic !== "run.started") return;
      const observer = new SqliteRuntimeControlStore({
        storageRoot: resolvePicoPaths(workspacePath, { picoHome }).workspace.root,
      });
      try {
        receiptVisibleAtRunNotification = observer
          .listDaemonCommands("changes.review")
          .some(
            (command) => command.status === "completed" && command.resourceId === event.scope.runId,
          );
      } finally {
        observer.close();
      }
    });
    const [revision, concurrentRevision] = (await Promise.all([
      services.desktopService.handle(revisionRequest),
      services.desktopService.handle(revisionRequest),
    ])) as unknown as [RuntimeResult<"changes.review">, RuntimeResult<"changes.review">];
    unlisten();
    assert.deepEqual(concurrentRevision, revision);
    assert.equal(
      receiptVisibleAtRunNotification,
      true,
      "Run notification follows the durable receipt commit",
    );
    assert.equal(revision.accepted, true);
    const list = (await services.service.handle(
      createRuntimeRequest("runs.list", { workspacePath, sessionId }),
    )) as unknown as RuntimeResult<"runs.list">;
    const revisionRun = list.runs.find(
      (run) => run.runId !== finished.runId && run.runId !== nextFinished.runId,
    );
    assert.ok(revisionRun, "accepted revision starts a new Run in the original Session");
    assert.equal(revisionRun.sessionId, sessionId);
    assert.equal((await nextRuntime.waitForRun(revisionRun.runId)).status, "succeeded");
    assert.equal(executions, 3);
    assert.equal(await readFile(deliveryPath, "utf8"), "revision delivery\n");
    await assert.rejects(
      services.desktopService.handle(
        createRuntimeRequest("changes.review", {
          ...revisionRequest.params,
          message: "different intent",
        }),
      ),
      /幂等键.*其他参数/u,
    );
    await services.desktopService.close();
    await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    services = makeServices();
    assert.deepEqual(
      await services.desktopService.handle(revisionRequest),
      revision,
      "Host restart replays before reading the changed diff",
    );
    assert.equal(executions, 3);

    const reviewValues = new Map<string, string>();
    const storage: ReviewStoragePort = {
      getItem: async (key) => reviewValues.get(key) ?? null,
      setItem: async (key, value) => {
        reviewValues.set(key, value);
      },
      removeItem: async (key) => {
        reviewValues.delete(key);
      },
    };
    const reviewRequests: Record<string, unknown>[] = [];
    let loseReceipt = true;
    const port = {
      request: async (method: string, params: Record<string, unknown>) => {
        const result = await services.desktopService.handle(
          createRuntimeRequest(method as never, { workspacePath, ...params } as never),
        );
        if (method === "changes.review") {
          reviewRequests.push(params);
          if (loseReceipt) {
            loseReceipt = false;
            throw new RemoteProtocolError("DISCONNECTED", "response lost", true, "unknown");
          }
        }
        return result;
      },
    } as unknown as RuntimePort;
    const recovery = () =>
      new ReviewRequestStorage(storage, "host/workspace/session", () => "mobile-review-key");
    const mount = () =>
      new MobileReview(port, "workspace-id", sessionId, undefined, {
        recoveryStorage: recovery(),
        canRetry: () => true,
      });
    const firstMount = mount();
    await firstMount.refresh();
    assert.equal(await firstMount.submit("request_changes", "  unknown revision  "), false);
    assert.equal(firstMount.state.unknown, true);
    firstMount.suspend();
    const revisionRuntime = await services.service.getWorkspaceRuntime(workspacePath);
    for (const run of revisionRuntime.listRuns()) await revisionRuntime.waitForRun(run.runId);
    const runCount = (await port.request("runs.list", { sessionId }, "workspace-id")).runs.length;
    const reopened = mount();
    await reopened.refresh(true);
    assert.equal(
      reopened.state.unknown,
      true,
      "remount and manual refresh retain the unknown result",
    );
    assert.equal(reopened.state.recovery?.message, "unknown revision");
    assert.equal(await reopened.submit("request_changes", "new attempt"), false);
    assert.equal(await reopened.retryUnknown(), true);
    assert.deepEqual(
      reviewRequests[1],
      reviewRequests[0],
      "retries preserve every original request field",
    );
    assert.equal(
      (await port.request("runs.list", { sessionId }, "workspace-id")).runs.length,
      runCount,
    );
    assert.equal(
      executions,
      4,
      "lost response + remount + replay dispatch exactly one continuation",
    );
    assert.equal(await recovery().load(), undefined);

    const beforeRollback = executions;
    const originalCommand = SqliteRuntimeControlStore.prototype.executeIdempotentDaemonCommand;
    context.mock.method(
      SqliteRuntimeControlStore.prototype,
      "executeIdempotentDaemonCommand",
      function (
        this: SqliteRuntimeControlStore,
        input: Parameters<SqliteRuntimeControlStore["executeIdempotentDaemonCommand"]>[0],
        execute: Parameters<SqliteRuntimeControlStore["executeIdempotentDaemonCommand"]>[1],
      ) {
        if (input.commandType !== "changes.review")
          return originalCommand.call(this, input, execute);
        return originalCommand.call(this, input, () => {
          execute();
          throw new Error("injected receipt rollback");
        });
      },
    );
    const latestChanges = await port.request(
      "changes.list",
      { runId: firstMount.state.runId! },
      "workspace-id",
    );
    await assert.rejects(
      services.desktopService.handle(
        createRuntimeRequest("changes.review", {
          workspacePath,
          runId: firstMount.state.runId!,
          decision: "request_changes",
          message: "must never execute",
          expectedFingerprint: latestChanges.fingerprint,
          idempotencyKey: "rolled-back-review",
        }),
      ),
      /injected receipt rollback/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      executions,
      beforeRollback,
      "rolled-back receipt cannot execute its scheduled continuation",
    );
  },
);
