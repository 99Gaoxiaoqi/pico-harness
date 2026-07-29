import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import * as dockerResources from "../../scripts/terminal-bench/docker-resources.mjs";

const { captureDockerResourceSnapshot, cleanupDockerResources } = dockerResources;

test("Terminal-Bench cleanup preserves concurrent unowned Docker resources", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-docker-cleanup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dockerPath = join(root, "docker");
  const registryPath = join(root, "registry.jsonl");
  await writeFile(dockerPath, fakeDockerScript, { mode: 0o700 });
  await chmod(dockerPath, 0o700);
  const env = {
    ...process.env,
    PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_DOCKER_STATE: root,
  };
  await writeState(root, "containers", [
    "baseline-container baseline=true",
    "owned-container com.docker.compose.project=owned-project",
    "unrelated-container other=true",
  ]);
  await writeState(root, "networks", [
    "baseline-network baseline=true",
    "owned-network com.docker.compose.project=owned-project",
    "unrelated-network other=true",
  ]);
  await writeState(root, "volumes", [
    "baseline-volume baseline=true",
    "owned-volume com.docker.compose.project=owned-project",
    "unrelated-volume other=true",
  ]);
  const before = {
    containers: new Set(["baseline-container"]),
    networks: new Set(["baseline-network"]),
    volumes: new Set(["baseline-volume"]),
  };
  await writeFile(
    registryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      runId: "fixture-run",
      composeProject: "owned-project",
    })}\n`,
  );

  await assert.rejects(
    cleanupDockerResources({
      env,
      cwd: root,
      runId: "fixture-run",
      before,
      registryPath,
      quietPeriodMs: 100,
      pollIntervalMs: 10,
      maxWaitMs: 1_000,
    }),
    /cleanup encountered errors/u,
  );

  const after = await captureDockerResourceSnapshot(env, root);
  assert.deepEqual([...after.containers].sort(), ["baseline-container", "unrelated-container"]);
  assert.deepEqual([...after.networks].sort(), ["baseline-network", "unrelated-network"]);
  assert.deepEqual([...after.volumes].sort(), ["baseline-volume", "unrelated-volume"]);
});

test("Terminal-Bench cleanup removes owned resources created during the quiet window", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-docker-late-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dockerPath = join(root, "docker");
  const registryPath = join(root, "registry.jsonl");
  await writeFile(dockerPath, fakeDockerScript, { mode: 0o700 });
  await chmod(dockerPath, 0o700);
  await writeState(root, "containers", ["baseline-container baseline=true"]);
  await writeState(root, "networks", ["baseline-network baseline=true"]);
  await writeState(root, "volumes", ["baseline-volume baseline=true"]);
  await writeFile(registryPath, "");
  const env = {
    ...process.env,
    PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_DOCKER_STATE: root,
  };
  const delayedCreate = new Promise<void>((resolvePromise) => {
    setTimeout(() => {
      void appendFile(
        join(root, "containers"),
        "late-container pico.terminal-bench.run=fixture-run\n",
      ).then(resolvePromise);
    }, 75);
  });
  await cleanupDockerResources({
    env,
    cwd: root,
    runId: "fixture-run",
    before: {
      containers: new Set(["baseline-container"]),
      networks: new Set(["baseline-network"]),
      volumes: new Set(["baseline-volume"]),
    },
    registryPath,
    quietPeriodMs: 200,
    pollIntervalMs: 25,
    maxWaitMs: 2_000,
  });
  await delayedCreate;
  const after = await captureDockerResourceSnapshot(env, root);
  assert.deepEqual([...after.containers], ["baseline-container"]);
});

async function writeState(root: string, name: string, values: string[]) {
  await writeFile(join(root, name), `${values.join("\n")}\n`);
}

const fakeDockerScript = `#!/bin/sh
set -eu
state="\${FAKE_DOCKER_STATE:?}"
kind=""
operation=""
case "$1" in
  ps) kind="containers"; operation="list"; shift ;;
  network)
    kind="networks"
    shift
    operation="$1"
    shift
    ;;
  volume)
    kind="volumes"
    shift
    operation="$1"
    shift
    ;;
  rm) kind="containers"; operation="rm"; shift ;;
  *) exit 2 ;;
esac

list() {
  file="$state/$kind"
  filter=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--filter" ]; then
      shift
      filter="$1"
    fi
    shift
  done
  if [ -z "$filter" ] || [ "$filter" = "type=custom" ]; then
    awk '{print $1}' "$file"
  else
    label="\${filter#label=}"
    awk -v label="$label" '$2 == label {print $1}' "$file"
  fi
}

remove_resource() {
  file="$state/$kind"
  id=""
  for arg in "$@"; do
    case "$arg" in
      rm|--force) ;;
      *) id="$arg" ;;
    esac
  done
  awk -v id="$id" '$1 != id' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

case "$operation" in
  list|ls)
    list "$@"
    ;;
  rm)
    remove_resource "$@"
    ;;
  *)
    exit 2
    ;;
esac
`;
