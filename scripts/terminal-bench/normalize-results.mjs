import { createHash } from "node:crypto";
import { lstat, link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const protocolErrors = new Set([
  "INVALID_JSON",
  "INPUT_TOO_LARGE",
  "INVALID_REQUEST",
  "UNKNOWN_FIELD",
  "MISSING_FIELD",
  "UNSUPPORTED_SCHEMA_VERSION",
  "INVALID_FIELD",
  "INVALID_PERMISSION_MODE",
  "INVALID_ALLOWED_TOOLS",
  "ALLOWED_TOOLS_INVALID",
  "INVALID_TRACE",
  "PATH_NOT_ABSOLUTE",
  "INVALID_SESSION_ID",
]);
const isolationErrors = new Set([
  "CASE_RESOURCE_CONFLICT",
  "SESSION_ALREADY_EXISTS",
  "LOCK_ROOT_INVALID",
]);
const configErrors = new Set([
  "PATH_INVALID",
  "PICO_HOME_NOT_ISOLATED",
  "CASE_PATH_OVERLAP",
  "WORKSPACE_UNTRUSTED",
  "MODEL_RUNTIME_INVALID",
  "MODEL_ROUTE_INVALID",
  "THINKING_EFFORT_INVALID",
]);

export async function normalizeHarborJob({
  jobDir,
  runDir,
  runId,
  expectedTasks = null,
  expectedTaskNames = null,
  expectedAttempts = 1,
}) {
  const source = resolve(jobDir);
  const destination = resolve(runDir);
  let names;
  try {
    names = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    names = [];
  }
  const trials = [];
  const sourceHashes = [];
  const rawTreeSha256 = names.length > 0 ? await hashTree(source) : null;
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const trialDir = join(source, entry.name);
    const trialResultPath = join(trialDir, "result.json");
    const trialResult = await readJson(trialResultPath);
    if (!trialResult || typeof trialResult.task_name !== "string") continue;
    const headlessPath = join(trialDir, "agent", "pico-result.json");
    const headlessRead = await readJsonEvidence(headlessPath);
    const headless = headlessRead.value;
    const verifierEvidencePath = join(trialDir, "verifier", "ctrf.json");
    const verifierEvidenceRead = await readJsonEvidence(verifierEvidencePath);
    const verifierEvidence = validateCtrfEvidence(
      verifierEvidenceRead.value,
      verifierEvidenceRead.error,
    );
    const trialResultSha256 = await sha256File(trialResultPath);
    const headlessSha256 = headless ? await sha256File(headlessPath) : null;
    const verifierEvidenceSha256 = verifierEvidence.valid
      ? await sha256File(verifierEvidencePath)
      : null;
    const normalized = normalizeTrial({
      runId,
      trialResult,
      headless,
      headlessReadError: headlessRead.error,
      verifierEvidence: verifierEvidence.valid ? verifierEvidenceRead.value : null,
      verifierEvidenceError: verifierEvidence.error,
      source: {
        trialResult: relativeSource(jobDir, trialResultPath),
        trialResultSha256,
        headlessResult: headless ? relativeSource(jobDir, headlessPath) : null,
        headlessResultSha256: headlessSha256,
        verifierEvidence: verifierEvidence.valid
          ? relativeSource(jobDir, verifierEvidencePath)
          : null,
        verifierEvidenceSha256,
      },
    });
    const taskName = canonicalTaskName(trialResult.task_name);
    const taskSlug = slug(taskName);
    const caseDir = join(destination, "cases", taskSlug, entry.name);
    await mkdir(caseDir, { recursive: true, mode: 0o700 });
    if (headless) await writeOnceJson(join(caseDir, "headless-result.json"), headless);
    await writeOnceJson(join(caseDir, "normalized-result.json"), normalized);
    await writeOnceJson(join(caseDir, "provenance.json"), {
      schemaVersion: 1,
      normalizerVersion: 2,
      runId,
      taskName,
      harborTaskName: trialResult.task_name,
      taskChecksum: trialResult.task_checksum ?? null,
      trialId: trialResult.id ?? null,
      harborConfig: trialResult.config ?? null,
      agentInfo: trialResult.agent_info ?? null,
      source: normalized.source,
    });
    const traceSource = join(trialDir, "agent", "trace.json");
    try {
      await copyOnce(traceSource, join(caseDir, "trace.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    trials.push(normalized);
    sourceHashes.push({
      trial: entry.name,
      trialResultSha256,
      headlessResultSha256: headlessSha256,
      verifierEvidenceSha256,
    });
  }
  const counts = Object.create(null);
  for (const trial of trials) {
    counts[trial.primaryStatus] = (counts[trial.primaryStatus] ?? 0) + 1;
  }
  const observedTaskCounts = Object.create(null);
  const trialIds = new Set();
  let trialIdentityValid = true;
  for (const trial of trials) {
    observedTaskCounts[trial.taskId] = (observedTaskCounts[trial.taskId] ?? 0) + 1;
    if (
      typeof trial.trialId !== "string" ||
      trial.trialId.length === 0 ||
      trialIds.has(trial.trialId)
    ) {
      trialIdentityValid = false;
    } else {
      trialIds.add(trial.trialId);
    }
  }
  const expectedSetMatches =
    expectedTaskNames === null ||
    (Object.keys(observedTaskCounts).length === expectedTaskNames.length &&
      expectedTaskNames.every((name) => observedTaskCounts[name] === expectedAttempts));
  const trialGateValid = trials.every(
    (trial) =>
      trial.infra.status === "ok" &&
      trial.adapter.status === "ok" &&
      trial.verifier.status === "completed",
  );
  const sealed =
    expectedTasks === null
      ? false
      : trials.length === expectedTasks &&
        expectedSetMatches &&
        trialIdentityValid &&
        trialGateValid &&
        rawTreeSha256 !== null;
  const summary = {
    schemaVersion: 2,
    runId,
    scheduled: expectedTasks,
    observed: trials.length,
    sealed,
    headlessCompleted: trials.filter((trial) => trial.agent.status === "completed").length,
    verifierCompleted: trials.filter((trial) => trial.verifier.status === "completed").length,
    passed: counts.passed ?? 0,
    counts,
    trials,
  };
  await writeOnceJson(join(destination, "source-hashes.json"), {
    schemaVersion: 1,
    sealed,
    rawTreeSha256,
    sources: sourceHashes,
  });
  await writeOnceJson(join(destination, "summary.json"), summary);
  return summary;
}

export function normalizeTrial({
  runId,
  trialResult,
  headless,
  headlessReadError = null,
  verifierEvidence = null,
  verifierEvidenceError = null,
  source = null,
}) {
  const verifierResult = trialResult.verifier_result;
  const rewards =
    verifierResult && typeof verifierResult === "object" && verifierResult.rewards
      ? verifierResult.rewards
      : null;
  const overall = typeof rewards?.reward === "number" ? rewards.reward : null;
  const exitCode = trialResult.agent_result?.metadata?.pico?.exitCode ?? null;
  const exception = trialResult.exception_info;
  const infra = classifyInfra({ headless, exception });
  const adapter = classifyAdapter({ headless, exitCode, headlessReadError });
  const agent = classifyAgent(headless, exitCode);
  const verifier = {
    status:
      verifierEvidence === null
        ? "error"
        : overall === null
          ? exception
            ? "error"
            : "missing"
          : "completed",
    exceptionType:
      verifierEvidence === null
        ? verifierEvidenceError || "VerifierEvidenceMissing"
        : (exception?.exception_type ?? null),
  };
  const primaryStatus = classifyPrimary({ infra, adapter, agent, verifier, reward: overall });
  return {
    schemaVersion: 2,
    normalizerVersion: 2,
    runId,
    taskId:
      typeof trialResult.task_name === "string" ? canonicalTaskName(trialResult.task_name) : null,
    trialId: trialResult.id ?? null,
    primaryStatus,
    infra,
    adapter,
    agent,
    verifier,
    reward: {
      overall: verifier.status === "completed" ? overall : null,
      metrics: verifier.status === "completed" ? rewards : {},
    },
    source,
    provenanceRef: "provenance.json",
  };
}

function validateCtrfEvidence(value, readError) {
  if (value === null) {
    return {
      valid: false,
      error: readError ? "VerifierEvidenceInvalid" : "VerifierEvidenceMissing",
    };
  }
  const results = value?.results;
  const tool = results?.tool;
  const tests = results?.tests;
  const summary = results?.summary;
  const statuses = ["passed", "failed", "skipped", "pending", "other"];
  if (
    !results ||
    typeof results !== "object" ||
    !tool ||
    typeof tool !== "object" ||
    tool.name !== "pytest" ||
    typeof tool.version !== "string" ||
    tool.version.length === 0 ||
    !Array.isArray(tests) ||
    tests.length === 0 ||
    !summary ||
    typeof summary !== "object" ||
    !Number.isInteger(summary.tests) ||
    summary.tests !== tests.length ||
    statuses.some((status) => !Number.isInteger(summary[status]) || summary[status] < 0) ||
    statuses.reduce((total, status) => total + summary[status], 0) !== tests.length
  ) {
    return { valid: false, error: "VerifierEvidenceInvalid" };
  }
  const validStatuses = new Set(statuses);
  if (
    tests.some(
      (test) =>
        !test ||
        typeof test !== "object" ||
        typeof test.name !== "string" ||
        test.name.length === 0 ||
        !validStatuses.has(test.status),
    )
  ) {
    return { valid: false, error: "VerifierEvidenceInvalid" };
  }
  const observed = Object.fromEntries(statuses.map((status) => [status, 0]));
  for (const test of tests) observed[test.status] += 1;
  if (statuses.some((status) => observed[status] !== summary[status])) {
    return { valid: false, error: "VerifierEvidenceInvalid" };
  }
  return { valid: true, error: null };
}

function classifyInfra({ headless, exception }) {
  if (headless?.terminationConfirmed === false) {
    return { status: "error", code: "termination_unconfirmed" };
  }
  const code = headless?.error?.code;
  if (isolationErrors.has(code)) return { status: "error", code };
  if (!headless && exception) {
    const text = JSON.stringify(exception);
    return {
      status: "error",
      code: text.includes("outer_timeout_budget_violation")
        ? "outer_timeout_budget_violation"
        : "harbor_agent_exception",
    };
  }
  return { status: "ok", code: null };
}

function classifyAdapter({ headless, exitCode, headlessReadError }) {
  if (headlessReadError) return { status: "error", code: "headless_result_invalid" };
  if (!headless) return { status: "error", code: "headless_result_missing" };
  const expected = {
    completed: [0],
    invalid_request: [2],
    failed: [3],
    policy_blocked: [4],
    timed_out: [124],
    canceled: [130, 143],
  };
  if (!expected[headless.status]?.includes(exitCode)) {
    return { status: "error", code: "status_exit_mismatch" };
  }
  const code = headless.error?.code;
  if (protocolErrors.has(code)) return { status: "error", code };
  if (configErrors.has(code)) return { status: "error", code: `config:${code}` };
  return { status: "ok", code: null };
}

function classifyAgent(headless, exitCode) {
  return {
    status: headless?.status ?? "missing",
    exitCode,
    errorCode: headless?.error?.code ?? null,
    terminationConfirmed: headless?.terminationConfirmed ?? null,
    durationMs: headless?.durationMs ?? null,
    usage: headless?.usage ?? null,
  };
}

function classifyPrimary({ infra, adapter, agent, verifier, reward }) {
  if (agent.terminationConfirmed === false || infra.status === "error") return "infra_error";
  if (adapter.status === "error") return "adapter_error";
  if (verifier.status !== "completed") return "verifier_error";
  switch (agent.status) {
    case "timed_out":
      return "agent_timeout";
    case "canceled":
      return "agent_canceled";
    case "policy_blocked":
      return "policy_blocked";
    case "failed":
      return "agent_error";
    case "completed":
      return reward >= 1 ? "passed" : "task_failed";
    default:
      return "adapter_error";
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonEvidence(path) {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")), error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: null, error: null };
    if (error instanceof SyntaxError) return { value: null, error: "invalid_json" };
    throw error;
  }
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function hashTree(root) {
  const hash = createHash("sha256");
  async function visit(path, relative) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Harbor result tree contains symlink: ${path}`);
    if (info.isDirectory()) {
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        await visit(join(path, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
      }
      return;
    }
    if (!info.isFile()) return;
    const data = await readFile(path);
    hash.update(`${relative}\0${data.length}\0`);
    hash.update(data);
  }
  await visit(root, "");
  return hash.digest("hex");
}

async function writeOnceJson(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  return writeOnceBytes(path, Buffer.from(serialized));
}

async function writeOnceBytes(path, value) {
  try {
    const existing = await readFile(path);
    if (existing.equals(value)) return;
    throw new Error(`sealed benchmark artifact changed: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(value)) {
      throw new Error(`sealed benchmark artifact changed: ${path}`, { cause: error });
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function copyOnce(source, destination) {
  const sourceBytes = await readFile(source);
  await writeOnceBytes(destination, sourceBytes);
}

function relativeSource(jobDir, path) {
  return `harbor-job/job/${path.slice(resolve(jobDir).length + 1)}`;
}

function slug(value) {
  return value.replace(/^terminal-bench\//u, "").replace(/[^A-Za-z0-9._-]+/gu, "-");
}

function canonicalTaskName(value) {
  return value.startsWith("terminal-bench/") ? value : `terminal-bench/${value}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [jobDir, runDir, requestedRunId] = process.argv.slice(2);
  if (!jobDir || !runDir) {
    throw new Error("Usage: normalize-results.mjs <harbor-job-dir> <run-dir> [run-id]");
  }
  const runId = requestedRunId ?? basename(resolve(runDir));
  const summary = await normalizeHarborJob({ jobDir, runDir, runId });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
