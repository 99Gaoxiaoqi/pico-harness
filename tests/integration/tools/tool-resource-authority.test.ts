import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile, link, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ToolResourceAuthority } from "../../../src/tools/tool-resource-authority.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";
import { createBrowserAgentTools } from "../../../src/tools/browser-agent.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";

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

test("browser authority serializes separate Registries for the same browser session", async () => {
  const entered = gate();
  const finish = gate();
  const events: string[] = [];
  const sessionId = `browser-resource-${Date.now()}`;
  const browser = {
    sessionId,
    async execute(action: string) {
      events.push(action);
      if (action === "navigate") {
        entered.release();
        await finish.promise;
      }
      return { action };
    },
  };
  const first = new ToolRegistry();
  const second = new ToolRegistry();
  for (const tool of createBrowserAgentTools(browser)) first.register(tool);
  for (const tool of createBrowserAgentTools(browser)) second.register(tool);
  const navigating = first.execute({
    id: "navigate",
    name: "browser_navigate",
    arguments: '{"url":"https://example.com"}',
  });
  await entered.promise;
  const reading = second.execute({ id: "state", name: "browser_get_state", arguments: "{}" });
  await setImmediate();
  assert.deepEqual(events, ["navigate"]);
  finish.release();
  const results = await Promise.all([navigating, reading]);
  assert.ok(results.every((result) => !result.isError));
  assert.deepEqual(events, ["navigate", "get_state"]);
});

test("queued readers reacquire the published inode after an atomic file replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-resource-publish-"));
  try {
    const file = join(root, "file");
    await writeFile(file, "old");
    const authority = new ToolResourceAuthority();
    const entered = gate();
    const finish = gate();
    const writer = authority.run(ToolAccesses.writeFile(file), undefined, async () => {
      entered.release();
      await finish.promise;
      const next = join(root, "next");
      await writeFile(next, "new");
      await rename(next, file);
    });
    await entered.promise;
    const reader = authority.run(ToolAccesses.readFile(file), undefined, () =>
      readFile(file, "utf8"),
    );
    await setImmediate();
    finish.release();
    await writer;
    assert.equal(await reader, "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new-file case aliases cannot overlap before a physical inode exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-resource-case-"));
  try {
    const authority = new ToolResourceAuthority();
    const entered = gate();
    const finish = gate();
    let active = 0;
    let peak = 0;
    const first = authority.run(
      ToolAccesses.writeFile(join(root, "NewFile")),
      undefined,
      async () => {
        peak = Math.max(peak, ++active);
        entered.release();
        await finish.promise;
        active--;
      },
    );
    await entered.promise;
    const second = authority.run(
      ToolAccesses.writeFile(join(root, "newfile")),
      undefined,
      async () => {
        peak = Math.max(peak, ++active);
        active--;
      },
    );
    await setImmediate();
    finish.release();
    await Promise.all([first, second]);
    assert.equal(peak, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
