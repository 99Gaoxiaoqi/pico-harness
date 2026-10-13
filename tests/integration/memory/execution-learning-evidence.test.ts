import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import type {
  ExecutionAcceptanceClaim,
  ExecutionVerificationResult,
  ExecutionVerificationTicket,
  MemoryItemSource,
} from "../../../packages/core/src/index.js";
import type * as Evidence from "../../../packages/pico-host/src/execution-learning-evidence.js";

const execute = promisify(exec);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test(
  "native Node reporter proves one prepared workflow and rejects stdout or incomplete evidence",
  { timeout: 30_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pico-execution-evidence-")));
    const workspace = join(root, "workspace"),
      bundle = join(root, "host");
    await mkdir(workspace);
    await mkdir(bundle);
    await writeFile(join(bundle, "package.json"), '{"type":"module"}');
    t.after(() => rm(root, { recursive: true, force: true }));
    // Bundle the new Host sources, not @pico/pico-host's existing dist. The parser remains its own source module
    // so import.meta.url continues to locate its trusted grammar resource.
    await build({
      entryPoints: [
        resolve("packages/pico-host/src/execution-learning-evidence.ts"),
        resolve("packages/pico-host/src/execution-learning-reporter.ts"),
      ],
      outdir: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      plugins: [
        {
          name: "current-parser-source",
          setup(builder) {
            builder.onResolve({ filter: /^@pico\/runtime\/bash-parser$/ }, () => ({
              path: pathToFileURL(resolve("packages/runtime/src/bash-parser.ts")).href,
              external: true,
            }));
            builder.onResolve(
              { filter: /^@pico\/runtime\/atomic-memory\/content-safety$/ },
              () => ({
                path: resolve("packages/runtime/src/atomic-memory/content-safety.ts"),
              }),
            );
          },
        },
      ],
    });
    const evidence = (await import(
      pathToFileURL(join(bundle, "execution-learning-evidence.js")).href
    )) as typeof Evidence;
    const io: Evidence.ExecutionEvidenceIO = {
      async readFile(path, maxBytes) {
        if (!path.startsWith(`${root}/`) || (await stat(path)).size > maxBytes) return undefined;
        return readFile(path);
      },
      async realpath(path) {
        return path.startsWith(`${root}/`) ? realpath(path) : undefined;
      },
    };
    const source: MemoryItemSource = {
      sessionId: "original-session",
      runId: "original-run",
      turnId: "turn",
      eventId: "native-failure",
    };
    const testPath = join(workspace, "workflow.test.mjs"),
      configPath = join(workspace, "ready.json");
    await writeFile(
      testPath,
      `
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
console.log('PASS');
console.log(JSON.stringify({ schema: 'pico.node-test.v1', kind: 'complete', valid: true }));
test('configured workflow', async (t) => {
  await t.test('has config', () => {
    assert.ok(existsSync('ready.json'));
    assert.equal(JSON.parse(readFileSync('ready.json', 'utf8')).ready, true);
  });
});
`,
    );
    const command = `${quote(process.execPath)} --test workflow.test.mjs`;
    const target = await evidence.resolveExecutionLearningTarget(command, workspace, io);
    assert.ok(target);
    assert.equal(target.kind, "node-test");
    const cdTarget = await evidence.resolveExecutionLearningTarget(
      `cd ${quote(workspace)} && ${command}`,
      root,
      io,
    );
    assert.equal(cdTarget?.scopeHash, target.scopeHash);
    for (const unsupported of [
      "node --test $TEST",
      "node --test workflow.test.mjs | cat",
      "node --test workflow.test.mjs > output",
      "cd workspace; node --test workflow.test.mjs",
      "cd workspace || node --test workflow.test.mjs",
      "node --test workflow.test.mjs && echo PASS",
      "node --test *.mjs",
      "npm test",
      "node -e 'console.log(1)'",
    ])
      assert.equal(
        await evidence.resolveExecutionLearningTarget(unsupported, root, io),
        undefined,
        unsupported,
      );
    const dispatch = async () => {
      const instrumented = await evidence.instrumentCommand(target, { reportDirectory: bundle });
      assert.ok(instrumented);
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      try {
        const process = await execute(instrumented.command, {
          cwd: workspace,
          env,
          maxBuffer: 1024 * 1024,
        });
        return {
          report: await evidence.readExecutionTestReport(instrumented.reportPath, io),
          stdout: process.stdout,
          exitCode: 0,
        };
      } catch (error) {
        const process = error as Error & { stdout: string; code: number };
        return {
          report: await evidence.readExecutionTestReport(instrumented.reportPath, io),
          stdout: process.stdout,
          exitCode: process.code,
        };
      }
    };
    const failure = await dispatch();
    assert.equal(failure.exitCode, 1);
    assert.equal(failure.report.complete, true);
    assert.equal(failure.report.success, false);
    assert.ok(failure.report.failed.length > 0);
    assert.ok(failure.stdout.includes("PASS"));
    assert.equal(evidence.parseExecutionTestReport(failure.stdout).complete, false);

    const content = '{"ready":true}\n';
    await writeFile(configPath, content);
    const dependencyManifest = join(workspace, "dependency.json"),
      dependencyEntry = join(workspace, "dependency.mjs");
    await writeFile(dependencyManifest, '{"name":"fixture-dependency","version":"1.0.0"}');
    await writeFile(dependencyEntry, "export const ready = true;\n");
    const commit = {
      path: configPath,
      beforeHash: null,
      afterHash: sha256(content),
      content,
      source: { ...source, eventId: "native-file-commit" },
    };
    const conditions = [
      ...evidence.conditionsFromFileCommit(commit),
      { kind: "json" as const, path: configPath, field: ["ready"], value: true },
      {
        kind: "node-package" as const,
        path: dependencyManifest,
        name: "fixture-dependency",
        version: "1.0.0",
        entryPath: dependencyEntry,
        entryHash: sha256("export const ready = true;\n"),
      },
    ];
    assert.equal(
      (await evidence.resolveExecutionLearningTarget(command, workspace, io))?.scopeHash,
      target.scopeHash,
    );
    assert.deepEqual(evidence.conditionsFromFileCommit({ ...commit, content: "fabricated" }), []);
    const before = await evidence.observeExecutionConditions(conditions, io);
    assert.equal(before.complete, true);
    assert.equal(before.matches, true);
    const claim: ExecutionAcceptanceClaim = {
      candidateId: "candidate",
      revision: 1,
      failureKey: "failure-key",
      predicateId: "test-target-pass.v1",
      admission: {
        admissionId: "admission",
        workspaceKey: "workspace",
        sessionId: source.sessionId,
        runId: source.runId,
        workDir: workspace,
        settingsVersion: 1,
        deletionRevision: 0,
        managementRevision: 0,
        inputEpoch: 0,
        createdAt: 1,
      },
      target,
      claimHash: "frozen-claim-hash",
      conditions,
      recipe: [{ kind: "file", ...commit }],
      failedTestIds: failure.report.failed,
      failure: source,
      createdAt: 2,
    };
    const ticket: ExecutionVerificationTicket = {
      ticketId: "ticket",
      candidateId: claim.candidateId,
      claimRevision: claim.revision,
      claimHash: claim.claimHash,
      admissionId: "new-admission",
      sessionId: "later-session",
      runId: "later-run",
      toolCallId: "native-verification",
      preparedEventId: "native-prepared-event",
      argumentsHash: "native-arguments-hash",
      inputEpoch: 3,
      before,
      createdAt: 3,
    };
    const success = await dispatch();
    const after = await evidence.observeExecutionConditions(conditions, io);
    const result: ExecutionVerificationResult = {
      ticketId: ticket.ticketId,
      source: {
        ...source,
        sessionId: ticket.sessionId,
        runId: ticket.runId,
        eventId: "native-success",
      },
      after,
      report: success.report,
      complete: true,
      exitCode: success.exitCode,
      settledAt: 4,
    };
    assert.equal(success.report.complete, true);
    assert.equal(success.report.success, true);
    assert.equal(evidence.evaluateAcceptance(claim, ticket, result).accepted, true);
    assert.equal(
      evidence.evaluateAcceptance(claim, ticket, { ...result, report: failure.report }).accepted,
      false,
    );
    assert.equal(
      evidence.evaluateAcceptance(claim, ticket, { ...result, complete: false, exitCode: null })
        .accepted,
      false,
    );
    assert.equal(
      evidence.evaluateAcceptance(claim, { ...ticket, claimHash: "stale" }, result).accepted,
      false,
    );
    assert.equal(
      evidence.evaluateAcceptance(claim, { ...ticket, createdAt: 1 }, result).accepted,
      false,
    );
    const lesson = evidence.renderAcceptedLesson(claim);
    assert.ok(lesson.includes("可复用内容"));
    assert.ok(lesson.includes("原失败测试全部通过"));
    assert.ok([...lesson].length <= 2000);

    await writeFile(configPath, '{"ready":false}\n');
    const drifted = await evidence.observeExecutionConditions(conditions, io);
    assert.equal(drifted.matches, false);
    assert.equal(
      evidence.evaluateAcceptance(claim, ticket, { ...result, after: drifted }).accepted,
      false,
    );
    assert.equal(
      (
        await evidence.observeExecutionConditions(conditions, {
          ...io,
          readFile: async () => undefined,
        })
      ).complete,
      false,
    );
    const oversized = join(workspace, "oversized.json");
    await writeFile(oversized, Buffer.alloc(evidence.EXECUTION_EVIDENCE_MAX_BYTES + 1));
    assert.equal(
      (
        await evidence.observeExecutionConditions(
          [{ kind: "file", path: oversized, hash: "too-large" }],
          io,
        )
      ).complete,
      false,
    );
    assert.equal(
      (
        await evidence.observeExecutionConditions(
          Array.from({ length: 9 }, (_, i) => ({
            kind: "file" as const,
            path: join(workspace, `${i}.json`),
            hash: "absent",
          })),
          io,
        )
      ).complete,
      false,
    );
    assert.equal(
      evidence.parseExecutionTestReport(
        '{"schema":"pico.node-test.v1","kind":"complete","valid":true}\n',
      ).complete,
      false,
    );
  },
);
