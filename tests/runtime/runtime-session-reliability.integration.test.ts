import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";

describe("durable Runtime Session reliability", () => {
  let workDir: string;
  const sessions = new Set<Session>();

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-session-reliability-"));
  });

  afterEach(async () => {
    await Promise.allSettled([...sessions].map((session) => session.close()));
    sessions.clear();
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("drains running and queued serialize tasks before closing durable resources", async () => {
    const session = track(new Session("session-close", workDir, { persistence: true }));
    await session.recover();
    const started = deferred<void>();
    const release = deferred<void>();

    const running = session.serialize(async () => {
      started.resolve();
      await release.promise;
      await session.commitMessages({ role: "user", content: "running task committed" });
    });
    const queued = session.serialize(async () => {
      await session.commitMessages({ role: "assistant", content: "queued task committed" });
    });
    await started.promise;

    const closing = session.close();
    expect(session.close()).toBe(closing);
    await expect(session.serialize(async () => undefined)).rejects.toThrow("is closing");
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closeSettled).toBe(false);

    release.resolve();
    await Promise.all([running, queued, closing]);
    expect(session.hasPendingTasks).toBe(false);

    const recovered = track(new Session("session-close", workDir, { persistence: true }));
    await recovered.recover();
    expect(recovered.getHistory()).toEqual([
      { role: "user", content: "running task committed" },
      { role: "assistant", content: "queued task committed" },
    ]);
  });

  it.each([
    {
      operation: "truncateTo",
      mutate: (session: Session) => session.truncateTo(1),
    },
    {
      operation: "applyCompaction",
      mutate: (session: Session) => session.applyCompaction("replacement summary", 2),
    },
  ])(
    "rolls back the full $operation history replacement on a mid-batch fault",
    async ({ mutate }) => {
      const sessionId = "session-replacement";
      const session = track(new Session(sessionId, workDir, { persistence: true }));
      await session.recover();
      await session.commitMessages(
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      );
      const original = session.getHistory();
      const databasePath = resolvePicoPaths(workDir).workspace.runtimeDatabase;
      installReplacementFailure(databasePath);

      await expect(mutate(session)).rejects.toThrow("injected history replacement failure");
      expect(session.getHistory()).toEqual(original);
      await session.close();

      const store = new RuntimeEventStore({ databasePath });
      expect(
        (await store.readSession(sessionId)).filter((event) => event.kind === "history.rewound"),
      ).toHaveLength(0);
      expect(await store.readSessionManifest(sessionId)).toEqual(
        expect.objectContaining({ activeBranchId: "main" }),
      );

      const recovered = track(new Session(sessionId, workDir, { persistence: true }));
      await recovered.recover();
      expect(recovered.getHistory()).toEqual(original);
    },
  );

  function track(session: Session): Session {
    sessions.add(session);
    return session;
  }
});

function installReplacementFailure(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(`CREATE TRIGGER fail_session_history_replacement
      BEFORE INSERT ON agent_runtime_events
      WHEN NEW.run_id = 'session-history' AND NEW.kind = 'message.committed'
      BEGIN
        SELECT RAISE(ABORT, 'injected history replacement failure');
      END;`);
  } finally {
    database.close();
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
