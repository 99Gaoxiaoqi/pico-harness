import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const checker = resolve(import.meta.dirname, "../../../scripts/check-dependency-audit.mjs");
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
type Advisory = {
  source: number;
  name: string;
  dependency: string;
  url: string;
  severity: "high";
  range: string;
};
type Vulnerability = {
  name: string;
  severity: "high";
  nodes: string[];
  via: Array<string | Advisory>;
};

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-audit-gate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const specs = [
    { package: "braces", version: "3.0.3", source: 1240992, advisory: "GHSA-vfj7-8cjw-p6xm" },
    { package: "node-forge", version: "1.4.0", source: 1240912, advisory: "GHSA-86w9-cpqp-85rv" },
  ];
  const packages: Record<string, { version: string; integrity: string }> = {};
  const vulnerabilities: Record<string, Vulnerability> = {};
  const exceptions = [];
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "patches"));
  for (const spec of specs) {
    const nodePath = "node_modules/" + spec.package;
    const source = "module.exports = 'verified patch';\n";
    const patch =
      "diff --git a/" +
      nodePath +
      "/lib/source.js b/" +
      nodePath +
      "/lib/source.js\n" +
      "--- a/" +
      nodePath +
      "/lib/source.js\n" +
      "+++ b/" +
      nodePath +
      "/lib/source.js\n" +
      "@@ -1 +1 @@\n-module.exports = 'original';\n+" +
      source;
    const integrity = "sha512-fixture-" + spec.package;
    const patchPath = "patches/" + spec.package + "+" + spec.version + ".patch";
    await mkdir(join(root, nodePath, "lib"), { recursive: true });
    await writeFile(
      join(root, nodePath, "package.json"),
      JSON.stringify({
        name: spec.package,
        version: spec.version,
      }),
    );
    await writeFile(join(root, nodePath, "lib/source.js"), source);
    await writeFile(join(root, patchPath), patch);
    packages[nodePath] = { version: spec.version, integrity };
    exceptions.push({
      ...spec,
      advisoryRange: "<=" + spec.version,
      installedPaths: [nodePath],
      integrity,
      patch: patchPath,
      patchSha256: sha256(patch),
      repairedFiles: [{ path: "lib/source.js", sha256: sha256(source) }],
      owner: "Pico maintainers",
      reason: "Integration fixture for a verified local patch",
      upstream: "https://github.com/advisories/" + spec.advisory,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    vulnerabilities[spec.package] = {
      name: spec.package,
      severity: "high",
      nodes: [nodePath],
      via: [
        {
          source: spec.source,
          name: spec.package,
          dependency: spec.package,
          url: "https://github.com/advisories/" + spec.advisory,
          severity: "high",
          range: "<=" + spec.version,
        },
      ],
    };
  }
  vulnerabilities["react-native"] = {
    name: "react-native",
    severity: "high",
    nodes: ["node_modules/react-native"],
    via: ["@react-native/virtualized-lists", "braces"],
  };
  vulnerabilities["@react-native/virtualized-lists"] = {
    name: "@react-native/virtualized-lists",
    severity: "high",
    nodes: ["node_modules/@react-native/virtualized-lists"],
    via: ["react-native", "node-forge"],
  };
  const policy = { version: 1, exceptions };
  const npmCli = join(root, "npm-fixture.mjs");
  await writeFile(
    npmCli,
    [
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'assert.deepEqual(process.argv.slice(2), ["audit", "--json", "--audit-level=low"]);',
      'process.stdout.write(readFileSync("audit-input.json", "utf8"));',
      "process.exit(1);",
    ].join("\n"),
  );
  const writeInputs = async (raw?: string) => {
    await writeFile(join(root, "scripts/dependency-audit-exceptions.json"), JSON.stringify(policy));
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    const count = Object.keys(vulnerabilities).length;
    const report = {
      auditReportVersion: 2,
      vulnerabilities,
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: count,
          critical: 0,
          total: count,
        },
      },
    };
    await writeFile(join(root, "audit-input.json"), raw ?? JSON.stringify(report));
  };
  const run = () =>
    execute(process.execPath, [checker], {
      cwd: root,
      env: { ...process.env, npm_execpath: npmCli },
      encoding: "utf8",
      timeout: 10_000,
    });
  return { root, policy, packages, vulnerabilities, writeInputs, run };
}

test("audit CLI retains the raw full-tree report and resolves patched advisories through cycles", async (t) => {
  const f = await fixture(t);
  await f.writeInputs();
  const { stdout } = await f.run();
  assert.match(stdout, /passed: 2 verified temporary patch exceptions/);
  assert.equal(
    await readFile(join(f.root, "output/security/dependency-audit.json"), "utf8"),
    await readFile(join(f.root, "audit-input.json"), "utf8"),
  );
});

test("audit CLI fails closed on new findings, ineffective patches and invalid audit responses", async (t) => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const scenarios: Array<{ name: string; change(f: Fixture): Promise<string | undefined> }> = [
    {
      name: "new advisory inside an otherwise excepted dependency cycle",
      async change(f) {
        f.vulnerabilities["react-native"]!.via.push({
          source: 9999999,
          name: "react-native",
          dependency: "react-native",
          url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
          severity: "high",
          range: "*",
        });
        return undefined;
      },
    },
    {
      name: "installation path drift",
      async change(f) {
        f.vulnerabilities.braces!.nodes = ["node_modules/other/node_modules/braces"];
        return undefined;
      },
    },
    {
      name: "missing patch",
      async change(f) {
        await unlink(join(f.root, "patches/braces+3.0.3.patch"));
        return undefined;
      },
    },
    {
      name: "patch exists but install scripts did not apply it",
      async change(f) {
        await writeFile(join(f.root, "node_modules/braces/lib/source.js"), "original source\n");
        return undefined;
      },
    },
    {
      name: "lock integrity drift",
      async change(f) {
        f.packages["node_modules/braces"]!.integrity = "sha512-other";
        return undefined;
      },
    },
    {
      name: "expired exception",
      async change(f) {
        f.policy.exceptions[0]!.expiresAt = new Date(Date.now() - 1_000).toISOString();
        return undefined;
      },
    },
    {
      name: "patched files omitted from installed verification",
      async change(f) {
        f.policy.exceptions[0]!.repairedFiles = [];
        return undefined;
      },
    },
    {
      name: "unknown dependency reference",
      async change(f) {
        f.vulnerabilities["react-native"]!.via.push("missing-package");
        return undefined;
      },
    },
    {
      name: "cycle without any resolved advisory",
      async change(f) {
        f.vulnerabilities["react-native"]!.via = ["@react-native/virtualized-lists"];
        f.vulnerabilities["@react-native/virtualized-lists"]!.via = ["react-native"];
        return undefined;
      },
    },
    {
      name: "network error",
      async change() {
        return JSON.stringify({ error: { code: "ENOTFOUND", summary: "registry unavailable" } });
      },
    },
    {
      name: "malformed JSON",
      async change() {
        return "not valid audit JSON\n";
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (context) => {
      const f = await fixture(context);
      await f.writeInputs(await scenario.change(f));
      await assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error && typeof error === "object" && "stderr" in error);
        assert.match(String(error.stderr), /\[dependency-audit\]/);
        return true;
      });
      assert.equal(
        await readFile(join(f.root, "output/security/dependency-audit.json"), "utf8"),
        await readFile(join(f.root, "audit-input.json"), "utf8"),
      );
    });
  }
});
