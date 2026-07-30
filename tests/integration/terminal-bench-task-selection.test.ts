import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

// @ts-expect-error The benchmark selector is intentionally plain Node ESM.
import * as taskSelection from "../../scripts/terminal-bench/task-selection.mjs";

const { harborTaskIncludeArgs, selectCachedFullTasks, validateTaskOptions } = taskSelection;

const execFileAsync = promisify(execFile);

test("Terminal-Bench cached-full selects an exact requested subset in fixed task order", () => {
  const fullTasks = fixtureTasks();
  const imageRefs = fixtureImageRefs(fullTasks);
  const task0 = requiredTask(fullTasks, 0);
  const task1 = requiredTask(fullTasks, 1);
  const task2 = requiredTask(fullTasks, 2);
  const task10 = requiredTask(fullTasks, 10);
  const locallyCachedTasks = [task0, task1, task2, task10];
  const localRefs = new Set(locallyCachedTasks.map((taskName) => imageRefs.get(taskName)));

  const resolution = selectCachedFullTasks({
    fullTasks,
    requestedTasks: [task10, task1],
    imageRefs,
    localRefs,
  });

  assert.deepEqual(resolution.tasks, [task1, task10]);
  assert.deepEqual(resolution.localImageRefs, [imageRefs.get(task1), imageRefs.get(task10)]);
  assert.deepEqual(resolution.selection, {
    schemaVersion: 2,
    mode: "cached-full",
    selectionPolicy: "explicit-task-allowlist",
    platform: "linux/amd64",
    requestedTasks: [task1, task10],
    selectedTasks: [task1, task10],
    excludedTasks: fullTasks
      .filter((taskName) => ![task1, task10].includes(taskName))
      .map((taskName) => ({
        taskName,
        reason: locallyCachedTasks.includes(taskName) ? "not-requested" : "locked-image-not-cached",
      })),
  });
  assert.deepEqual(harborTaskIncludeArgs(resolution.tasks), [
    "--include-task-name",
    task1.slice("terminal-bench/".length),
    "--include-task-name",
    task10.slice("terminal-bench/".length),
  ]);
});

test("Terminal-Bench cached-full keeps the all-local default selection", () => {
  const fullTasks = fixtureTasks();
  const imageRefs = fixtureImageRefs(fullTasks);
  const locallyCachedTasks = [requiredTask(fullTasks, 0), requiredTask(fullTasks, 3)];
  const localRefs = new Set(locallyCachedTasks.map((taskName) => imageRefs.get(taskName)));

  const resolution = selectCachedFullTasks({
    fullTasks,
    requestedTasks: [],
    imageRefs,
    localRefs,
  });

  assert.deepEqual(resolution.tasks, locallyCachedTasks);
  assert.equal(resolution.selection.selectionPolicy, "all-locally-cached");
  assert.deepEqual(resolution.selection.requestedTasks, []);
  assert.deepEqual(resolution.selection.selectedTasks, locallyCachedTasks);
  assert.equal(
    resolution.selection.excludedTasks.every(
      (entry: { reason: string }) => entry.reason === "locked-image-not-cached",
    ),
    true,
  );
});

test("Terminal-Bench task options preserve fixed modes and reject non-exact inputs", () => {
  const task = "terminal-bench/example";
  assert.doesNotThrow(() => validateTaskOptions("single", [task]));
  assert.doesNotThrow(() => validateTaskOptions("cached-full", [task]));
  assert.throws(
    () => validateTaskOptions("single", []),
    /single mode requires exactly one --task/u,
  );
  assert.throws(
    () => validateTaskOptions("single", [task, "terminal-bench/other"]),
    /single mode requires exactly one --task/u,
  );
  assert.throws(() => validateTaskOptions("canary", [task]), /canary mode does not accept --task/u);
  assert.throws(() => validateTaskOptions("full", [task]), /full mode does not accept --task/u);
  assert.throws(
    () => validateTaskOptions("cached-full", [task, task]),
    /--task options contain duplicates/u,
  );
  assert.throws(
    () => validateTaskOptions("cached-full", ["terminal-bench/example*"]),
    /exact terminal-bench\/<name>/u,
  );
  assert.throws(
    () => validateTaskOptions("cached-full", ["terminal-bench/nested/example"]),
    /exact terminal-bench\/<name>/u,
  );
});

test("Terminal-Bench cached-full fails closed for unknown or unavailable requested tasks", () => {
  const fullTasks = fixtureTasks();
  const imageRefs = fixtureImageRefs(fullTasks);
  const task0 = requiredTask(fullTasks, 0);
  const task1 = requiredTask(fullTasks, 1);
  const localRefs = new Set([imageRefs.get(task0)]);

  assert.throws(
    () =>
      selectCachedFullTasks({
        fullTasks,
        requestedTasks: ["terminal-bench/not-in-lock"],
        imageRefs,
        localRefs,
      }),
    /outside the fixed task list/u,
  );
  assert.throws(
    () =>
      selectCachedFullTasks({
        fullTasks,
        requestedTasks: [task1],
        imageRefs,
        localRefs,
      }),
    /requested image is not cached/u,
  );

  const incompleteImageRefs = new Map(imageRefs);
  incompleteImageRefs.delete(task1);
  assert.throws(
    () =>
      selectCachedFullTasks({
        fullTasks,
        requestedTasks: [task0],
        imageRefs: incompleteImageRefs,
        localRefs,
      }),
    /image lock is incomplete/u,
  );
});

test("Terminal-Bench runner rejects fixed-mode and duplicate task flags before loading secrets", async () => {
  const runner = "scripts/terminal-bench/run.mjs";
  const task = "terminal-bench/example";
  const cases = [
    {
      args: ["--mode", "canary", "--task", task],
      expected: /canary mode does not accept --task/u,
    },
    {
      args: ["--mode", "full", "--task", task],
      expected: /full mode does not accept --task/u,
    },
    {
      args: ["--mode", "cached-full", "--task", task, "--task", task],
      expected: /--task options contain duplicates/u,
    },
    {
      args: ["--mode", "single", "--task", task, "--task", "terminal-bench/other"],
      expected: /single mode requires exactly one --task/u,
    },
  ];

  for (const fixture of cases) {
    await assert.rejects(
      execFileAsync(process.execPath, [runner, ...fixture.args], {
        env: { PATH: process.env.PATH ?? "" },
      }),
      (error: unknown) => {
        const stderr =
          typeof error === "object" && error !== null && "stderr" in error
            ? String(error.stderr)
            : String(error);
        assert.match(stderr, fixture.expected);
        assert.doesNotMatch(stderr, /credential|config\.json|\.env/u);
        return true;
      },
    );
  }
});

function fixtureTasks() {
  return Array.from(
    { length: 89 },
    (_, index) => `terminal-bench/fixture-${String(index).padStart(2, "0")}`,
  );
}

function requiredTask(tasks: string[], index: number) {
  const task = tasks[index];
  assert.ok(task);
  return task;
}

function fixtureImageRefs(tasks: string[]) {
  return new Map(
    tasks.map((taskName, index) => [
      taskName,
      `registry.example/terminal-bench/${taskName.slice(
        "terminal-bench/".length,
      )}@sha256:${String(index).padStart(64, "0")}`,
    ]),
  );
}
