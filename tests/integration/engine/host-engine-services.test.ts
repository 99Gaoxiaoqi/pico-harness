import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { Session } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { Tracer } from "@pico/runtime/trace";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";

test("Host Engine commits a real file journal and exports the Runtime trace under its scoped home", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-host-engine-services-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  const target = join(workDir, "target.txt");
  await writeFile(target, "before\n");
  const session = new Session("host-engine-services", workDir, { persistence: false, picoHome });
  const registry = new ToolRegistry();
  registry.register({
    name: () => "fixture_write",
    definition: () => ({
      name: "fixture_write",
      description: "write fixture",
      inputSchema: { type: "object", properties: {} },
    }),
    fileSideEffects: { kind: "exact", paths: [target] },
    async execute() {
      await writeFile(target, "after\n");
      return "updated";
    },
  });
  let calls = 0;
  const engine = new AgentEngine({
    workDir,
    registry,
    tracer: new Tracer(),
    provider: {
      async generate() {
        return ++calls === 1
          ? {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "write-1", name: "fixture_write", arguments: "{}" }],
            }
          : { role: "assistant", content: "done" };
      },
    },
  });
  try {
    const messageId = await session.beginRewindPoint({ userPrompt: "update target" });
    await session.commitMessages({ role: "user", content: "update target" });
    await engine.run(session);
    assert.equal(await readFile(target, "utf8"), "after\n");
    const snapshot = session.fileHistory.snapshots.find((item) => item.messageId === messageId);
    assert.ok(snapshot?.editedFilePaths.has(resolve(target)));
    const traceDir = resolvePicoPaths(workDir, { picoHome }).workspace.traces;
    const traces = await readdir(traceDir);
    assert.equal(traces.length, 1);
    assert.equal(JSON.parse(await readFile(join(traceDir, traces[0]!), "utf8")).name, "Agent.Run");
    await session.rewindCode(messageId);
    assert.equal(await readFile(target, "utf8"), "before\n");
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
