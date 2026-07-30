import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { allowlistedHostEnv } from "./host-secret-boundary.mjs";
import { assertTaskComposePolicy } from "./container-policy.mjs";

const secretEnv = "PICO_TB_PROVIDER_API_KEY";
const secret = `PICO_TB_FD_BOUNDARY_${process.pid}_${Date.now()}`;
const root = await mkdtemp(join(tmpdir(), "pico-tb-fd-boundary-"));
const project = `pico-tb-fd-boundary-${process.pid}`;
const composePath = join(root, "compose.yaml");
process.env[secretEnv] = secret;

try {
  await writeFile(
    composePath,
    [
      "services:",
      "  malicious-task:",
      "    image: node:22-bookworm",
      "    pull_policy: never",
      "    network_mode: none",
      "    environment:",
      `      LEAK_PROBE: \${${secretEnv}:-ABSENT}`,
      "    command:",
      "      - node",
      "      - -e",
      "      - process.stdout.write(process.env.LEAK_PROBE)",
      "",
    ].join("\n"),
  );
  const policyTaskRoot = join(root, "policy-task");
  await mkdir(join(policyTaskRoot, "environment"), { recursive: true });
  await writeFile(
    join(policyTaskRoot, "environment", "compose.yaml"),
    ["services:", "  main:", "    image: node:22-bookworm", "    privileged: true", ""].join("\n"),
  );
  await assert.rejects(
    assertTaskComposePolicy(policyTaskRoot, allowlistedHostEnv(process.env)),
    /violates host isolation/u,
  );
  const mountTaskRoot = join(root, "mount-policy-task");
  await mkdir(join(mountTaskRoot, "environment", "payload"), { recursive: true });
  await writeFile(
    join(mountTaskRoot, "environment", "compose.yaml"),
    [
      "services:",
      "  main:",
      "    image: node:22-bookworm",
      "    volumes:",
      "      - ./payload:/installed-agent/pico-node",
      "",
    ].join("\n"),
  );
  await assert.rejects(
    assertTaskComposePolicy(mountTaskRoot, allowlistedHostEnv(process.env)),
    /exposes Docker control/u,
  );
  const fifoTaskRoot = join(root, "fifo-policy-task");
  await mkdir(join(fifoTaskRoot, "environment"), { recursive: true });
  await run("mkfifo", [join(fifoTaskRoot, "environment", "control")], process.env);
  await writeFile(
    join(fifoTaskRoot, "environment", "compose.yaml"),
    [
      "services:",
      "  main:",
      "    image: node:22-bookworm",
      "    volumes:",
      "      - ./control:/workspace/control",
      "",
    ].join("\n"),
  );
  await assert.rejects(
    assertTaskComposePolicy(fifoTaskRoot, allowlistedHostEnv(process.env)),
    /unsafe type/u,
  );
  const childEnv = allowlistedHostEnv(process.env);
  const childScript = [
    "import os, subprocess, sys",
    `secret = os.read(3, 65536).decode()`,
    "os.close(3)",
    `assert secret == ${JSON.stringify(secret)}`,
    `assert ${JSON.stringify(secretEnv)} not in os.environ`,
    "result = subprocess.run(sys.argv[1:], check=True, capture_output=True, text=True)",
    "assert result.stdout == 'ABSENT'",
  ].join("; ");
  await run(
    "python3",
    [
      "-c",
      childScript,
      "docker",
      "compose",
      "--project-name",
      project,
      "-f",
      composePath,
      "run",
      "--rm",
      "--no-deps",
      "malicious-task",
    ],
    childEnv,
    secret,
  );
  await run(
    "python3",
    [join(import.meta.dirname, "check-gateway-supervisor-security.py")],
    childEnv,
  );
  await run("python3", [join(import.meta.dirname, "check-trial-network-lifecycle.py")], childEnv);
  await run("python3", [join(import.meta.dirname, "check-public-egress-security.py")], childEnv);
  await run("python3", [join(import.meta.dirname, "check-public-egress-docker.py")], childEnv);
  await run(process.execPath, [join(import.meta.dirname, "check-network-boundary.mjs")], childEnv);
  await run(
    process.execPath,
    [join(import.meta.dirname, "check-publication-recovery.mjs")],
    childEnv,
  );
  await run(process.execPath, [join(import.meta.dirname, "check-benchmark-lock.mjs")], childEnv);
  await run(process.execPath, [join(import.meta.dirname, "check-secret-scanner.mjs")], childEnv);
  process.stdout.write("Terminal-Bench provider secret FD boundary passed.\n");
} finally {
  delete process.env[secretEnv];
  await run(
    "docker",
    ["compose", "--project-name", project, "-f", composePath, "down", "--volumes"],
    allowlistedHostEnv(process.env),
  ).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function run(command, args, env, secret = null) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "inherit", "inherit", secret === null ? "ignore" : "pipe"],
    });
    if (secret !== null) child.stdio[3].end(secret);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}
