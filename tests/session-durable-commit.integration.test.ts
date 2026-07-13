import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionJournalIntegrityError,
  SessionStore,
  SessionWriteUncertainError,
} from "../src/engine/session-store.js";
import { createSessionIdentity } from "../src/engine/session-identity.js";
import { FTS5Store } from "../src/memory/fts5-store.js";
import { SessionManager } from "../src/engine/session.js";
import { StorageOperationJournal } from "../src/storage/operation-journal.js";
import Database from "better-sqlite3";

describe("Session durable commit integration", () => {
  let workDir: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-session-durable-"));
  });

  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    await rm(workDir, { recursive: true, force: true });
  });

  it("persists canonical seq/eventId/epoch and restores the durable head", async () => {
    const filePath = join(workDir, ".claw", "sessions", "durable.jsonl");
    const identity = createSessionIdentity({ sessionId: "durable", cwd: workDir });
    const first = new SessionStore(filePath, identity);

    const message = await first.commitMessage({ role: "user", content: "before rewind" });
    first.bumpEpoch();
    const rewind = await first.commitRewind(0);
    await first.close();

    expect(message.cursor).toMatchObject({ seq: 0, epoch: 0, eventId: message.eventId });
    expect(rewind.cursor).toMatchObject({ seq: 1, epoch: 1, eventId: rewind.eventId });

    const reopened = new SessionStore(filePath, identity);
    await reopened.openWriter();
    expect(reopened.getEpoch()).toBe(1);
    expect(reopened.getHeadCursor()).toEqual(rewind.cursor);
    const next = await reopened.commitMessage({ role: "user", content: "after restart" });
    expect(next.cursor).toMatchObject({ seq: 2, epoch: 1 });
    await reopened.close();
  });

  it("reuses a stable eventId without allocating a seq and rejects mismatched payloads", async () => {
    const filePath = join(workDir, ".claw", "sessions", "idempotent.jsonl");
    const store = new SessionStore(filePath, undefined, { maxWriteBytes: 3 });
    const first = await store.commitMessage(
      { role: "user", content: "deliver once" },
      { eventId: "completion:job-a:1" },
    );
    const retry = await store.commitMessage(
      { role: "user", content: "deliver once" },
      { eventId: "completion:job-a:1", expectedSeq: 99 },
    );
    expect(first).toMatchObject({ inserted: true, cursor: { seq: 0 } });
    expect(retry).toEqual({ ...first, inserted: false });
    const next = await store.commitMessage({ role: "assistant", content: "next" });
    expect(next.cursor.seq).toBe(1);
    await expect(
      store.commitMessage(
        { role: "user", content: "different" },
        { eventId: "completion:job-a:1" },
      ),
    ).rejects.toBeInstanceOf(SessionWriteUncertainError);
    await store.close();
  });

  it("rejects seq gaps and becomes fail-closed when durability is uncertain", async () => {
    const corruptPath = join(workDir, "gap.jsonl");
    await writeFile(
      corruptPath,
      [
        JSON.stringify({ type: "message", seq: 0, message: { role: "user", content: "a" } }),
        JSON.stringify({ type: "message", seq: 2, message: { role: "user", content: "gap" } }),
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(new SessionStore(corruptPath).loadStrict()).rejects.toBeInstanceOf(
      SessionJournalIntegrityError,
    );

    const uncertainPath = join(workDir, "uncertain.jsonl");
    const store = new SessionStore(uncertainPath, undefined, {
      beforeDatasync: () => {
        throw new Error("injected fdatasync failure");
      },
    });
    await expect(
      store.commitMessage({ role: "user", content: "uncertain" }),
    ).rejects.toBeInstanceOf(SessionWriteUncertainError);
    expect(store.state).toBe("write_uncertain");
    await expect(
      store.commitMessage({ role: "user", content: "must not continue" }),
    ).rejects.toBeInstanceOf(SessionWriteUncertainError);
    await store.close();
  });

  it("arbitrates the same journal across real processes", async () => {
    const filePath = join(workDir, "cross-process.jsonl");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "engine", "session-store.ts")).href;
    const script = `
      import { SessionStore } from ${JSON.stringify(moduleUrl)};
      const store = new SessionStore(${JSON.stringify(filePath)});
      await store.openWriter();
      console.log("READY");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await store.close();
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);
    await waitForReady(child);

    const contender = new SessionStore(filePath);
    await expect(contender.openWriter()).rejects.toThrow(/Lease is owned|cannot be verified/u);
    await waitForExit(child);
  });

  it("commits the FTS document and projection cursor in one API transaction", () => {
    const store = new FTS5Store(workDir);
    if (store.status.state === "degraded") return;
    const firstCursor = { logId: "log-a", seq: 0, epoch: 0, eventId: "event-a" };
    store.projectInsert(
      "session-a",
      0,
      { role: "user", content: "durable projection" },
      firstCursor,
    );
    expect(store.getProjectionCursor("session-a")).toEqual(firstCursor);
    expect(store.search("durable", 10, "session-a")).toHaveLength(1);

    const secondCursor = { logId: "log-a", seq: 1, epoch: 1, eventId: "event-b" };
    store.projectReplace(
      "session-a",
      [{ role: "assistant", content: "rebuilt projection" }],
      secondCursor,
    );
    expect(store.getProjectionCursor("session-a")).toEqual(secondCursor);
    expect(store.search("rebuilt", 10, "session-a")).toHaveLength(1);
    store.close();
  });

  it("catches an FTS projection up to the JSONL durable head on restart", async () => {
    const capability = new FTS5Store(workDir);
    if (capability.status.state === "degraded") return;
    capability.close();

    const firstManager = new SessionManager();
    const first = await firstManager.getOrCreate("catch-up", workDir, { persistence: true });
    await first.commitMessages({ role: "user", content: "recoverable projection" });
    const head = first.recordStore?.getHeadCursor();
    expect(head).toBeDefined();
    await first.close();

    const dbPath = join(workDir, ".claw", "sessions.db");
    const db = new Database(dbPath);
    db.prepare("DELETE FROM conversation_chunks WHERE session_id = ?").run("catch-up");
    db.prepare("DELETE FROM session_projection_cursor WHERE session_id = ?").run("catch-up");
    db.close();

    const second = await new SessionManager().getOrCreate("catch-up", workDir, {
      persistence: true,
    });
    expect(second.search("recoverable projection")).toHaveLength(1);
    const verify = new Database(dbPath, { readonly: true });
    const cursor = verify
      .prepare(
        `SELECT log_id AS logId, seq, epoch, event_id AS eventId
         FROM session_projection_cursor WHERE session_id = ?`,
      )
      .get("catch-up");
    verify.close();
    expect(cursor).toEqual(head);
    await second.close();
  });

  it("marks a prepared rewind for attention when later session messages drift the precondition", async () => {
    const sessionId = `rewind-drift-${Date.now()}`;
    const first = await new SessionManager().getOrCreate(sessionId, workDir, {
      persistence: true,
    });
    const messageId = await first.beginRewindPoint({ userPrompt: "original request" });
    const user = await first.commitMessageOnce(`user-message:${messageId}`, {
      role: "user",
      content: "original request",
    });
    await first.bindRewindPointSource(messageId, user);
    const before = first.getHistory();
    const journal = new StorageOperationJournal({ workDir });
    await journal.create({
      operationId: "rewind-session-drift",
      kind: "rewind",
      sessionId,
      mode: "conversation",
      precondition: {
        sessionLastSeq: user.cursor.seq,
        effectiveHistoryDigest: createHash("sha256")
          .update(JSON.stringify(before))
          .digest("hex"),
        fileHistoryRevision: first.fileHistory.revision,
      },
      target: {
        messageId,
        sourceMessageEventId: user.eventId,
        messageIndex: 0,
      },
      files: [],
    });
    await first.commitMessages({ role: "assistant", content: "later durable message" });
    await first.close();

    const reopened = await new SessionManager().getOrCreate(sessionId, workDir, {
      persistence: true,
    });
    expect(reopened.getHistory().map((message) => message.content)).toEqual([
      "original request",
      "later durable message",
    ]);
    await expect(journal.get("rewind-session-drift")).resolves.toMatchObject({
      state: "needs_attention",
      error: { message: expect.stringContaining("precondition drifted") },
    });
    await reopened.close();
  });
});

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`child did not acquire lease: ${stderr}`)),
      5_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!stdout.includes("READY")) return;
      clearTimeout(timer);
      resolve();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited before ready (${String(code)}): ${stderr}`));
    });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`child exit ${code}`)),
    );
    child.once("error", reject);
  });
}
