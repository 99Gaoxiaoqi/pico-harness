import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { LeaseConflictError } from "../../src/storage/owner-lease.js";

describe("durable Runtime Session ownership", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-owner-"));
  });

  afterEach(async () => {
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("fails closed for a second live writer and releases ownership on close", async () => {
    const owner = new Session("session-a", workDir, { persistence: true });
    await owner.recover();

    const contender = new Session("session-a", workDir, { persistence: true });
    await expect(contender.recover()).rejects.toBeInstanceOf(LeaseConflictError);
    await contender.close();

    await owner.close();
    const successor = new Session("session-a", workDir, { persistence: true });
    await expect(successor.recover()).resolves.toBeUndefined();
    await successor.close();
  });
});
