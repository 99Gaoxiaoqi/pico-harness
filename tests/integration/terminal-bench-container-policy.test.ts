import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import * as containerPolicy from "../../scripts/terminal-bench/container-policy.mjs";

const { assertTaskComposePolicy, prestartNetworkOverlay } = containerPolicy;
const dockerComposeAvailable =
  spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
    timeout: 5_000,
  }).status === 0;

test("Terminal-Bench accepts its exact single-main prestart overlay", async (context) => {
  if (!dockerComposeAvailable) return context.skip("docker compose is unavailable");
  const root = await createTaskRoot(context, "trusted");
  await writeFile(
    join(root, "environment", "docker-compose.yaml"),
    prestartNetworkOverlay("fixture-run"),
  );
  await assertTaskComposePolicy(root, process.env);

  await writeFile(
    join(root, "environment", "docker-compose.yaml"),
    [
      "services:",
      "  main:",
      "    image: node:22-bookworm",
      "  proxy:",
      "    image: node:22-bookworm",
      "",
    ].join("\n"),
  );
  await assert.rejects(assertTaskComposePolicy(root, process.env), /only define the main service/u);
});

test("Terminal-Bench accepts its exact cached-image-only overlay", async (context) => {
  const root = await createTaskRoot(context, "cached-only");
  const overlay = prestartNetworkOverlay("fixture-run", { localImagesOnly: true });
  assert.match(overlay, /pull_policy: never/u);
  await writeFile(join(root, "environment", "docker-compose.yaml"), overlay);
  await assertTaskComposePolicy(root, process.env);
});

test("Terminal-Bench rejects sidecars and externally connected proxies", async (context) => {
  if (!dockerComposeAvailable) return context.skip("docker compose is unavailable");
  const root = await createTaskRoot(context, "sidecar");
  await writeFile(
    join(root, "environment", "compose.yaml"),
    [
      "services:",
      "  main:",
      "    image: node:22-bookworm",
      "  proxy:",
      "    image: node:22-bookworm",
      "    networks:",
      "      - default",
      "      - provider",
      "networks:",
      "  default: {}",
      "  provider:",
      "    external: true",
      "",
    ].join("\n"),
  );
  await assert.rejects(assertTaskComposePolicy(root, process.env), /only define the main service/u);
});

test("Terminal-Bench rejects a dual-homed main service", async (context) => {
  if (!dockerComposeAvailable) return context.skip("docker compose is unavailable");
  const root = await createTaskRoot(context, "dual-home");
  await writeFile(
    join(root, "environment", "compose.yaml"),
    [
      "services:",
      "  main:",
      "    image: node:22-bookworm",
      "    networks:",
      "      - default",
      "      - provider",
      "networks:",
      "  default: {}",
      "  provider:",
      "    external: true",
      "",
    ].join("\n"),
  );
  await assert.rejects(assertTaskComposePolicy(root, process.env), /unsafe network/u);
});

async function createTaskRoot(context: { after(callback: () => unknown): void }, name: string) {
  const root = await mkdtemp(join(tmpdir(), `pico-tb21-compose-${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "environment"), { recursive: true });
  return root;
}
