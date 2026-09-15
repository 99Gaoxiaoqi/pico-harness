import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { load } from "js-yaml";

interface Workflow {
  readonly jobs: Readonly<Record<string, { readonly steps: readonly { readonly run?: string }[] }>>;
}

test("CI builds workspace packages after each install and before JavaScript tests", async () => {
  const [workflowSource, manifestSource] = await Promise.all([
    readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ]);
  const workflow = load(workflowSource) as Workflow;
  const { scripts } = JSON.parse(manifestSource) as { scripts: Record<string, string> };
  const buildsPackages = new Set([
    "build:packages",
    ...Object.keys(scripts).filter((name) =>
      scripts[`pre${name}`]?.split(" && ").includes("npm run build:packages"),
    ),
  ]);
  const testedJobs = new Set<string>();
  const failures: string[] = [];

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    let installed = false;
    let built = false;
    for (const step of job.steps) {
      // Scan whole jobs, including fresh npm ci installs inside container scripts.
      // npm script pre-hooks run before the test script, including on Windows.
      const commands = (step.run ?? "").matchAll(
        /(?:\bnpm|"\$npm_executable")\s+(ci\b|run\s+([\w:-]+))|--test(?=\s|$)/g,
      );
      for (const command of commands) {
        if (command[1] === "ci") {
          installed = true;
          built = false;
          continue;
        }
        const script = command[2];
        if (script && buildsPackages.has(script)) {
          if (!installed) failures.push(`${jobName}: ${command[0]} runs before npm ci`);
          built = installed;
        }
        if (command[0] === "--test" || script?.startsWith("test:")) {
          testedJobs.add(jobName);
          if (!built) {
            failures.push(`${jobName}: ${command[0]} runs before workspace packages are built`);
          }
        }
      }
    }
  }

  assert.deepEqual(
    [...testedJobs].sort(),
    [
      "test",
      "node-compatibility",
      "windows-security",
      "macos-process-sandbox",
      "linux-process-sandbox",
    ].sort(),
    "the contract must inspect every JavaScript test job",
  );
  assert.deepEqual(failures, []);
});
