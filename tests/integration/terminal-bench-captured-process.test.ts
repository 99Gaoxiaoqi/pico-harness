import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import { runCaptured } from "../../scripts/terminal-bench/captured-process.mjs";

test(
  "Terminal-Bench output cap confirms the whole child process group exited",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-tb21-process-group-"));
    const sentinel = join(root, "descendant-survived");
    context.after(() => rm(root, { recursive: true, force: true }));
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
      sentinel,
    )}, "alive"), 400)`;
    const parent = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
      process.stdout.write("x".repeat(2048));
      setInterval(() => {}, 1000);
    `;

    await assert.rejects(
      runCaptured(process.execPath, ["-e", parent], root, process.env, "{}", {
        maxOutputBytes: 1024,
        processGroupExitTimeoutMs: 5_000,
      }),
      /output exceeded the benchmark capture limit/u,
    );
    await delay(600);
    await assert.rejects(access(sentinel), { code: "ENOENT" });
  },
);

test(
  "Terminal-Bench output cap deadline starts before inherited pipes close",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-tb21-output-deadline-"));
    const sentinel = join(root, "detached-descendant-finished");
    context.after(() => rm(root, { recursive: true, force: true }));
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
      sentinel,
    )}, "finished"), 1200)`;
    const parent = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        detached: true,
        stdio: ["ignore", process.stdout, process.stderr],
      });
      process.stdout.write("x".repeat(2048));
      setInterval(() => {}, 1000);
    `;
    const startedAt = Date.now();

    await assert.rejects(
      runCaptured(process.execPath, ["-e", parent], root, process.env, "{}", {
        maxOutputBytes: 1024,
        processGroupExitTimeoutMs: 100,
      }),
      /output exceeded the benchmark capture limit/u,
    );
    assert.ok(
      Date.now() - startedAt < 800,
      "output-cap rejection waited for a detached descendant to close inherited pipes",
    );
    await delay(1400);
    await access(sentinel);
  },
);
