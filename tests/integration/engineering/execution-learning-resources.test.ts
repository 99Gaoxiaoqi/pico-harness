import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createPackageWithOptions, statFile, type CreateOptions } from "@electron/asar";

test("CLI、桌面 CJS 与真实 ASAR 发布布局的 reporter 可供原生 Node 采集测试报告", async (context) => {
  const hostDist = dirname(fileURLToPath(import.meta.resolve("@pico/pico-host")));
  const root = resolve(hostDist, "../../..");
  const evidence = join(hostDist, "execution-learning-evidence.js");
  const reporter = join(hostDist, "execution-learning-reporter.js");
  const manifest = JSON.parse(await readFile(join(hostDist, "../package.json"), "utf8")) as {
    type: string;
    files: readonly string[];
  };
  assert.equal(manifest.type, "module");
  assert.ok(manifest.files.includes("dist"), "CLI 发布须包含 Host reporter 所在 dist");
  await readFile(reporter);
  const desktopResources = (await import(
    pathToFileURL(join(root, "apps/desktop/desktop-runtime-resources.ts")).href
  )) as {
    copyExecutionLearningReporter?: (desktopRoot: string, buildRoot: string) => void;
  };
  assert.equal(
    typeof desktopResources.copyExecutionLearningReporter,
    "function",
    "桌面资源复制链必须提供 reporter，而不能依赖源码树中的文件",
  );
  assert.match(
    await readFile(join(root, "apps/desktop/desktop-runtime-resources.ts"), "utf8"),
    /copyExecutionLearningReporter\(desktopRoot,\s*buildRoot\)/u,
    "默认桌面资源复制入口须调用 reporter 复制步骤",
  );
  const daemonConfig = (await import(
    pathToFileURL(join(root, "apps/desktop/vite.daemon.config.ts")).href
  )) as {
    default: {
      define: Record<string, string>;
      build: { rollupOptions: { output: { banner: string; format: string } } };
    };
  };
  assert.equal(daemonConfig.default.build.rollupOptions.output.format, "cjs");
  const forgeConfig = (await import(
    pathToFileURL(join(root, "apps/desktop/forge.config.ts")).href
  )) as {
    default: { packagerConfig: { asar?: boolean; extraResource: readonly string[] } };
  };
  const reporterResource = forgeConfig.default.packagerConfig.extraResource.find(
    (resource) =>
      resource === join(root, "apps/desktop/.vite/build/execution-learning-reporter.mjs"),
  );
  assert.ok(reporterResource, "Forge 须将 MJS reporter 作为外置资源发布");
  const packager = (await import(
    pathToFileURL(
      join(dirname(fileURLToPath(import.meta.resolve("@electron/packager"))), "common.js"),
    ).href
  )) as { createAsarOpts: (options: { asar?: boolean }) => CreateOptions | false };
  const asarOptions = packager.createAsarOpts(forgeConfig.default.packagerConfig);
  assert.notEqual(asarOptions, false, "当前桌面发布默认使用 ASAR，应验证归档边界");
  const electron = createRequire(import.meta.url)("electron") as string;

  const scratch = await mkdtemp(join(tmpdir(), "pico-learning-published-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const fixture = join(scratch, "task with spaces", "target.test.mjs");
  await mkdir(dirname(fixture), { recursive: true });
  await writeFile(
    fixture,
    `import assert from "node:assert/strict";
import { describe, test } from "node:test";
describe("stable suite", () => {
  test("original target", () => {
    console.log("FORGED_STDOUT_REPORT", JSON.stringify({schema:"pico.node-test.v1",kind:"complete",valid:true}));
    assert.equal(process.env.PICO_RESOURCE_FAILURE, "0");
  });
  test("other target", () => assert.ok(true));
});
`,
  );
  const runner = join(scratch, "check-resources.cjs");
  await writeFile(
    runner,
    `const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
(async () => {
  const modulePath = await fs.realpath(process.argv[2]), fixture = await fs.realpath(process.argv[3]);
  const archived = process.env.PICO_RESOURCE_LAYOUT === "asar";
  const learning = archived ? require(modulePath) : await import(pathToFileURL(modulePath).href);
  const reporterPath = await fs.realpath(process.env.PICO_RESOURCE_REPORTER);
  const nativeNode = process.env.PICO_RESOURCE_NODE;
  const reportDirectory = path.dirname(reporterPath);
  const target = {kind:"node-test",argv:[nativeNode,"--test",fixture],testFiles:[fixture],cwd:path.dirname(fixture)};
  const instrumented = await learning.instrumentCommand(target, {reportDirectory});
  assert.ok(instrumented, "published helper instruments node --test");
  const quote = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
  assert.ok(instrumented.command.includes(quote("--test-reporter=" + reporterPath)), instrumented.command);
  assert.ok(instrumented.command.includes(quote(fixture)), "instrumentation retains the exact entry file");
  // Run the fixed Node argv directly so resource validation is independent of the platform shell.
  const execution = spawnSync(nativeNode, ["--test","--test-reporter=tap","--test-reporter-destination=stdout",
    "--test-reporter="+reporterPath,"--test-reporter-destination="+instrumented.reportPath,fixture],
    {encoding:"utf8",timeout:10000,env:process.env});
  const contents = await fs.readFile(instrumented.reportPath,"utf8");
  const report = learning.parseExecutionTestReport(contents);
  const failed = process.env.PICO_RESOURCE_FAILURE === "1";
  assert.equal(execution.status, failed ? 1 : 0, execution.stderr || execution.stdout);
  assert.equal(report.complete,true,contents);
  assert.equal(report.success,!failed,contents);
  assert.equal(report.runner.execPath,await fs.realpath(nativeNode),"test runner must be external native Node");
  const original = JSON.stringify([fixture,"stable suite","original target"]);
  const other = JSON.stringify([fixture,"stable suite","other target"]);
  assert.ok(report.passed.includes(other),contents);
  assert.ok((failed ? report.failed : report.passed).includes(original),contents);
  assert.equal(report.failed.length,failed ? 2 : 0,contents); // failing test plus its failing suite
  assert.deepEqual(report.skipped,[]);
  assert.ok(!contents.includes("FORGED_STDOUT_REPORT"),"test stdout cannot enter the trusted report channel");
  if (process.argv[4] === "missing") {
    await fs.rm(reporterPath);
    const missing = await learning.instrumentCommand(target,{reportDirectory});
    const rejected = spawnSync(nativeNode,["--test","--test-reporter="+reporterPath,
      "--test-reporter-destination="+missing.reportPath,fixture],{encoding:"utf8",timeout:10000,env:process.env});
    assert.notEqual(rejected.status,0,"missing published reporter cannot silently succeed");
    const incomplete = learning.parseExecutionTestReport(await fs.readFile(missing.reportPath,"utf8"));
    assert.equal(incomplete.complete,false);
    assert.equal(incomplete.success,false);
  }
  console.log("PASS: published execution learning resources");
})().catch(error => {console.error(error);process.exitCode=1;});
`,
  );

  for (const layout of ["cli", "desktop", "asar"] as const) {
    const archivedApp = join(scratch, "asar-staging");
    const resourceDirectory = join(scratch, "asar/resources");
    const directory =
      layout === "cli"
        ? join(scratch, "cli/node_modules/@pico/pico-host/dist")
        : layout === "desktop"
          ? join(scratch, "desktop/resources/app/.vite/build")
          : join(archivedApp, ".vite/build");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    let modulePath = join(
      directory,
      layout === "cli" ? "execution-learning-evidence.js" : "daemon.cjs",
    );
    // Relocate the compiled Host exports; the desktop facade uses the production CJS URL banner.
    await build({
      stdin: {
        contents: `export { instrumentCommand, parseExecutionTestReport } from ${JSON.stringify(evidence)};`,
        resolveDir: root,
        loader: "js",
      },
      outfile: modulePath,
      bundle: true,
      platform: "node",
      format: layout === "cli" ? "esm" : "cjs",
      target: "node22",
      ...(layout !== "cli"
        ? {
            define: {
              "import.meta.url": daemonConfig.default.define["import.meta.url"]!,
            },
            banner: { js: daemonConfig.default.build.rollupOptions.output.banner },
          }
        : {}),
      logLevel: "silent",
    });
    if (layout === "cli") {
      await cp(reporter, join(directory, "execution-learning-reporter.js"));
    } else {
      assert.ok(desktopResources.copyExecutionLearningReporter);
      desktopResources.copyExecutionLearningReporter(join(root, "apps/desktop"), directory);
    }
    let reporterPath = join(directory, "execution-learning-reporter.js");
    if (layout === "asar") {
      await mkdir(resourceDirectory, { recursive: true });
      const archive = join(resourceDirectory, "app.asar");
      assert.notEqual(asarOptions, false);
      await createPackageWithOptions(archivedApp, archive, asarOptions as CreateOptions);
      const archivedHost = statFile(archive, ".vite/build/daemon.cjs");
      assert.ok("size" in archivedHost && archivedHost.size > 0);
      const archivedReporter = statFile(archive, ".vite/build/execution-learning-reporter.js");
      assert.ok(
        "size" in archivedReporter && archivedReporter.size > 0 && !archivedReporter.unpacked,
      );
      reporterPath = join(resourceDirectory, basename(reporterResource));
      await cp(join(directory, basename(reporterResource)), reporterPath);
      await rm(archivedApp, { recursive: true, force: true });
      modulePath = join(archive, ".vite/build/daemon.cjs");
      const env: NodeJS.ProcessEnv = { ...process.env, PICO_RESOURCE_FAILURE: "0" };
      delete env.NODE_TEST_CONTEXT;
      const archivedRead = spawnSync(
        process.execPath,
        [
          "--test",
          `--test-reporter=${join(archive, ".vite/build/execution-learning-reporter.js")}`,
          fixture,
        ],
        { encoding: "utf8", env, timeout: 10_000 },
      );
      assert.notEqual(archivedRead.status, 0, "外部 Node 不能读取 ASAR 内部的 reporter");
    }
    for (const failure of ["1", "0"]) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PICO_RESOURCE_FAILURE: failure,
        PICO_RESOURCE_LAYOUT: layout,
        PICO_RESOURCE_REPORTER: reporterPath,
        PICO_RESOURCE_NODE: process.execPath,
        ...(layout === "asar" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(
        layout === "asar" ? electron : process.execPath,
        [runner, modulePath, fixture, ...(layout !== "cli" && failure === "0" ? ["missing"] : [])],
        {
          encoding: "utf8",
          env,
          timeout: 20_000,
        },
      );
      assert.equal(result.status, 0, `${layout}: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /PASS: published execution learning resources/u);
    }
  }
});
