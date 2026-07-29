import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import * as containerPolicy from "../../scripts/terminal-bench/container-policy.mjs";

const { assertTaskComposePolicy, prestartNetworkOverlay } = containerPolicy;

test("Terminal-Bench accepts its exact single-main prestart overlay", async (context) => {
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

test("Terminal-Bench rejects sidecars and externally connected proxies", async (context) => {
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
      "  provider:",
      "    external: true",
      "",
    ].join("\n"),
  );
  await assert.rejects(assertTaskComposePolicy(root, process.env), /only define the main service/u);
});

test("Terminal-Bench rejects a dual-homed main service", async (context) => {
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
