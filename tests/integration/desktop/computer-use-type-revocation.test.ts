import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test(
  "computer.type stops sending text when task authority is revoked during input",
  { skip: process.platform !== "darwin" },
  () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const script = String.raw`
      import assert from "node:assert/strict";
      import { mock } from "node:test";
      import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";

      mock.module("electron", {
        namedExports: {
          app: {}, desktopCapturer: {}, powerMonitor: {}, screen: {}, systemPreferences: {},
        },
      });
      const { ComputerUseExecutor } = await import("./apps/desktop/src/main/computer-use-executor.ts");
      const executor = new ComputerUseExecutor();
      const element = {
        index: 0, role: "AXTextField", title: "Name", description: "",
        x: 10, y: 10, width: 100, height: 24,
      };
      executor.observations.set("session", {
        id: "observation", at: Date.now(), pid: 42, elements: [element],
      });
      executor.checkSystemGates = () => {};
      const sent = [];
      let revoked = false;
      executor.native = async (input) => {
        if (input.action === "observe") return { frontmostPid: 42, elements: [element] };
        if (input.action === "status") return { frontmostPid: 42 };
        if (input.action === "type") {
          sent.push(input.text);
          revoked = true;
        }
        return { ok: true };
      };
      await assert.rejects(
        executor.execute({
          commandId: "command", sessionId: "session", action: "computer.type",
          input: { observationId: "observation", elementIndex: 0, text: "x".repeat(300) },
          createdAt: Date.now(), expiresAt: Date.now() + 20_000,
        }, async () => {
          if (revoked) throw new Error("task authority revoked");
        }),
        /task authority revoked/u,
      );
      assert.equal(sent.length, 1);
      assert.ok(sent[0].length <= 128, "one helper call must not receive the whole payload");
      assert.equal(executor.observations.has("session"), false);

      const root = mkdtempSync(join(tmpdir(), "pico-computer-abort-"));
      try {
        const fakeHelper = join(root, "helper");
        writeFileSync(fakeHelper, "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write('done'), 1000);\n");
        chmodSync(fakeHelper, 0o755);
        const inFlight = new ComputerUseExecutor();
        inFlight.verifiedExecutable = async () => fakeHelper;
        const controller = new AbortController();
        const pending = inFlight.native({ action: "type", text: "x", expectedPid: 42 }, controller.signal);
        setTimeout(() => controller.abort(new Error("task authority revoked")), 30);
        await assert.rejects(pending, /电脑输入授权已撤销/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", script],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  },
);
