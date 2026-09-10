import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ToolResourceAuthority } from "../../../src/tools/tool-resource-authority.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("independent batches share file authority across symlink and hardlink aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-resource-authority-"));
  try {
    const authority = new ToolResourceAuthority();
    const file = join(root, "data");
    const alias = join(root, "alias");
    const hard = join(root, "hard");
    await writeFile(file, "before");
    await symlink(file, alias);
    await link(file, hard);
    const entered = gate();
    const finish = gate();
    const writer = authority.run(ToolAccesses.writeFile(file), undefined, async () => {
      entered.release();
      await finish.promise;
      await writeFile(file, "after");
    });
    await entered.promise;
    const observed: string[] = [];
    const readers = [alias, hard].map((path) =>
      authority.run(ToolAccesses.readFile(path), undefined, async () => {
        observed.push(await readFile(path, "utf8"));
      }),
    );
    const unrelated = join(root, "unrelated");
    await authority.run(ToolAccesses.writeFile(unrelated), undefined, () =>
      writeFile(unrelated, "independent"),
    );
    assert.deepEqual(observed, []);
    finish.release();
    await Promise.all([writer, ...readers]);
    assert.deepEqual(observed, ["after", "after"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting an active tool keeps its claim until the actual operation settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-resource-drain-"));
  try {
    const authority = new ToolResourceAuthority();
    const file = join(root, "file");
    await writeFile(file, "old");
    const entered = gate();
    const finish = gate();
    const controller = new AbortController();
    const writer = authority.run(ToolAccesses.writeFile(file), controller.signal, async () => {
      entered.release();
      await finish.promise;
      await writeFile(file, "settled");
    });
    await entered.promise;
    controller.abort();
    let readerStarted = false;
    const reader = authority.run(ToolAccesses.readFile(file), undefined, async () => {
      readerStarted = true;
      return readFile(file, "utf8");
    });
    await setImmediate();
    assert.equal(readerStarted, false);
    finish.release();
    await writer;
    assert.equal(await reader, "settled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity queues are independent of file locks and cancelled waiters never run", async () => {
  const authority = new ToolResourceAuthority();
  const entered = gate();
  const finish = gate();
  const first = authority.runLimited("mcp:one", 1, undefined, async () => {
    entered.release();
    await finish.promise;
  });
  await entered.promise;
  const controller = new AbortController();
  const waiting = authority.runLimited("mcp:one", 1, controller.signal, async () => {
    assert.fail("cancelled waiter executed");
  });
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  controller.abort();
  await rejected;
  await authority.run(ToolAccesses.all(), undefined, async () => "file work");
  await authority.runLimited("mcp:two", 1, undefined, async () => "other service");
  finish.release();
  await first;
});
