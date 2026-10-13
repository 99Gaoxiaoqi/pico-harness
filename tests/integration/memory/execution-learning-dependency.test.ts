import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { ToolCall } from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "../../../packages/storage/src/sqlite/sqlite-memory-item-store.js";
import {
  dependencyPreparation,
  observeInstalledDependency,
} from "../../../packages/pico-host/src/execution-learning-dependency.js";
import {
  observeExecutionConditions,
  type ExecutionEvidenceIO,
} from "../../../packages/pico-host/src/execution-learning-evidence.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test(
  "natural npm preparation binds local package files to real Host receipts and rejects entry drift",
  { timeout: 30_000, skip: process.platform === "win32" },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pico-natural-dependency-")));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home"),
      bin = join(root, "bin"),
      sessionId = "natural-dependency";
    await mkdir(workDir);
    await mkdir(picoHome);
    await mkdir(bin);
    const savedPath = process.env.PATH;
    const savedTestContext = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
    const lifecycle = new AtomicMemoryLifecycle();
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    t.after(async () => {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = savedTestContext;
      await lifecycle.close();
      await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const index = "module.exports = 'ready';\n";
    // This controlled PATH executable does real local IO. Bash dispatch and T2 facts are produced by
    // the production registry; the fixture performs no network access or journal fabrication.
    const shim = join(bin, "npm");
    await writeFile(
      shim,
      `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] !== 'install' || process.argv[3] !== 'fixture-package@1.0.0') process.exit(64);
const root = path.join(process.cwd(), 'node_modules', 'fixture-package');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-package', version: '1.0.0', main: 'index.cjs' }));
fs.writeFileSync(path.join(root, 'index.cjs'), ${JSON.stringify(index)});
console.log('added local fixture-package');
`,
    );
    await chmod(shim, 0o755);
    await writeFile(
      join(workDir, "check.cjs"),
      "if (require('fixture-package') !== 'ready') process.exit(1); console.log('PASS');\n",
    );
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const command = "node check.cjs";
    const calls: ToolCall[] = [
      { id: "missing-package", name: "bash", arguments: JSON.stringify({ command }) },
      {
        id: "install-package",
        name: "bash",
        arguments: JSON.stringify({ command: "npm install fixture-package@1.0.0" }),
      },
      { id: "same-check", name: "bash", arguments: JSON.stringify({ command }) },
    ];
    let step = 0;
    const run = await executeAgentRuntime(
      {
        prompt: "运行 BuildCheck，使用自然安装步骤修好缺失的本地依赖，再运行同一检查。",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        permissionMode: "full-access",
        allowedTools: ["bash"],
      },
      {
        picoHome,
        memoryTrustStore: trust,
        atomicMemoryLifecycle: lifecycle,
        reporter: new SilentReporter(),
        executionLearningWorkerOptions: { idleMs: 0, pollMs: 10 },
        provider: {
          async generate() {
            const call = calls[step++];
            return call
              ? { role: "assistant", content: "", toolCalls: [call] }
              : { role: "assistant", content: "检查已完成。" };
          },
        },
      },
    );
    assert.equal(run.finalMessage, "检查已完成。");
    const workspaceKey = resolvePicoPaths(workDir, { picoHome }).workspace.id;
    let candidate = (
      await store.executionLearning.listExecutionLearningCandidates(workspaceKey)
    )[0];
    for (let attempt = 0; candidate?.state !== "saved" && attempt < 100; attempt++) {
      await new Promise((done) => setTimeout(done, 20));
      candidate = (await store.executionLearning.listExecutionLearningCandidates(workspaceKey))[0];
    }
    assert.ok(candidate);
    assert.equal(candidate.state, "saved", candidate.reason);
    assert.equal(candidate.claim.predicateId, "command-conditions.v1");
    const preparation = candidate.claim.recipe.find((step) => step.kind === "dependency");
    assert.ok(preparation);
    assert.equal(preparation.command, "npm install fixture-package@1.0.0");
    assert.ok(
      candidate.claim.conditions.some(
        (condition) => condition.kind === "node-package" && condition.name === "fixture-package",
      ),
    );
    const events = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
    });
    t.after(() => events.close());
    const install = await events.readToolOperation(
      sessionId,
      preparation.source.runId,
      "install-package",
    );
    assert.equal(install?.state, "settled");
    assert.equal(install?.outcomeEventId, preparation.source.eventId);
    const installOutcome = await events.readSessionEvent(sessionId, preparation.source.eventId);
    assert.equal(installOutcome?.event.kind, "tool.result.recorded");
    if (installOutcome?.event.kind === "tool.result.recorded") {
      assert.ok(installOutcome.event.data.projection.text.includes("added local fixture-package"));
    }
    const records = await store.executionLearning.listNativeFacts(
      candidate.claim.admission.admissionId,
    );
    assert.ok(
      records.some(
        (record) => record.toolCallId === "install-package" && record.kind === "command",
      ),
    );
    const io: ExecutionEvidenceIO = {
      async readFile(path, maxBytes) {
        if (!path.startsWith(`${root}/`) || (await stat(path)).size > maxBytes) return undefined;
        return readFile(path);
      },
      async realpath(path) {
        return path.startsWith(`${root}/`) ? realpath(path) : undefined;
      },
    };
    assert.equal((await observeExecutionConditions(candidate.claim.conditions, io)).matches, true);
    await writeFile(
      join(workDir, "node_modules", "fixture-package", "index.cjs"),
      "module.exports = 'changed';\n",
    );
    assert.equal((await observeExecutionConditions(candidate.claim.conditions, io)).matches, false);
    await writeFile(join(workDir, "node_modules", "fixture-package", "index.cjs"), index);
    assert.equal((await observeExecutionConditions(candidate.claim.conditions, io)).matches, true);
    const parsed = await dependencyPreparation("npm install fixture-package@1.0.0", workDir);
    assert.ok(parsed);
    const packageDir = join(workDir, "node_modules", "fixture-package");
    await writeFile(join(packageDir, "export.cjs"), index);
    assert.ok(
      candidate.claim.conditions.some(
        (condition) =>
          condition.kind === "file" &&
          condition.path === join(packageDir, "package.json") &&
          condition.hash === preparation.manifestHash,
      ),
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "fixture-package", version: "1.0.0", main: "export.cjs" }),
    );
    assert.equal(
      (await observeExecutionConditions(candidate.claim.conditions, io)).matches,
      false,
      "same name/version does not permit a different installation manifest",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        version: "1.0.0",
        main: "index.cjs",
        exports: "./export.cjs",
      }),
    );
    const exported = await observeInstalledDependency(parsed, io);
    assert.ok(
      !exported || exported.condition.entryPath === join(packageDir, "export.cjs"),
      "exports must override main or leave the preparation pending",
    );
    if (exported) assert.equal(exported.condition.entryHash, hash(index));
    for (const unsupported of [
      "npm install file:./fixture",
      "npm install fixture-package && node check.cjs",
      "npm install $PACKAGE",
      "npm install fixture-package > output",
    ]) {
      assert.equal(await dependencyPreparation(unsupported, workDir), undefined);
    }
  },
);
