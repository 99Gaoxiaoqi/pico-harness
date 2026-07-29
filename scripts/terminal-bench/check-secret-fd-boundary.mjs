import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { allowlistedHostEnv, openUnlinkedSecret } from "./host-secret-boundary.mjs";

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
  const secretHandle = await openUnlinkedSecret(secret, root);
  const childEnv = allowlistedHostEnv(process.env);
  const childScript = [
    "import os, subprocess, sys",
    `secret = os.pread(3, 65536, 0).decode()`,
    "os.close(3)",
    `assert secret == ${JSON.stringify(secret)}`,
    `assert ${JSON.stringify(secretEnv)} not in os.environ`,
    "result = subprocess.run(sys.argv[1:], check=True, capture_output=True, text=True)",
    "assert result.stdout == 'ABSENT'",
  ].join("; ");
  try {
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
      secretHandle.fd,
    );
  } finally {
    await secretHandle.close();
  }
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

function run(command, args, env, secretFd = "ignore") {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "inherit", "inherit", secretFd],
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}
