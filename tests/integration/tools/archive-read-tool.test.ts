import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  LLMProvider,
  RuntimeToolResultProjectionRecordedEvent,
  RuntimeToolResultRecordedEvent,
} from "@pico/core";
import { Session } from "@pico/pico-host/session";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { buildDefaultToolRegistry } from "@pico/pico-host/default-registry";
import { ArchiveReadTool } from "@pico/pico-host/archive-read-tool";
import { ReadFileTool } from "@pico/pico-host/read-file-tool";
import { isResearchToolAllowed } from "../../../packages/pico-host/src/research-mode.js";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { bindToolResultArchiveReader } from "@pico/runtime/tool-result-archive";
import {
  isPlanModeTool,
  isToolSupportedForHost,
  findGroupForTool,
} from "@pico/runtime/tool-surface";

const text =
  "First line\nNeedle [.*] line\n" + 'many "escaped" lines\n'.repeat(800) + "final needle";
const structured = JSON.stringify({
  kind: "agent_swarm",
  items: [
    { itemId: "worker-1", status: "completed", summary: "Worker result\n".repeat(1000) },
    { item_id: "worker-2", result: 'quoted "result" '.repeat(1000) },
  ],
});
const terminal = JSON.stringify({ kind: "terminal", output: { stdout: text, stderr: "ERR line" } });

async function fixture(t: TestContext, enableDecoder = true) {
  const root = await mkdtemp(join(tmpdir(), "pico-archive-read-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const runtimePort = createEngineRuntimePort();
  const session = new Session("archive-api", workDir, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort,
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const reader = bindToolResultArchiveReader(session.runtimeEventStore!, session.id);
  const registry = buildDefaultToolRegistry(
    workDir,
    enableDecoder ? { toolResultArchive: reader } : {},
  );
  registry.register({
    readOnly: true,
    name: () => "archive_fixture",
    definition: () => ({
      name: "archive_fixture",
      description: "test",
      inputSchema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] },
    }),
    execute: async (args) => ({ text, structured, terminal })[JSON.parse(args).kind as "text"],
  });
  let calls = 0;
  const provider: LLMProvider = {
    async generate(messages) {
      if (calls++ === 0)
        return {
          role: "assistant",
          content: "",
          toolCalls: ["text", "structured", "terminal"].map((kind) => ({
            id: `call:${kind}`,
            name: "archive_fixture",
            arguments: JSON.stringify({ kind }),
          })),
        };
      if (!enableDecoder)
        assert.equal(messages.find((message) => message.toolCallId === "call:text")!.content, text);
      return { role: "assistant", content: "done" };
    },
  };
  await session.commitMessages({ role: "user", content: "Archive fixture" });
  await new AgentEngine({
    provider,
    registry,
    runtimePort,
    workDir,
    reporter: new SilentReporter(),
    maxTurns: 2,
  }).run(session);
  const events = await session.runtimeEventStore!.readSession(session.id);
  const results = events.filter(
    (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
  );
  const projections = events.filter(
    (event): event is RuntimeToolResultProjectionRecordedEvent =>
      event.kind === "tool.result.projection.recorded",
  );
  const ref = (kind: string) => {
    const source = results.find((event) => event.refs.toolCallId === `call:${kind}`)!;
    return projections
      .find((event) => event.data.sourceEventId === source.eventId)!
      .data.projection.text.match(/pico:\/\/archive\/[^"\s]+/u)![0];
  };
  return { reader, registry, ref, session, results, workDir };
}

test("archive_read ports inspect/query/search/line/char over session-bound durable inline results", async (t) => {
  const f = await fixture(t);
  let id = 0;
  async function read(input: Record<string, unknown>) {
    const result = await f.registry.execute({
      id: `archive-read:${id++}`,
      name: "archive_read",
      arguments: JSON.stringify(input),
    });
    assert.equal(result.isError, false);
    assert.ok(result.output.length <= 7500);
    return JSON.parse(result.output);
  }
  assert.equal(f.registry.isToolResultArchiveReader("archive_read"), true);
  assert.equal(f.registry.isToolResultArchiveReader("read_file"), true);
  assert.equal(f.registry.isReadOnlyTool("archive_read"), true);
  assert.equal(isPlanModeTool("archive_read"), true);
  assert.equal(isResearchToolAllowed("archive_read"), true);
  assert.equal(isToolSupportedForHost("archive_read", "headless"), true);
  assert.equal(findGroupForTool("archive_read")?.economy, "always");
  const manifest = await read({ ref: f.ref("structured") });
  assert.equal(manifest.valueType, "object");
  assert.deepEqual(
    manifest.items.map((item: { itemId: string }) => item.itemId),
    ["worker-1", "worker-2"],
  );
  const item = await read({
    ref: f.ref("structured"),
    operation: "query",
    itemId: "worker-2",
    offset: 7,
    limit: 6000,
  });
  assert.equal(item.content, 'quoted "result" '.repeat(1000).slice(7, 7 + item.limit));
  assert.equal(item.nextOffset, 7 + item.limit);
  const inspected = await read({ ref: f.ref("text"), operation: "inspect" });
  assert.equal(inspected.valueType, "text");
  assert.equal(inspected.totalLines, text.split("\n").length);
  const page = await read({ ref: f.ref("text"), operation: "read", offset: 0, limit: 6000 });
  assert.equal(page.content, text.slice(0, page.limit));
  assert.ok(page.limit > 1000);
  const lines = await read({
    ref: f.ref("text"),
    operation: "read",
    unit: "line",
    offset: 1,
    limit: 2,
  });
  assert.equal(lines.content, 'Needle [.*] line\nmany "escaped" lines');
  assert.equal(lines.nextLineOffset, 3);
  const search = await read({ ref: f.ref("text"), operation: "search", pattern: "[.*]" });
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].offset, text.indexOf("[.*]"));
  assert.equal(search.matches[0].line, 2);
  const folded = await read({ ref: f.ref("text"), operation: "search", pattern: "NEEDLE" });
  assert.equal(folded.matches.length, 2);
  const term = await read({ ref: f.ref("terminal"), operation: "inspect" });
  assert.equal(term.valueType, "terminal");
  assert.equal(term.totalChars, text.length + "\nERR line".length);
  const termLines = await read({
    ref: f.ref("terminal"),
    operation: "read",
    unit: "line",
    offset: 0,
    limit: 2,
  });
  assert.equal(termLines.content, "First line\nNeedle [.*] line");
  const compat = new ReadFileTool(f.workDir, f.reader);
  const compatibilityPage = JSON.parse(
    await compat.execute(JSON.stringify({ path: f.ref("text"), offset: 1, limit: 6000 })),
  );
  assert.ok(compatibilityPage.content.length > 1000);
  await assert.rejects(
    compat.execute(JSON.stringify({ path: "normal.txt", limit: 1001 })),
    /limit 不能超过 1000/u,
  );
  const wrongSession = new ArchiveReadTool(
    bindToolResultArchiveReader(f.session.runtimeEventStore!, "another"),
  );
  assert.equal(
    JSON.parse(await wrongSession.execute(JSON.stringify({ ref: f.ref("text") }))).ok,
    false,
  );
  assert.equal(
    (await read({ ref: f.ref("text").replace(/\/[a-f0-9]{64}\//u, `/${"0".repeat(64)}/`) })).ok,
    false,
  );
  assert.equal(
    (await read({ ref: f.ref("text"), operation: "query", itemId: "missing" })).reason,
    "not_queryable",
  );
  await assert.rejects(
    new ArchiveReadTool(f.reader).execute(
      JSON.stringify({ ref: f.ref("text"), operation: "search", pattern: "x".repeat(257) }),
    ),
    /256/u,
  );
});

test("unbound tool surfaces keep successful large results full and advertise no archive reader", async (t) => {
  const f = await fixture(t, false);
  assert.equal(f.registry.isToolResultArchiveReader("read_file"), false);
  assert.equal(f.registry.isToolResultArchiveReader("archive_read"), false);
  assert.equal(
    f.registry.getAvailableTools().some((tool) => tool.name === "archive_read"),
    false,
  );
  assert.ok(f.results.every((result) => result.data.projection.mode === "full"));
});
