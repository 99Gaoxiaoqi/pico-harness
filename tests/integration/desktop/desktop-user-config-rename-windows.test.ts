import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";

test(
  "Windows user config replacement waits for a reader without delete sharing",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-user-config-rename-"));
    const store = new UserConfigStore({ picoHome: root });
    let holder: ChildProcess | undefined;
    try {
      const initial = await store.read();
      const current = await store.write(
        { version: 1, providers: {}, defaults: { permissionMode: "ask" } },
        { expectedRevision: initial.revision },
      );
      const script = [
        "$stream = [System.IO.File]::Open($env:PICO_TEST_CONFIG_PATH,",
        "  [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,",
        "  [System.IO.FileShare]::ReadWrite)",
        "try { [Console]::Out.WriteLine('READY'); [Console]::In.ReadLine() | Out-Null }",
        "finally { $stream.Dispose() }",
      ].join("\n");
      holder = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: { ...process.env, PICO_TEST_CONFIG_PATH: store.filePath },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      holder.stdin?.on("error", () => undefined);
      const ready = await Promise.race([
        once(holder.stdout!, "data").then(([chunk]) => String(chunk)),
        once(holder, "exit").then(([code]) => {
          throw new Error(`file holder exited before READY (${String(code)})`);
        }),
        delay(5_000, undefined, { ref: false }).then(() => {
          throw new Error("file holder did not become ready");
        }),
      ]);
      assert.match(ready, /READY/u);

      const write = store.write(
        { version: 1, providers: {}, defaults: { permissionMode: "auto" } },
        { expectedRevision: current.revision },
      );
      const early = await Promise.race([
        write.then(
          () => "settled",
          () => "settled",
        ),
        delay(200).then(() => "pending"),
      ]);
      assert.equal(early, "pending", "the held destination must block the first replacement");
      holder.stdin?.end("\n");
      const written = await write;
      assert.equal(written.config.defaults?.permissionMode, "auto");
      assert.deepEqual(
        (await readdir(root)).filter((name) => /^\.config\.json\..+\.tmp$/u.test(name)),
        [],
      );
    } finally {
      holder?.stdin?.end("\n");
      if (holder && holder.exitCode === null) {
        await Promise.race([once(holder, "exit"), delay(5_000, undefined, { ref: false })]);
        if (holder.exitCode === null) holder.kill();
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
