import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodeIntelligenceManager } from "@pico/pico-host/code-intelligence";

test("managed Repo Map keeps a progressive index inside a network-denied session worker", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-managed-code-"));
  const manager = new CodeIntelligenceManager({
    rootDir: root,
    lspEnabled: false,
    processSandbox: { bypass: false, generation: 41, workspaceRoots: [root] },
  });
  context.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "a.ts"), "export function alpha() {}\n");
  await writeFile(join(root, "b.ts"), "export function beta() {}\n");

  assert.throws(() => manager.repoMap(), /Worker 尚未就绪/u);
  assert.equal((await manager.start()).backend, "repo-map");
  assert.equal(manager.canRunManagedReads(41), true);
  assert.equal(manager.canRunManagedReads(40), false);

  const first = await manager.repoMap().snapshot({ maxFiles: 1 });
  const second = await manager.repoMap().snapshot({ maxFiles: 1 });
  assert.equal(first.indexedFiles, 1);
  assert.equal(first.cursor, 1);
  assert.equal(first.complete, false);
  assert.equal(second.indexedFiles, 2);
  assert.equal(second.cursor, 2);
  assert.equal(second.complete, true);
  assert.deepEqual(
    (await manager.service()!.symbols({ filePath: "b.ts" })).map((symbol) => symbol.name),
    ["beta"],
  );

  const priorWorker = manager.repoMap();
  await manager.updateProcessSandbox({ bypass: false, generation: 42, workspaceRoots: [root] });
  assert.equal(manager.canRunManagedReads(41), false);
  assert.equal(manager.canRunManagedReads(42), true);
  await assert.rejects(priorWorker.snapshot({ maxFiles: 1 }), /已关闭|不可用/u);
  assert.equal((await manager.repoMap().snapshot({ maxFiles: 1 })).cursor, 1);
});

test("managed document reads reject a symlink outside the bound workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-managed-code-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "pico-managed-code-outside-"));
  const manager = new CodeIntelligenceManager({
    rootDir: root,
    lspEnabled: false,
    processSandbox: { bypass: false, generation: 7, workspaceRoots: [root] },
  });
  context.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(root, "safe.ts"), "export const safe = 1;\n");
  await writeFile(join(outside, "secret.ts"), "export const SECRET_OUTSIDE = 1;\n");
  await symlink(join(outside, "secret.ts"), join(root, "linked.ts"));

  await manager.start();
  assert.equal(manager.canRunManagedReads(7), true);
  const worker = manager.repoMap();
  assert.ok("readDocument" in worker);
  const readDocument = worker.readDocument.bind(worker);
  assert.match((await readDocument("safe.ts")).text, /safe/u);
  await assert.rejects(readDocument("linked.ts"), /路径越界|工作区|EPERM|EACCES/u);
  await assert.rejects(
    manager.service()!.symbols({ filePath: "linked.ts" }),
    /路径越界|工作区|EPERM|EACCES/u,
  );
});

test("managed LSP opens documents through the worker and falls back to its Repo Map", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-managed-lsp-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.ts"), "export function workerDocument() {}\n");
  const serverPath = join(root, "server.mjs");
  await writeFile(
    serverPath,
    `let input = Buffer.alloc(0);
let opened = false;
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const headerEnd = input.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("utf8");
    const length = Number(/Content-Length:\\s*(\\d+)/i.exec(header)?.[1]);
    if (!Number.isSafeInteger(length) || input.length < headerEnd + 4 + length) return;
    const message = JSON.parse(input.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
    input = input.subarray(headerEnd + 4 + length);
    if (message.method === "textDocument/didOpen") opened = message.params.textDocument.text.includes("workerDocument");
    if (message.id === undefined) continue;
    const result = message.method === "initialize" ? { capabilities: { definitionProvider: true } }
      : message.method === "textDocument/definition" && opened
        ? { uri: message.params.textDocument.uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 30 } } }
        : null;
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
  }
});
`,
  );
  const manager = new CodeIntelligenceManager({
    rootDir: root,
    lspEnabled: true,
    lspServers: [{ id: "fixture", command: process.execPath, args: [serverPath] }],
    processSandbox: { bypass: false, generation: 12, workspaceRoots: [root] },
  });
  context.after(() => manager.close());
  assert.equal((await manager.start()).backend, "lsp");
  assert.equal(manager.canRunManagedReads(12), true);
  const definitions = await manager.service()!.definitions({
    filePath: "source.ts",
    position: { line: 1, character: 24 },
  });
  assert.equal(definitions.length, 1);
  assert.match(definitions[0]!.filePath, /source\.ts$/u);

  await manager.setLspEnabled(false);
  assert.equal(manager.service()!.backend, "repo-map");
  assert.equal(manager.canRunManagedReads(12), true);
  assert.deepEqual(
    (await manager.service()!.symbols({ filePath: "source.ts" })).map((symbol) => symbol.name),
    ["workerDocument"],
  );
});
