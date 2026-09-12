import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalRuntimeClient } from "../../../src/daemon/index.js";
import { ClientSessionRuntime } from "../../../src/tui/client-session-runtime.js";
import {
  createClientCommandRegistry,
  processClientInput,
} from "../../../src/tui/client-commands.js";
import { TuiReporter } from "../../../src/tui/tui-reporter.js";
import { TestRuntimeHostCandidateTracker } from "../helpers/test-runtime-daemon.js";

test("TUI memory commands persist and archive atomic memories through the real daemon", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-client-memory-"));
  const picoHome = join(root, "home");
  await mkdir(picoHome);
  await mkdir(join(root, "workspace"));
  const workspacePath = await realpath(join(root, "workspace"));
  const previousHome = process.env.PICO_HOME;
  process.env.PICO_HOME = picoHome;
  const candidates = new TestRuntimeHostCandidateTracker();
  const client = new LocalRuntimeClient({
    runtimeHostRootPath: picoHome,
    candidateLauncher: candidates.launcher,
  });
  const runtime = new ClientSessionRuntime({ client, workspacePath, reporter: new TuiReporter() });
  t.after(async () => {
    try {
      runtime.dispose();
      client.close();
      await candidates.stopAll();
    } finally {
      if (previousHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
  await client.request("runtime.ping", {});
  await client.request("workspace.register", { workspacePath });
  const registry = createClientCommandRegistry({ runtime, workspacePath });
  const command = async (input: string) => {
    const result = await processClientInput(input, registry, runtime);
    assert.equal(result.kind, "local");
    return String(result.result?.message);
  };
  assert.match(await command("/memory remember 未信任工作区不能保存记忆"), /Memory unavailable/);
  await assert.rejects(access(join(picoHome, "memory.sqlite")), { code: "ENOENT" });
  await client.request("workspace.trust", { workspacePath, trusted: true });
  await runtime.start();
  const content = "项目结构说明请使用简体中文,并先给结论。";
  const remembered = await command(`/memory remember ${content}`);
  const undo = remembered.match(/\/memory undo (\S+)/)?.[1];
  assert.ok(undo, remembered);
  const { items } = await client.request("memory.list", {
    workspacePath,
    lifecycleStates: ["active"],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.content, content);
  assert.equal(items[0]?.kind, "note", "the daemon must return the atomic Memory Item");
  const status = await command("/memory status");
  assert.match(status, /Automatic extraction: on/);
  assert.match(status, /Active items: 1/);
  assert.doesNotMatch(status, /Review mode|Pending proposals/);
  assert.match(await command(`/memory undo ${undo}`), /archived/);
  const archived = await client.request("memory.get", {
    workspacePath,
    itemId: items[0]!.itemId,
  });
  assert.equal(archived.item.lifecycleState, "archived");
  assert.match(await command("/memory status"), /Archived items: 1/);
  await command("/memory off");
  assert.equal(
    (await client.request("memory.settings.get", { workspacePath })).settings.enabled,
    false,
  );
  await command("/memory on");
  assert.equal(
    (await client.request("memory.settings.get", { workspacePath })).settings.enabled,
    true,
  );
  assert.equal(
    (await client.request("runs.list", { workspacePath })).runs.length,
    0,
    "manual memory commands must not start model runs",
  );
});
