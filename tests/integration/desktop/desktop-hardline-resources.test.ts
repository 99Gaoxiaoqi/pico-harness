import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { copyDesktopRuntimeResources } from "../../../apps/desktop/desktop-runtime-resources.js";
import forgeConfig from "../../../apps/desktop/forge.config.js";
import daemonConfig from "../../../apps/desktop/vite.daemon.config.js";
import mainConfig from "../../../apps/desktop/vite.main.config.js";

test("Hardline desktop CJS loader uses copied resources and rejects missing or corrupt grammar", async (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const assets = join(root, "packages/runtime/assets/bash");
  const manifest = JSON.parse(await readFile(join(assets, "manifest.json"), "utf8")) as {
    version: number;
    grammar: {
      version: string;
      abiVersion: number;
      file: string;
      sourceUrl: string;
      sha256: string;
    };
    runtime: { name: string; version: string };
  };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.grammar.version, "0.25.1");
  assert.equal(manifest.grammar.abiVersion, 15);
  assert.equal(
    manifest.grammar.sourceUrl,
    "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.1/tree-sitter-bash.wasm",
  );
  const grammar = await readFile(join(assets, manifest.grammar.file));
  const runtimePackage = JSON.parse(
    await readFile(join(root, "packages/runtime/package.json"), "utf8"),
  ) as { files: string[] };
  assert.ok(
    runtimePackage.files.includes("assets"),
    "npm runtime packages must include Bash assets",
  );
  assert.equal(
    createHash("sha256").update(grammar).digest("hex"),
    "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a",
  );
  assert.equal(
    manifest.grammar.sha256,
    "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a",
  );
  assert.match(
    await readFile(join(assets, "LICENSE"), "utf8"),
    /Copyright \(c\) 2017 Max Brunsfeld/,
  );
  const forgeGrammarResource = forgeConfig.packagerConfig.extraResource.find(
    (resource) => resolve(root, "apps/desktop", resource) === assets,
  );
  assert.ok(forgeGrammarResource, "Forge must copy the grammar directory into resources/bash");
  for (const config of [mainConfig, daemonConfig]) {
    const external = config.build?.rollupOptions?.external;
    assert.ok(Array.isArray(external) && external.includes("web-tree-sitter"));
    const output = config.build?.rollupOptions?.output;
    assert.ok(output && !Array.isArray(output));
    assert.equal(output.format, "cjs");
  }
  const daemonSource = await readFile(join(root, "apps/desktop/vite.daemon.config.ts"), "utf8");
  assert.match(daemonSource, /copyDesktopRuntimeResources\(import\.meta\.dirname\)/);

  const scratch = await mkdtemp(join(tmpdir(), "pico-hardline-resources-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const developmentRoot = join(scratch, "development/apps/desktop/.vite/build");
  // Exercise the production copy flow: the development grammar must be emitted
  // beside .vite/build rather than invented by the fixture.
  copyDesktopRuntimeResources(join(root, "apps/desktop"), developmentRoot);
  const copiedAssets = join(developmentRoot, "../assets/bash");
  for (const file of [manifest.grammar.file, "manifest.json", "LICENSE"]) {
    assert.deepEqual(await readFile(join(copiedAssets, file)), await readFile(join(assets, file)));
  }
  const require = createRequire(import.meta.url);
  const parserSource = await readFile(join(root, "packages/runtime/src/bash-parser.ts"), "utf8");
  for (const [name, config] of [
    ["main", mainConfig],
    ["daemon", daemonConfig],
  ] as const) {
    const output = config.build?.rollupOptions?.output;
    assert.ok(output && !Array.isArray(output) && typeof output.banner === "string");
    const moduleUrl = config.define?.["import.meta.url"];
    assert.equal(typeof moduleUrl, "string");
    const result = await transform(parserSource, {
      loader: "ts",
      format: "cjs",
      target: "node22",
      banner: output.banner,
      define: { "import.meta.url": moduleUrl as string },
    });
    await writeFile(join(developmentRoot, `${name}.cjs`), result.code);
  }
  const entryName = "check-resources.cjs";
  await writeFile(
    join(developmentRoot, entryName),
    `const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const loader = require("./" + process.argv[2] + ".cjs");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, "node_modules/web-tree-sitter/package.json"), "utf8"));
assert.equal(packageMetadata.version, ${JSON.stringify(manifest.runtime.version)});
(async () => {
  const initialization = loader.initializeBashParser();
  assert.equal(initialization, loader.initializeBashParser(), "initialization must be idempotent");
  if (process.argv[3]) {
    await assert.rejects(initialization, error => {
      assert.equal(error.name, "BashParserUnavailableError");
      assert.match(error.message, /shell_analysis:unavailable/);
      assert.ok(error.cause.message.includes(process.argv[3]), error.cause.message);
      return true;
    });
    assert.throws(() => loader.parseBashScript("echo safe", loader.createBashAnalysisBudget()), /shell_analysis:unavailable/);
    console.log("PASS: Hardline unavailable resources rejected");
    return;
  }
  await initialization;
  const parsed = loader.parseBashScript("rm -rf /tmp/pico-hardline-fixture", loader.createBashAnalysisBudget());
  assert.equal(parsed.ambiguous, false);
  assert.equal(parsed.commands[0][0].value, "rm");
  console.log("PASS: Hardline copied resources loaded");
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
  );
  const packagedResources = join(scratch, "packaged/resources");
  const packagedRoot = join(packagedResources, "app/.vite/build");
  await mkdir(packagedResources, { recursive: true });
  await cp(developmentRoot, packagedRoot, { recursive: true });
  // Apply Forge's declared extraResource mapping. Do not copy the development
  // fallback so this layout must load resources/bash.
  await cp(resolve(root, "apps/desktop", forgeGrammarResource), join(packagedResources, "bash"), {
    recursive: true,
  });
  const executables = [process.execPath, require("electron") as string];
  const run = (buildRoot: string, executable: string, name: string, failure?: string): string => {
    const result = spawnSync(
      executable,
      [join(buildRoot, entryName), name, ...(failure ? [failure] : [])],
      {
        encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 15_000,
      },
    );
    assert.equal(
      result.status,
      0,
      `${buildRoot}/${name} (${executable})\n${result.error ?? ""}\n${result.stderr}`,
    );
    return result.stdout;
  };
  const corruptGrammar = Buffer.from(grammar);
  corruptGrammar[corruptGrammar.length - 1] = corruptGrammar[corruptGrammar.length - 1]! ^ 0xff;
  for (const [buildRoot, grammarRoot] of [
    [developmentRoot, copiedAssets],
    [packagedRoot, join(packagedResources, "bash")],
  ] as const) {
    for (const executable of executables) {
      for (const name of ["main", "daemon"]) {
        assert.match(run(buildRoot, executable, name), /PASS: Hardline copied resources loaded/);
      }
    }
    const copiedGrammar = join(grammarRoot, manifest.grammar.file);
    await writeFile(copiedGrammar, corruptGrammar);
    for (const executable of executables) {
      for (const name of ["main", "daemon"]) {
        assert.match(
          run(buildRoot, executable, name, "failed integrity verification"),
          /PASS: Hardline unavailable resources rejected/,
        );
      }
    }
    await rm(copiedGrammar);
    for (const executable of executables) {
      for (const name of ["main", "daemon"]) {
        assert.match(
          run(buildRoot, executable, name, "resource is missing"),
          /PASS: Hardline unavailable resources rejected/,
        );
      }
    }
  }
});
