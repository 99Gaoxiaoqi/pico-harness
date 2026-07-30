const taskPrefix = "terminal-bench/";
const taskNamePattern = /^terminal-bench\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const fullTaskCount = 89;

export function validateTaskOptions(mode, requestedTasks) {
  if (!Array.isArray(requestedTasks)) {
    throw new Error("Terminal-Bench --task options are invalid");
  }
  if (requestedTasks.some((taskName) => !taskNamePattern.test(taskName))) {
    throw new Error("--task must use an exact terminal-bench/<name>");
  }
  if (mode === "single") {
    if (requestedTasks.length !== 1) {
      throw new Error("Terminal-Bench single mode requires exactly one --task");
    }
    return;
  }
  if (mode === "canary" || mode === "full") {
    if (requestedTasks.length > 0) {
      throw new Error(`Terminal-Bench ${mode} mode does not accept --task`);
    }
    return;
  }
  if (mode !== "cached-full") {
    throw new Error(`Terminal-Bench dataset mode is unsupported: ${mode}`);
  }
  if (new Set(requestedTasks).size !== requestedTasks.length) {
    throw new Error("Terminal-Bench cached-full --task options contain duplicates");
  }
}

export function selectCachedFullTasks({ fullTasks, requestedTasks, imageRefs, localRefs }) {
  validateTaskOptions("cached-full", requestedTasks);
  if (
    !Array.isArray(fullTasks) ||
    fullTasks.length !== fullTaskCount ||
    new Set(fullTasks).size !== fullTaskCount ||
    fullTasks.some((taskName) => !taskNamePattern.test(taskName))
  ) {
    throw new Error("Terminal-Bench cached-full requires the fixed 89-task list");
  }
  if (
    !(imageRefs instanceof Map) ||
    imageRefs.size !== fullTaskCount ||
    fullTasks.some(
      (taskName) =>
        !imageRefs.has(taskName) ||
        typeof imageRefs.get(taskName) !== "string" ||
        imageRefs.get(taskName).length === 0,
    )
  ) {
    throw new Error("Terminal-Bench cached-full image lock is incomplete");
  }
  if (!(localRefs instanceof Set)) {
    throw new Error("Terminal-Bench cached-full local image inventory is invalid");
  }

  const fullTaskSet = new Set(fullTasks);
  const unknownTasks = requestedTasks.filter((taskName) => !fullTaskSet.has(taskName));
  if (unknownTasks.length > 0) {
    throw new Error(
      `Terminal-Bench cached-full --task is outside the fixed task list: ${unknownTasks.join(", ")}`,
    );
  }

  const locallyCachedTasks = fullTasks.filter((taskName) => localRefs.has(imageRefs.get(taskName)));
  const locallyCachedTaskSet = new Set(locallyCachedTasks);
  const unavailableTasks = requestedTasks.filter((taskName) => !locallyCachedTaskSet.has(taskName));
  if (unavailableTasks.length > 0) {
    throw new Error(
      `Terminal-Bench cached-full requested image is not cached: ${unavailableTasks.join(", ")}`,
    );
  }

  const requestedTaskSet = new Set(requestedTasks);
  const tasks =
    requestedTasks.length === 0
      ? locallyCachedTasks
      : fullTasks.filter((taskName) => requestedTaskSet.has(taskName));
  if (tasks.length === 0) {
    throw new Error("Terminal-Bench cached-full found no locally cached locked images");
  }
  const selectedTaskSet = new Set(tasks);

  return {
    tasks,
    localImageRefs: tasks.map((taskName) => imageRefs.get(taskName)),
    selection: {
      schemaVersion: 2,
      mode: "cached-full",
      selectionPolicy:
        requestedTasks.length === 0 ? "all-locally-cached" : "explicit-task-allowlist",
      platform: "linux/amd64",
      requestedTasks:
        requestedTasks.length === 0
          ? []
          : fullTasks.filter((taskName) => requestedTaskSet.has(taskName)),
      selectedTasks: tasks,
      excludedTasks: fullTasks
        .filter((taskName) => !selectedTaskSet.has(taskName))
        .map((taskName) => ({
          taskName,
          reason: locallyCachedTaskSet.has(taskName) ? "not-requested" : "locked-image-not-cached",
        })),
    },
  };
}

export function harborTaskIncludeArgs(tasks) {
  if (
    !Array.isArray(tasks) ||
    tasks.length === 0 ||
    new Set(tasks).size !== tasks.length ||
    tasks.some((taskName) => !taskNamePattern.test(taskName))
  ) {
    throw new Error("Terminal-Bench Harbor task include set is invalid");
  }
  return tasks.flatMap((taskName) => ["--include-task-name", taskName.slice(taskPrefix.length)]);
}
