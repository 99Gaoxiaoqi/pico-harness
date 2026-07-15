import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCliSessionSummaries, resolveCliSession } from "../../src/cli/session-resolver.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { SessionManager } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX } from "../../src/runtime/runtime-run.js";

const exec = promisify(execFile);

describe("runtime fork publication concurrency", () => {
  let workDir: string;
  let sessions: SessionManager;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-fork-concurrency-"));
    sessions = new SessionManager();
  });

  afterEach(async () => {
    sessions.clear();
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("hides a partially published target and recovers one stable bootstrap run", async () => {
    const source = await seedSource(sessions, workDir, "partial-source");
    const targetSessionId = "partial-target";
    const operationId = "partial-publication";
    const store = runtimeStore(workDir);
    const append = store.append.bind(store);
    let targetMessageAttempts = 0;
    const appendSpy = vi.spyOn(store, "append").mockImplementation(async (event) => {
      if (event.sessionId === targetSessionId && event.kind === "message.committed") {
        targetMessageAttempts += 1;
        if (targetMessageAttempts === 2) throw new Error("injected partial publication crash");
      }
      return append(event);
    });

    const crashing = new SessionForkService({
      workDir,
      sessionManager: sessions,
      runtimeStore: store,
      createOperationId: () => operationId,
    });
    await expect(
      crashing.fork({
        sourceSessionId: source.id,
        targetSessionId,
        targetMode: "default",
      }),
    ).rejects.toThrow("injected partial publication crash");
    appendSpy.mockRestore();

    const partialEvents = await store.readSession(targetSessionId);
    expect(partialEvents.filter((event) => event.kind === "run.started")).toHaveLength(1);
    expect(partialEvents.filter((event) => event.kind === "message.committed")).toHaveLength(1);
    expect(partialEvents.filter((event) => event.kind === "session.forked")).toHaveLength(0);
    expect(partialEvents.filter((event) => event.kind === "run.terminal")).toHaveLength(0);
    await expect(listCliSessionSummaries(workDir)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: targetSessionId })]),
    );
    await expect(resolveCliSession({ workDir, resumeSession: targetSessionId })).rejects.toThrow(
      "fork 尚未完成发布",
    );
    await expect(resolveCliSession({ workDir, continueSession: true })).resolves.toMatchObject({
      sessionId: source.id,
    });

    await expect(
      new SessionForkService({
        workDir,
        sessionManager: sessions,
        runtimeStore: store,
      }).reconcileUnfinished(),
    ).resolves.toEqual([{ operationId, state: "completed" }]);

    const completedEvents = await store.readSession(targetSessionId);
    const bootstrapEvents = completedEvents.filter((event) =>
      event.runId.startsWith(RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX),
    );
    expect(bootstrapEvents.map((event) => event.kind)).toEqual([
      "run.started",
      "message.committed",
      "message.committed",
      "session.forked",
      "run.terminal",
    ]);
    expect(new Set(bootstrapEvents.map((event) => event.runId)).size).toBe(1);
    expect(bootstrapEvents.at(-1)).toMatchObject({
      kind: "run.terminal",
      data: { status: "completed" },
    });
    await expect(listCliSessionSummaries(workDir)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: targetSessionId })]),
    );
    await expect(resolveCliSession({ workDir, resumeSession: targetSessionId })).resolves.toEqual({
      mode: "resume",
      sessionId: targetSessionId,
    });
    await source.close();
  });

  it("repairs the stable terminal after crashing behind the publication marker", async () => {
    const source = await seedSource(sessions, workDir, "terminal-source");
    const targetSessionId = "terminal-target";
    const operationId = "terminal-publication";
    const store = runtimeStore(workDir);
    const append = store.append.bind(store);
    let terminalFailed = false;
    const appendSpy = vi.spyOn(store, "append").mockImplementation(async (event) => {
      if (!terminalFailed && event.sessionId === targetSessionId && event.kind === "run.terminal") {
        terminalFailed = true;
        throw new Error("injected crash after publication marker");
      }
      return append(event);
    });

    const crashing = new SessionForkService({
      workDir,
      sessionManager: sessions,
      runtimeStore: store,
      createOperationId: () => operationId,
    });
    await expect(
      crashing.fork({
        sourceSessionId: source.id,
        targetSessionId,
        targetMode: "default",
      }),
    ).rejects.toThrow("injected crash after publication marker");
    appendSpy.mockRestore();

    const publishedEvents = await store.readSession(targetSessionId);
    expect(publishedEvents.filter((event) => event.kind === "session.forked")).toHaveLength(1);
    expect(publishedEvents.filter((event) => event.kind === "run.terminal")).toHaveLength(0);

    await expect(
      new SessionForkService({
        workDir,
        sessionManager: sessions,
        runtimeStore: store,
      }).reconcileUnfinished(),
    ).resolves.toEqual([{ operationId, state: "completed" }]);
    const recoveredEvents = await store.readSession(targetSessionId);
    const bootstrapEvents = recoveredEvents.filter((event) =>
      event.runId.startsWith(RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX),
    );
    expect(bootstrapEvents.filter((event) => event.kind === "run.started")).toHaveLength(1);
    expect(bootstrapEvents.filter((event) => event.kind === "session.forked")).toHaveLength(1);
    expect(bootstrapEvents.filter((event) => event.kind === "run.terminal")).toHaveLength(1);
    expect(new Set(bootstrapEvents.map((event) => event.runId)).size).toBe(1);
    await source.close();
  });

  it("publishes exactly once when two Node processes reconcile the same target", async () => {
    const source = await seedSource(sessions, workDir, "concurrent-source");
    const targetSessionId = "concurrent-target";
    const operationId = "concurrent-publication";
    const preparing = new SessionForkService({
      workDir,
      sessionManager: sessions,
      createOperationId: () => operationId,
      hooks: {
        beforeRuntimeBootstrap() {
          throw new Error("pause before concurrent publication");
        },
      },
    });
    await expect(
      preparing.fork({
        sourceSessionId: source.id,
        targetSessionId,
        targetMode: "default",
      }),
    ).rejects.toThrow("pause before concurrent publication");

    const barrierRoot = join(workDir, "fork-process-barrier");
    const readyDirectory = join(barrierRoot, "ready");
    const enteredDirectory = join(barrierRoot, "entered");
    const outcomeDirectory = join(barrierRoot, "outcome");
    const startPath = join(barrierRoot, "start");
    await Promise.all([
      mkdir(readyDirectory, { recursive: true }),
      mkdir(enteredDirectory, { recursive: true }),
      mkdir(outcomeDirectory, { recursive: true }),
    ]);
    const moduleUrl = new URL("../../src/engine/session-fork-service.ts", import.meta.url).href;
    const children = ["one", "two"].map((contenderId) =>
      exec(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", FORK_RECONCILER_SCRIPT],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PICO_FORK_MODULE_URL: moduleUrl,
            PICO_FORK_WORK_DIR: workDir,
            PICO_FORK_READY_PATH: join(readyDirectory, `${contenderId}.ready`),
            PICO_FORK_ENTERED_PATH: join(enteredDirectory, `${contenderId}.entered`),
            PICO_FORK_OUTCOME_PATH: join(outcomeDirectory, `${contenderId}.json`),
            PICO_FORK_START_PATH: startPath,
          },
        },
      ),
    );

    await waitForFileCount(readyDirectory, 2);
    await writeFile(startPath, "start\n", "utf8");
    await expect(Promise.all(children)).resolves.toHaveLength(2);
    await expect(readdir(enteredDirectory)).resolves.toHaveLength(1);
    await expect(readdir(outcomeDirectory)).resolves.toHaveLength(2);

    const events = await runtimeStore(workDir).readSession(targetSessionId);
    const bootstrapEvents = events.filter((event) =>
      event.runId.startsWith(RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX),
    );
    expect(bootstrapEvents.filter((event) => event.kind === "run.started")).toHaveLength(1);
    expect(bootstrapEvents.filter((event) => event.kind === "message.committed")).toHaveLength(2);
    expect(bootstrapEvents.filter((event) => event.kind === "session.forked")).toHaveLength(1);
    expect(bootstrapEvents.filter((event) => event.kind === "run.terminal")).toHaveLength(1);
    expect(new Set(bootstrapEvents.map((event) => event.runId)).size).toBe(1);
    await expect(preparing.journal.get(operationId)).resolves.toMatchObject({ state: "completed" });
    await source.close();
  }, 30_000);
});

const FORK_RECONCILER_SCRIPT = String.raw`
  import { access, writeFile } from "node:fs/promises";
  import { setTimeout as delay } from "node:timers/promises";

  const {
    PICO_FORK_MODULE_URL: moduleUrl,
    PICO_FORK_WORK_DIR: workDir,
    PICO_FORK_READY_PATH: readyPath,
    PICO_FORK_ENTERED_PATH: enteredPath,
    PICO_FORK_OUTCOME_PATH: outcomePath,
    PICO_FORK_START_PATH: startPath,
  } = process.env;
  if (!moduleUrl || !workDir || !readyPath || !enteredPath || !outcomePath || !startPath) {
    throw new Error("missing fork reconciler environment");
  }

  const waitForPath = async (path) => {
    for (;;) {
      try {
        await access(path);
        return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await delay(2);
    }
  };

  const { SessionForkService } = await import(moduleUrl);
  await writeFile(readyPath, "ready\n", "utf8");
  await waitForPath(startPath);
  const service = new SessionForkService({
    workDir,
    hooks: {
      async beforeRuntimeBootstrap() {
        await writeFile(enteredPath, "entered\n", "utf8");
        await delay(150);
      },
    },
  });
  const result = await service.reconcileUnfinished();
  await writeFile(outcomePath, JSON.stringify(result), "utf8");
`;

async function seedSource(sessions: SessionManager, workDir: string, sessionId: string) {
  const source = await sessions.getOrCreate(sessionId, workDir, { persistence: true });
  await source.commitMessages(
    { role: "user", content: "frozen question" },
    { role: "assistant", content: "frozen answer" },
  );
  await source.flushPersistence();
  return source;
}

function runtimeStore(workDir: string): RuntimeEventStore {
  return new RuntimeEventStore({
    databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
  });
}

async function waitForFileCount(directory: string, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await readdir(directory)).length >= count) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${count} files in ${directory}`);
}
