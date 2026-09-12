import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHookSnapshot } from "../../../src/hooks/config.js";

test("Hook 配置拒绝旧 settings wrapper，并加载 canonical .pico 格式", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-format-retirement-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workDir, ".pico", "hooks.json");
  await Promise.all([
    mkdir(join(workDir, ".pico"), { recursive: true }),
    mkdir(picoHome, { recursive: true }),
  ]);
  context.after(() => rm(root, { recursive: true, force: true }));

  const legacyBody = `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "false", timeout: 5_000 }] }],
      },
    },
    null,
    2,
  )}\n`;
  await writeFile(configPath, legacyBody);

  const rejected = await loadHookSnapshot({ workDir, picoHome });
  const rejectedProject = rejected.sources.find(({ source }) => source.kind === "project");
  assert.equal(rejected.hasErrors, true);
  assert.equal(rejectedProject?.status, "invalid");
  assert.match(rejectedProject?.error ?? "", /不支持的 Hook 事件: hooks/u);
  assert.equal(Object.values(rejected.snapshot.handlers).flat().length, 0);
  assert.equal(await readFile(configPath, "utf8"), legacyBody, "旧格式不得被静默重写");

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        PreToolUse: [
          {
            matcher: "read_file",
            hooks: [{ type: "prompt", prompt: "检查读取请求", timeout: 5 }],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const loaded = await loadHookSnapshot({ workDir, picoHome });
  const loadedProject = loaded.sources.find(({ source }) => source.kind === "project");
  const handlers = loaded.snapshot.handlers.PreToolUse;
  assert.equal(loaded.hasErrors, false);
  assert.equal(loadedProject?.status, "loaded");
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0]?.handler.type, "prompt");
  assert.equal(handlers[0]?.handler.timeout, 5);
  assert.equal(handlers[0]?.handler.timeoutMs, 5_000, "canonical timeout 单位必须是秒");
});
