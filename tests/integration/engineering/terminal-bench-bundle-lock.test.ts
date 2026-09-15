import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark bundler is intentionally plain Node ESM.
import * as bundleBuilder from "../../../scripts/terminal-bench/build-bundle.mjs";

const { copyBundleRootResources, createBundlePackagePlan } = bundleBuilder;

test("Terminal-Bench approved bundle lock matches runtime dependencies", async () => {
  const lockRaw = await readFile("benchmarks/terminal_bench_2_1/bundle-package-lock.json", "utf8");
  const approvedSha256 = (
    await readFile("benchmarks/terminal_bench_2_1/bundle-lock-sha256.txt", "utf8")
  ).trim();
  assert.equal(createHash("sha256").update(lockRaw).digest("hex"), approvedSha256);

  const lock = JSON.parse(lockRaw);
  assert.equal(lock.lockfileVersion, 3);
  const { packageJson, localPackages } = await createBundlePackagePlan();
  assert.deepEqual(lock.packages[""].dependencies, packageJson.dependencies);
  assert.ok(localPackages.length >= 8, "all eight runtime workspace packages must be bundled");
  for (const local of localPackages) {
    const name = local.packageJson.name;
    assert.equal(packageJson.dependencies[name], `file:${local.path}`);
    assert.equal(lock.packages[`node_modules/${name}`].resolved, local.path);
    assert.equal(lock.packages[`node_modules/${name}`].link, true);
    assert.equal(lock.packages[local.path].version, local.packageJson.version);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      assert.deepEqual(
        lock.packages[local.path][field],
        local.packageJson[field],
        `${name} ${field}`,
      );
    }
    assert.ok(local.artifacts.includes("dist"));
    assert.equal(local.packageJson.scripts, undefined);
    assert.equal(local.packageJson.devDependencies, undefined);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.includes("node_modules/@pico/")) {
      assert.equal(
        (entry as { link?: boolean }).link,
        true,
        `${path} must never resolve via registry`,
      );
    }
  }
});

test("Terminal-Bench extracted root resources satisfy Host sandbox lookup and reject altered digests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-bundle-sandbox-resources-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixtureResources = join(root, "fixture-resources");
  await cp("resources", fixtureResources, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(fixtureResources, "sandbox/manifest.json"), "utf8"),
  );
  const executables = [
    ...manifest.linux.architectures.map((arch: string) => `sandbox/linux-${arch}/bwrap`),
    ...manifest.windows.architectures.flatMap((arch: string) => [
      `sandbox/win32-${arch}/${manifest.windows.broker}`,
      `sandbox/win32-${arch}/${manifest.windows.hostPrep}`,
    ]),
  ];
  // Deterministic fixture bytes exercise publication and verification, never native execution.
  for (const relative of executables) {
    const executable = join(fixtureResources, relative);
    const bytes = Buffer.from(`sandbox publication fixture: ${relative}\n`);
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, bytes, { mode: 0o755 });
    await writeFile(
      `${executable}.sha256`,
      `${createHash("sha256").update(bytes).digest("hex")}\n`,
    );
  }
  const stage = join(root, "stage");
  await mkdir(stage);
  await copyBundleRootResources(stage, fixtureResources);
  const hostPath = join(stage, "node_modules/@pico/pico-host");
  await mkdir(join(hostPath, "dist"), { recursive: true });
  await cp("packages/pico-host/dist/process-sandbox", join(hostPath, "dist/process-sandbox"), {
    recursive: true,
  });
  await cp("packages/pico-host/package.json", join(hostPath, "package.json"));
  const archive = join(root, "fixture.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { readFileSync, writeFileSync } from "node:fs";
    import { join, resolve } from "node:path";
    import { detectSandboxBackend, resolveBundledSandboxExecutable, isVerifiedBundledExecutable } from "@pico/pico-host/process-sandbox/backend";
    const manifest = JSON.parse(readFileSync("resources/sandbox/manifest.json", "utf8"));
    assert.equal(manifest.version, 1);
    for (const [platform, arches, name, kind] of [
      ["linux", manifest.linux.architectures, "bwrap", "linux-bubblewrap"],
      ["win32", manifest.windows.architectures, manifest.windows.broker, "windows-appcontainer"],
    ]) {
      for (const arch of arches) {
        const executable = resolveBundledSandboxExecutable(platform, arch);
        assert.equal(executable, resolve("resources/sandbox", platform + "-" + arch, name));
        assert.ok(isVerifiedBundledExecutable(executable, platform));
        assert.equal(detectSandboxBackend(platform, arch), kind);
        if (platform === "win32") {
          const prep = join("resources/sandbox", platform + "-" + arch, manifest.windows.hostPrep);
          assert.equal(createHash("sha256").update(readFileSync(prep)).digest("hex"), readFileSync(prep + ".sha256", "utf8").trim());
        }
        writeFileSync(executable, "tampered");
        assert.equal(isVerifiedBundledExecutable(executable, platform), false);
        assert.equal(detectSandboxBackend(platform, arch), "unavailable");
      }
    }
    assert.ok(readFileSync("resources/licenses/THIRD_PARTY_NOTICES.md", "utf8").length > 0);
    console.log("extracted Linux/Windows resources and digests verified");
  `,
    ],
    { cwd: extracted, encoding: "utf8" },
  );
  assert.match(result, /resources and digests verified/u);
  assert.equal(
    await readFile(join(extracted, "resources/licenses/THIRD_PARTY_NOTICES.md"), "utf8"),
    await readFile(resolve("resources/licenses/THIRD_PARTY_NOTICES.md"), "utf8"),
  );
});
