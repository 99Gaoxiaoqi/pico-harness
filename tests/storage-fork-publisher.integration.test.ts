import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ForkOperationCoordinator,
  type ForkOperationCallbacks,
  type ForkSourceCursor,
  type ForkTargetSessionIdentity,
} from "../src/storage/fork-operation-coordinator.js";
import {
  StorageOperationJournal,
  type ForkStorageOperation,
} from "../src/storage/operation-journal.js";

const SOURCE_CURSOR = {
  logId: "source-log",
  seq: 7,
  epoch: 2,
  eventId: "source-event-7",
} satisfies ForkSourceCursor;

describe("fork operation coordinator integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reconciles crashes at every fork phase and publishes Catalog only after Runtime bootstrap", async () => {
    const fixture = await createFixture(cleanup);
    const durableEffects = {
      prepared: new Set<string>(),
      sidecars: new Set<string>(),
      runtimeBootstrap: new Set<string>(),
      runtimeBootstrapSucceeded: new Set<string>(),
      catalog: new Set<string>(),
      order: [] as string[],
      bootstrapAttempts: 0,
    };
    const restart = (crashAfter?: "prepare" | "sidecars" | "bootstrap" | "catalog") =>
      new ForkOperationCoordinator({
        journal: fixture.journal,
        callbacks: createCallbacks(fixture, durableEffects, () => crashAfter),
      });

    await expect(restart("prepare").execute(fixture.input)).rejects.toThrow("crash after prepare");
    await expect(fixture.targetExists()).resolves.toBe(false);
    expect(durableEffects.catalog.size).toBe(0);
    await expect(fixture.operationState()).resolves.toBe("prepared");

    await expect(restart("sidecars").reconcileUnfinished()).rejects.toThrow("crash after sidecars");
    await expect(fixture.targetExists()).resolves.toBe(false);
    expect(durableEffects.catalog.size).toBe(0);
    await expect(fixture.operationState()).resolves.toBe("workspace_applied");

    await expect(restart("bootstrap").reconcileUnfinished()).rejects.toThrow(
      "crash after bootstrap",
    );
    await expect(fixture.targetExists()).resolves.toBe(true);
    expect(durableEffects.sidecars).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.runtimeBootstrap).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.runtimeBootstrapSucceeded.size).toBe(0);
    expect(durableEffects.bootstrapAttempts).toBe(1);
    expect(durableEffects.catalog.size).toBe(0);
    await expect(fixture.operationState()).resolves.toBe("sidecars_committed");

    await expect(restart("catalog").reconcileUnfinished()).rejects.toThrow("crash after catalog");
    await expect(fixture.targetExists()).resolves.toBe(true);
    expect(durableEffects.sidecars).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.runtimeBootstrap).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.runtimeBootstrapSucceeded).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.bootstrapAttempts).toBe(2);
    expect(durableEffects.catalog).toEqual(new Set([fixture.operationId]));
    await expect(fixture.operationState()).resolves.toBe("sidecars_committed");

    const coordinator = restart();
    const reconciled = await coordinator.reconcileUnfinished();
    expect(reconciled).toEqual([{ operationId: fixture.operationId, state: "completed" }]);
    expect(durableEffects.prepared).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.sidecars).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.runtimeBootstrap).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.runtimeBootstrapSucceeded).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.bootstrapAttempts).toBe(3);
    expect(durableEffects.catalog).toEqual(new Set([fixture.operationId]));
    expect(durableEffects.order).toEqual(["prepare", "sidecars", "bootstrap", "catalog"]);
    await expect(readFile(fixture.targetPath, "utf8")).resolves.toBe(fixture.contents);
    await expect(stat(fixture.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(coordinator.reconcile(fixture.operationId)).resolves.toMatchObject({
      state: "completed",
    });
  });

  it("moves source drift, corrupted staging and conflicting targets to needs_attention", async () => {
    const sourceChanged = await createFixture(cleanup, "source-changed");
    const sourceCallbacks = createCallbacks(sourceChanged, emptyEffects(), () => undefined, {
      ...SOURCE_CURSOR,
      seq: SOURCE_CURSOR.seq + 1,
    });
    await expect(
      new ForkOperationCoordinator({
        journal: sourceChanged.journal,
        callbacks: sourceCallbacks,
      }).execute(sourceChanged.input),
    ).resolves.toMatchObject({
      state: "needs_attention",
      error: { message: expect.stringContaining("source_cursor_changed") },
    });

    const corrupt = await createFixture(cleanup, "staging-corrupt");
    let corruptCrash = true;
    const corruptCoordinator = new ForkOperationCoordinator({
      journal: corrupt.journal,
      callbacks: createCallbacks(corrupt, emptyEffects(), () =>
        corruptCrash ? "sidecars" : undefined,
      ),
    });
    await expect(corruptCoordinator.execute(corrupt.input)).rejects.toThrow("crash after sidecars");
    corruptCrash = false;
    await writeFile(corrupt.stagedPath, "corrupted\n");
    await expect(corruptCoordinator.reconcileUnfinished()).resolves.toEqual([
      { operationId: corrupt.operationId, state: "needs_attention" },
    ]);
    await expect(corrupt.operationState()).resolves.toBe("needs_attention");
    await expect(corrupt.targetExists()).resolves.toBe(false);

    const conflict = await createFixture(cleanup, "target-conflict");
    let catalogCrash = true;
    const conflictCoordinator = new ForkOperationCoordinator({
      journal: conflict.journal,
      callbacks: createCallbacks(conflict, emptyEffects(), () =>
        catalogCrash ? "catalog" : undefined,
      ),
    });
    await expect(conflictCoordinator.execute(conflict.input)).rejects.toThrow(
      "crash after catalog",
    );
    catalogCrash = false;
    await writeFile(conflict.targetPath, "conflicting target\n");
    await expect(conflictCoordinator.reconcileUnfinished()).resolves.toEqual([
      { operationId: conflict.operationId, state: "needs_attention" },
    ]);
    await expect(conflict.operationState()).resolves.toBe("needs_attention");
  });

  it("fails closed before Catalog publication when Runtime bootstrap is not wired", async () => {
    const fixture = await createFixture(cleanup, "missing-bootstrap");
    const effects = emptyEffects();
    const callbacks = createCallbacks(fixture, effects, () => undefined);
    callbacks.bootstrapRuntime = undefined;

    await expect(
      new ForkOperationCoordinator({ journal: fixture.journal, callbacks }).execute(fixture.input),
    ).rejects.toThrow("Fork Runtime bootstrap callback is required");

    await expect(fixture.targetExists()).resolves.toBe(true);
    expect(effects.catalog.size).toBe(0);
    await expect(fixture.operationState()).resolves.toBe("sidecars_committed");
  });
});

interface Fixture {
  operationId: string;
  journal: StorageOperationJournal;
  input: {
    kind: "fork";
    operationId: string;
    sessionId: string;
    sourceSessionId: string;
    sourceCursor: ForkSourceCursor;
    targetSessionId: string;
    stagingDirectory: string;
  };
  stagingDirectory: string;
  stagedPath: string;
  targetPath: string;
  contents: string;
  targetExists(): Promise<boolean>;
  operationState(): Promise<ForkStorageOperation["state"] | undefined>;
}

async function createFixture(cleanup: string[], suffix = "restart"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-fork-publisher-${suffix}-`));
  cleanup.push(root);
  const operationId = `fork-${suffix}`;
  const sessionsDirectory = join(root, ".claw", "sessions");
  const stagingDirectory = join(root, ".claw", "fork-staging", operationId);
  const stagedPath = join(sessionsDirectory, `.target-${operationId}.jsonl`);
  const targetPath = join(sessionsDirectory, "target.jsonl");
  const identity = targetIdentity();
  const contents = `${JSON.stringify({
    type: "meta",
    schemaVersion: 3,
    sessionId: identity.sessionId,
    logId: identity.logId,
    lineage: { relation: "fork", parent: identity.forkedFrom },
  })}\n${JSON.stringify({ type: "event", eventId: "target-seed", seq: 0 })}\n`;
  const journal = new StorageOperationJournal({ workDir: root });
  return {
    operationId,
    journal,
    input: {
      kind: "fork",
      operationId,
      sessionId: "source",
      sourceSessionId: "source",
      sourceCursor: SOURCE_CURSOR,
      targetSessionId: "target",
      stagingDirectory,
    },
    stagingDirectory,
    stagedPath,
    targetPath,
    contents,
    async targetExists() {
      try {
        await stat(targetPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async operationState() {
      const operation = await journal.get(operationId);
      return operation?.state;
    },
  };
}

function createCallbacks(
  fixture: Fixture,
  effects: ReturnType<typeof emptyEffects>,
  crashAfter: () => "prepare" | "sidecars" | "bootstrap" | "catalog" | undefined,
  sourceCursor: ForkSourceCursor = SOURCE_CURSOR,
): ForkOperationCallbacks {
  const crashed = new Set<string>();
  const maybeCrash = (phase: "prepare" | "sidecars" | "bootstrap" | "catalog"): void => {
    if (crashAfter() !== phase || crashed.has(phase)) return;
    crashed.add(phase);
    throw new Error(`crash after ${phase}`);
  };

  return {
    async readSourceCursor() {
      return sourceCursor;
    },
    async prepareTargetBundle(operation) {
      await mkdir(dirname(fixture.targetPath), { recursive: true });
      if (!effects.prepared.has(operation.operationId)) {
        await writeFile(fixture.stagedPath, fixture.contents);
        effects.prepared.add(operation.operationId);
        effects.order.push("prepare");
      }
      maybeCrash("prepare");
      return {
        stagedSessionPath: fixture.stagedPath,
        targetSessionPath: fixture.targetPath,
      };
    },
    async inspectSessionFile(_operation, path) {
      try {
        const [line] = (await readFile(path, "utf8")).split("\n");
        const meta = JSON.parse(line ?? "null") as {
          sessionId?: string;
          logId?: string;
          lineage?: { relation?: string; parent?: ForkSourceCursor };
        };
        if (
          !meta.sessionId ||
          !meta.logId ||
          meta.lineage?.relation !== "fork" ||
          !meta.lineage.parent
        ) {
          return undefined;
        }
        return {
          sessionId: meta.sessionId,
          logId: meta.logId,
          forkedFrom: meta.lineage.parent,
        };
      } catch {
        return undefined;
      }
    },
    async cloneSidecars(operation) {
      if (await fixture.targetExists()) throw new Error("target became visible before sidecars");
      if (!effects.sidecars.has(operation.operationId)) {
        effects.sidecars.add(operation.operationId);
        effects.order.push("sidecars");
      }
      maybeCrash("sidecars");
    },
    async bootstrapRuntime(operation) {
      if (!(await fixture.targetExists())) {
        throw new Error("Runtime bootstrap ran before target JSONL publication");
      }
      effects.bootstrapAttempts += 1;
      if (!effects.runtimeBootstrap.has(operation.operationId)) {
        effects.runtimeBootstrap.add(operation.operationId);
        effects.order.push("bootstrap");
      }
      maybeCrash("bootstrap");
      effects.runtimeBootstrapSucceeded.add(operation.operationId);
    },
    async publishCatalog(operation) {
      if (!(await fixture.targetExists())) throw new Error("catalog published before target JSONL");
      if (!effects.runtimeBootstrapSucceeded.has(operation.operationId)) {
        throw new Error("catalog published before Runtime bootstrap");
      }
      if (!effects.catalog.has(operation.operationId)) {
        effects.catalog.add(operation.operationId);
        effects.order.push("catalog");
      }
      maybeCrash("catalog");
    },
  };
}

function emptyEffects(): {
  prepared: Set<string>;
  sidecars: Set<string>;
  runtimeBootstrap: Set<string>;
  runtimeBootstrapSucceeded: Set<string>;
  catalog: Set<string>;
  order: string[];
  bootstrapAttempts: number;
} {
  return {
    prepared: new Set(),
    sidecars: new Set(),
    runtimeBootstrap: new Set(),
    runtimeBootstrapSucceeded: new Set(),
    catalog: new Set(),
    order: [],
    bootstrapAttempts: 0,
  };
}

function targetIdentity(): ForkTargetSessionIdentity {
  return { sessionId: "target", logId: "target-log", forkedFrom: SOURCE_CURSOR };
}
