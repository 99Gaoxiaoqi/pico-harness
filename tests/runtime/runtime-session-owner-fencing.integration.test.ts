import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { writeJsonAtomic } from "../../src/storage/atomic-json.js";
import type { OwnerLeaseRecord } from "../../src/storage/owner-lease.js";

describe("durable Session owner fencing", () => {
  let workDir: string;
  const sessions = new Set<Session>();

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-session-owner-fencing-"));
  });

  afterEach(async () => {
    await Promise.allSettled([...sessions].map((session) => session.close()));
    sessions.clear();
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("stops accepted and future writes after another owner replaces the lease", async () => {
    const sessionId = "session-owner-lost";
    const session = new Session(sessionId, workDir, { persistence: true });
    sessions.add(session);
    await session.recover();
    await session.commitMessages({ role: "user", content: "durable seed" });
    const store = session.runtimeEventStore!;
    const before = await store.readSession(sessionId);

    const ownerPath = sessionOwnerPath(workDir, sessionId);
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerLeaseRecord;
    await writeJsonAtomic(ownerPath, {
      ...owner,
      leaseId: "replacement-owner-lease",
      ownerId: "replacement-owner",
    } satisfies OwnerLeaseRecord);

    // Both writes pass the synchronous admission check before the first queued check fails.
    const first = session.commitMessages({ role: "assistant", content: "must not persist" });
    const alreadyAccepted = session.commitMessages({
      role: "user",
      content: "queued write must not persist",
    });

    await expect(first).rejects.toMatchObject({ name: "LeaseConflictError" });
    await expect(alreadyAccepted).rejects.toMatchObject({ name: "SessionWriteUncertainError" });
    expect(() => session.saveMemorySummary("must not save", 1)).toThrow(
      "Runtime Session owner lease was lost",
    );
    expect(await store.readSession(sessionId)).toEqual(before);
  });
});

function sessionOwnerPath(workDir: string, sessionId: string): string {
  const workspace = resolvePicoPaths(workDir).workspace;
  const scope = createHash("sha256").update(`${workspace.id}\0${sessionId}`).digest("hex");
  return join(workspace.root, "session-owners", scope, "owner.json");
}
