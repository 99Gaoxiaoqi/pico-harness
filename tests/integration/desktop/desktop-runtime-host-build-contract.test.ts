import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

interface DesktopPackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const DESKTOP_BUILD_WORKSPACES = [
  "@pico/core",
  "@pico/storage",
  "@pico/runtime",
  "@pico/protocol",
  "@pico/transcript-replica",
  "@pico/runtime-host",
  "@pico/pico-host",
];
const DESKTOP_FORGE_RUNNER = "../../scripts/run-desktop-forge.mjs";

test("Desktop cold workflows build the complete dependency chain before invoking Forge", async (t) => {
  const [manifestSource, runnerSource] = await Promise.all([
    readFile(new URL("../../../apps/desktop/package.json", import.meta.url), "utf8"),
    readFile(new URL("../../../scripts/run-desktop-forge.mjs", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as DesktopPackageManifest;

  assert.equal(manifest.dependencies?.["@pico/runtime-host"], "*");
  for (const lifecycle of ["start", "package", "make"] as const) {
    assert.ok(
      manifest.scripts?.[lifecycle]?.includes(`${DESKTOP_FORGE_RUNNER} ${lifecycle}`),
      `${lifecycle} must delegate cold-start preparation to the Desktop Forge runner`,
    );
  }
  assert.deepEqual(
    manifest.scripts?.["pretypecheck"]?.split(" && "),
    DESKTOP_BUILD_WORKSPACES.map((workspace) => `npm run build --workspace ${workspace}`),
    "pretypecheck must prepare the complete Desktop dependency chain in order",
  );

  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-forge-build-contract-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = join(root, "scripts", "run-desktop-forge.mjs");
  const desktop = join(root, "apps", "desktop");
  const npmCli = join(root, "npm-cli.cjs");
  const forgeCli = join(
    root,
    "node_modules",
    "@electron-forge",
    "cli",
    "dist",
    "electron-forge.js",
  );
  const log = join(root, "calls.jsonl");
  await Promise.all([
    mkdir(dirname(runner), { recursive: true }),
    mkdir(desktop, { recursive: true }),
    mkdir(dirname(forgeCli), { recursive: true }),
  ]);
  await writeFile(runner, runnerSource);
  const recordCall = `
    require("node:fs").appendFileSync(process.env.PICO_FORGE_TEST_LOG,
      JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
  `;
  await writeFile(npmCli, recordCall);
  await writeFile(
    forgeCli,
    `${recordCall}
    if (process.argv[2] === "package") {
      const { mkdirSync, writeFileSync } = require("node:fs");
      const { dirname, join } = require("node:path");
      const target = join(process.cwd(), "out", "Pico-" + process.platform + "-" + process.arch);
      const executable = process.platform === "darwin"
        ? join(target, "Pico.app", "Contents", "MacOS", "Pico")
        : join(target, process.platform === "win32" ? "Pico.exe" : "Pico");
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, "fixture", { mode: 0o700 });
    }
  `,
  );

  for (const lifecycle of ["start", "package", "make"] as const) {
    await writeFile(log, "");
    const result = spawnSync(process.execPath, [runner, lifecycle, "--fixture-argument"], {
      cwd: desktop,
      env: { ...process.env, npm_execpath: npmCli, PICO_FORGE_TEST_LOG: log },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${lifecycle}: ${result.error ?? result.stderr}`);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    assert.deepEqual(
      calls,
      [
        ...DESKTOP_BUILD_WORKSPACES.map((workspace) => ({
          args: ["run", "build", "--workspace", workspace],
          cwd: root,
        })),
        { args: [lifecycle, "--fixture-argument"], cwd: desktop },
      ],
      `${lifecycle} must finish every workspace build in dependency order before invoking Forge`,
    );
  }
});
