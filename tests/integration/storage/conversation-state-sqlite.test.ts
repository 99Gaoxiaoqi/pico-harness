import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "@pico/protocol";
import {
  FIRST_SEND_CLAIM_RETENTION_MS,
  normalizeWorkspacePath,
} from "../../../src/daemon/desktop-conversation-state.js";
import { closeAllOperationalDatabasesForTest } from "../../../src/storage/sqlite/sqlite-database.js";
import { SqliteDesktopConversationStateStore } from "../../../src/storage/sqlite/sqlite-desktop-conversation-state-store.js";

interface Fixture {
  readonly root: string;
  readonly picoHome: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
}

function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const picoHome = join(root, "pico-home");
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
  return { root, picoHome, workspaceA, workspaceB };
}

function cleanupFixture(root: string): void {
  closeAllOperationalDatabasesForTest();
  rmSync(root, { recursive: true, force: true });
}

test("sqlite conversation state isolates idempotency and rewind claims by workspace", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-idem-");
  try {
    const store = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    const claims = await Promise.all([
      store.claimRewind(
        fixture.workspaceA,
        "rewind-key",
        "source",
        "target-one",
        "operation-one",
        "fingerprint-one",
      ),
      store.claimRewind(
        fixture.workspaceA,
        "rewind-key",
        "source",
        "target-two",
        "operation-two",
        "fingerprint-two",
      ),
    ]);
    assert.deepEqual(claims[1], claims[0]);
    assert.equal(claims[0]?.targetSessionId, "target-one");
    assert.equal(await store.getIdempotent(fixture.workspaceA, "rewind-key"), undefined);

    await store.rememberIdempotent(fixture.workspaceA, "rewind-key", "fingerprint-one", {
      applied: true,
      sessionId: "target-one",
    });
    assert.equal(await store.getRewindClaim(fixture.workspaceA, "rewind-key"), undefined);
    assert.deepEqual(await store.getIdempotent(fixture.workspaceA, "rewind-key"), {
      requestFingerprint: "fingerprint-one",
      result: { applied: true, sessionId: "target-one" },
    });
    assert.equal(await store.getIdempotent(fixture.workspaceB, "rewind-key"), undefined);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state supports queue and first-send claim lifecycle", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-queue-");
  try {
    let sequence = 0;
    let clock = 2_000;
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => (clock += 10),
      generateId: () => `queue-${++sequence}`,
    });
    const canonical = normalizeWorkspacePath(fixture.workspaceA);

    await store.enqueue(fixture.workspaceA, "session-1", { kind: "text", text: "hello" });
    await store.enqueue(fixture.workspaceA, "session-1", {
      kind: "skill",
      name: "review",
      args: "focus",
    });
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-1"), [
      {
        queueId: "queue-1",
        workspacePath: canonical,
        sessionId: "session-1",
        input: { kind: "text", text: "hello" },
        createdAt: 2_010,
      },
      {
        queueId: "queue-2",
        workspacePath: canonical,
        sessionId: "session-1",
        input: { kind: "skill", name: "review", args: "focus" },
        createdAt: 2_020,
      },
    ]);
    assert.deepEqual(await store.listQueued(fixture.workspaceB, "session-1"), []);

    await store.removeQueued(fixture.workspaceA, "queue-1");
    assert.deepEqual(
      (await store.listQueued(fixture.workspaceA, "session-1")).map((item) => item.queueId),
      ["queue-2"],
    );
    await store.clearQueued(fixture.workspaceA, "session-1");
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-1"), []);

    const claim = await store.claimFirstSend(fixture.workspaceA, "claim-key", "session-1", "fp-1");
    assert.deepEqual(
      await store.claimFirstSend(fixture.workspaceA, "claim-key", "session-9", "fp-9"),
      claim,
    );
    await store.rememberIdempotent(fixture.workspaceA, "claim-key", "fp-1", { ok: true });
    assert.equal(await store.getFirstSendClaim(fixture.workspaceA, "claim-key"), undefined);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state rolls back a failed idempotency write", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-rollback-");
  try {
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => 5_000,
    });
    const claim = await store.claimFirstSend(fixture.workspaceA, "key-1", "session-1", "fp-1");
    const poisoned = { big: 1n } as unknown as JsonObject;
    await assert.rejects(
      store.rememberIdempotent(fixture.workspaceA, "key-1", "fp-1", poisoned),
      /BigInt/u,
    );
    assert.deepEqual(await store.getFirstSendClaim(fixture.workspaceA, "key-1"), claim);
    assert.equal(await store.getIdempotent(fixture.workspaceA, "key-1"), undefined);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state expires first-send claims", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-retention-");
  try {
    let clock = 1_000_000;
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => clock,
    });
    await store.claimFirstSend(fixture.workspaceA, "expire-key", "session-1", "fp-1");
    clock += FIRST_SEND_CLAIM_RETENTION_MS + 1;
    assert.equal(await store.getFirstSendClaim(fixture.workspaceA, "expire-key"), undefined);
    const renewed = await store.claimFirstSend(
      fixture.workspaceA,
      "expire-key",
      "session-2",
      "fp-2",
    );
    assert.equal(renewed.sessionId, "session-2");
    assert.equal(renewed.requestFingerprint, "fp-2");
    assert.equal(renewed.createdAt, clock);
  } finally {
    cleanupFixture(fixture.root);
  }
});
