import { createHash, createHmac } from "node:crypto";
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
  "INVALID_PROVIDER_REQUEST_MODE",
  "INVALID_POLICY_DENIAL_MODE",
  "INVALID_ALLOWED_TOOLS",
  "ALLOWED_TOOLS_INVALID",
  "INVALID_BASH_TIMEOUT",
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
const policyDenialCodes = ["plan_mode", "hardline", "hook", "approval"];
const maxPolicyDenialToolNameLength = 128;

export async function normalizeHarborJob({
  jobDir,
  runDir,
  runId,
  expectedTasks = null,
  expectedTaskNames = null,
  expectedAttempts = 1,
  gatewayCapabilitySeed = null,
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
    const accountingReceiptPath = join(trialDir, "agent", "gateway-accounting-receipt.json");
    const accountingReceiptRead = await readJsonEvidence(accountingReceiptPath);
    const accounting = validateAccountingReceipt({
      value: accountingReceiptRead.value,
      readError: accountingReceiptRead.error,
      runId,
      trialResult,
      headless,
      gatewayCapabilitySeed,
    });
    const verifierEvidencePath = join(trialDir, "verifier", "ctrf.json");
    const verifierEvidenceRead = await readJsonEvidence(verifierEvidencePath);
    const verifierEvidence = validateCtrfEvidence(
      verifierEvidenceRead.value,
      verifierEvidenceRead.error,
    );
    const trialResultSha256 = await sha256File(trialResultPath);
    const headlessSha256 = headless ? sha256Bytes(headlessRead.bytes) : null;
    const accountingReceiptSha256 = accountingReceiptRead.value
      ? sha256Bytes(accountingReceiptRead.bytes)
      : null;
    const verifierEvidenceSha256 = verifierEvidence.valid
      ? sha256Bytes(verifierEvidenceRead.bytes)
      : null;
    const normalized = normalizeTrial({
      runId,
      trialResult,
      headless,
      headlessReadError: headlessRead.error,
      accounting,
      verifierEvidence: verifierEvidence.valid ? verifierEvidenceRead.value : null,
      verifierEvidenceError: verifierEvidence.error,
      source: {
        trialResult: relativeSource(jobDir, trialResultPath),
        trialResultSha256,
        headlessResult: headless ? relativeSource(jobDir, headlessPath) : null,
        headlessResultSha256: headlessSha256,
        accountingReceipt: accountingReceiptRead.value
          ? relativeSource(jobDir, accountingReceiptPath)
          : null,
        accountingReceiptSha256,
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
    if (accountingReceiptRead.value) {
      await writeOnceBytes(
        join(caseDir, "gateway-accounting-receipt.json"),
        accountingReceiptRead.bytes,
      );
    }
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
      accountingReceiptSha256,
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
  const verifierPassCount = trials.filter((trial) => trial.verifierPassed).length;
  const cleanCompletionCount = trials.filter(
    (trial) => trial.executionOutcome === "completed" && !trial.policyIncident,
  ).length;
  const cleanPassCount = trials.filter(
    (trial) =>
      trial.verifierPassed && trial.executionOutcome === "completed" && !trial.policyIncident,
  ).length;
  const policyIncidentCount = trials.filter((trial) => trial.policyIncident).length;
  const verifierPassWithPolicyIncidentCount = trials.filter(
    (trial) => trial.verifierPassed && trial.policyIncident,
  ).length;
  const summary = {
    schemaVersion: 2,
    runId,
    scheduled: expectedTasks,
    observed: trials.length,
    sealed,
    headlessCompleted: trials.filter((trial) => trial.agent.status === "completed").length,
    verifierCompleted: trials.filter((trial) => trial.verifier.status === "completed").length,
    passed: counts.passed ?? 0,
    verifierPassCount,
    verifierPassRate: rate(verifierPassCount, trials.length),
    cleanCompletionCount,
    cleanCompletionRate: rate(cleanCompletionCount, trials.length),
    cleanPassCount,
    cleanPassRate: rate(cleanPassCount, trials.length),
    policyIncidentCount,
    policyIncidentRate: rate(policyIncidentCount, trials.length),
    verifierPassWithPolicyIncidentCount,
    verifierPassWithPolicyIncidentRate: rate(verifierPassWithPolicyIncidentCount, trials.length),
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
  accounting = { valid: false, code: "accounting_receipt_missing", receipt: null },
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
  const policyDenials = validatePolicyDenials(headless);
  const adapter = classifyAdapter({
    headless,
    exitCode,
    headlessReadError,
    accounting,
    policyDenials,
  });
  const agent = classifyAgent(headless, exitCode, accounting, policyDenials);
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
  const verifierOutcome = classifyVerifierOutcome({ verifier, reward: overall });
  const executionOutcome = classifyExecutionOutcome({ infra, adapter, agent });
  const policyIncident = agent.status === "policy_blocked" || (agent.policyDenials?.total ?? 0) > 0;
  const primaryStatus = classifyPrimary({
    infra,
    adapter,
    agent,
    verifier,
    reward: overall,
    policyIncident,
  });
  return {
    schemaVersion: 2,
    normalizerVersion: 2,
    runId,
    taskId:
      typeof trialResult.task_name === "string" ? canonicalTaskName(trialResult.task_name) : null,
    trialId: trialResult.id ?? null,
    primaryStatus,
    verifierPassed: verifierOutcome === "passed",
    verifierOutcome,
    executionOutcome,
    policyIncident,
    infra,
    adapter,
    agent,
    accounting: accounting.valid
      ? {
          status: accounting.receipt.status,
          withinBudget: accounting.receipt.withinBudget,
          pricingSha256: accounting.receipt.pricingSha256,
          receiptSha256: accounting.receipt.receiptSha256,
          requestCounts: accounting.receipt.requests,
          requests: accounting.receipt.requestEntries,
          reservation: accounting.receipt.reservation,
          actual: accounting.receipt.actual,
          refund: accounting.receipt.refund,
          supplement: accounting.receipt.supplement,
          unreconciledReservation: accounting.receipt.unreconciledReservation,
          receiptRef: "gateway-accounting-receipt.json",
        }
      : { status: "error", code: accounting.code, receiptRef: null },
    verifier,
    reward: {
      overall: verifier.status === "completed" ? overall : null,
      metrics: verifier.status === "completed" ? rewards : {},
    },
    source,
    provenanceRef: "provenance.json",
  };
}

function validateAccountingReceipt({
  value,
  readError,
  runId,
  trialResult,
  headless,
  gatewayCapabilitySeed,
}) {
  if (readError) {
    return { valid: false, code: "accounting_receipt_invalid", receipt: null };
  }
  if (value === null) {
    return { valid: false, code: "accounting_receipt_missing", receipt: null };
  }
  const keys = [
    "actual",
    "auth",
    "modelRouteId",
    "pricing",
    "pricingSha256",
    "protocol",
    "receiptSha256",
    "refund",
    "requests",
    "requestEntries",
    "reservation",
    "rounding",
    "runId",
    "schemaVersion",
    "status",
    "supplement",
    "trialId",
    "unreconciledReservation",
    "withinBudget",
  ];
  if (
    !isExactObject(value, keys) ||
    value.schemaVersion !== 1 ||
    value.runId !== runId ||
    value.trialId !== trialResult.id ||
    typeof value.modelRouteId !== "string" ||
    value.modelRouteId.length === 0 ||
    !["openai", "claude", "gemini"].includes(value.protocol) ||
    value.rounding !== "ceil-per-request" ||
    !["reconciled", "unreconciled"].includes(value.status) ||
    typeof value.withinBudget !== "boolean"
  ) {
    return { valid: false, code: "accounting_receipt_identity_invalid", receipt: null };
  }
  const pricingKeys = [
    "currency",
    "input",
    "model",
    "output",
    "providerId",
    "schemaVersion",
    "unit",
  ];
  const pricing = value.pricing;
  if (
    !isExactObject(value.auth, ["algorithm", "keyId", "tag"]) ||
    value.auth.algorithm !== "hmac-sha256" ||
    value.auth.keyId !== "run-capability-v1" ||
    typeof value.auth.tag !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.auth.tag)
  ) {
    return { valid: false, code: "accounting_auth_invalid", receipt: null };
  }
  if (typeof gatewayCapabilitySeed !== "string" || !/^[0-9a-f]{64}$/u.test(gatewayCapabilitySeed)) {
    return { valid: false, code: "accounting_auth_key_missing", receipt: null };
  }
  const expectedTag = createHmac("sha256", gatewayCapabilitySeed)
    .update("pico-gateway-accounting-receipt-v1\0")
    .update(canonicalJson(accountingReceiptPayload(value, false)))
    .digest("hex");
  if (value.auth.tag !== expectedTag) {
    return { valid: false, code: "accounting_auth_invalid", receipt: null };
  }
  if (
    !isExactObject(pricing, pricingKeys) ||
    pricing.schemaVersion !== 1 ||
    pricing.currency !== "CNY" ||
    pricing.unit !== "microCNYPerMillionTokens" ||
    typeof pricing.providerId !== "string" ||
    typeof pricing.model !== "string" ||
    value.modelRouteId !== `${pricing.providerId}/${pricing.model}` ||
    !isNonnegativeSafeInteger(pricing.input) ||
    !isNonnegativeSafeInteger(pricing.output) ||
    sha256Canonical(pricing) !== value.pricingSha256
  ) {
    return { valid: false, code: "accounting_pricing_invalid", receipt: null };
  }
  if (
    typeof value.receiptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.receiptSha256) ||
    sha256Canonical(accountingReceiptPayload(value, true)) !== value.receiptSha256
  ) {
    return { valid: false, code: "accounting_receipt_digest_invalid", receipt: null };
  }
  if (
    !isExactObject(value.requests, ["attempted", "reconciled", "unreconciled"]) ||
    !Object.values(value.requests).every(isNonnegativeSafeInteger) ||
    value.requests.attempted !== value.requests.reconciled + value.requests.unreconciled
  ) {
    return { valid: false, code: "accounting_requests_invalid", receipt: null };
  }
  const bucketNames = ["reservation", "actual", "refund", "supplement", "unreconciledReservation"];
  for (const name of bucketNames) {
    const bucketKeys =
      name === "actual"
        ? ["costCNY", "costMicroCNY", "inputTokens", "outputTokens"]
        : ["costMicroCNY", "inputTokens", "outputTokens"];
    if (
      !isExactObject(value[name], bucketKeys) ||
      !["costMicroCNY", "inputTokens", "outputTokens"].every((field) =>
        isNonnegativeSafeInteger(value[name][field]),
      )
    ) {
      return { valid: false, code: "accounting_totals_invalid", receipt: null };
    }
  }
  const actual = value.actual;
  if (
    typeof actual.costCNY !== "number" ||
    !Number.isFinite(actual.costCNY) ||
    actual.costCNY !== actual.costMicroCNY / 1_000_000
  ) {
    return { valid: false, code: "accounting_cost_invalid", receipt: null };
  }
  for (const field of ["inputTokens", "outputTokens", "costMicroCNY"]) {
    if (
      value.reservation[field] +
        value.supplement[field] -
        value.refund[field] -
        value.unreconciledReservation[field] !==
      actual[field]
    ) {
      return { valid: false, code: "accounting_reconciliation_invalid", receipt: null };
    }
  }
  const entries = value.requestEntries;
  if (!Array.isArray(entries) || entries.length !== value.requests.attempted) {
    return { valid: false, code: "accounting_request_entries_invalid", receipt: null };
  }
  const bucketFields = ["inputTokens", "outputTokens", "costMicroCNY"];
  const entryTotals = Object.fromEntries(
    bucketNames.map((name) => [name, { inputTokens: 0, outputTokens: 0, costMicroCNY: 0 }]),
  );
  let observedReconciled = 0;
  let observedUnreconciled = 0;
  for (const [index, entry] of entries.entries()) {
    if (
      !isExactObject(entry, [
        "actual",
        "refund",
        "reservation",
        "sequence",
        "status",
        "supplement",
        "unreconciledReservation",
      ]) ||
      entry.sequence !== index + 1 ||
      !["reconciled", "unreconciled"].includes(entry.status)
    ) {
      return { valid: false, code: "accounting_request_entry_invalid", receipt: null };
    }
    for (const name of bucketNames) {
      if (
        !isExactObject(entry[name], bucketFields) ||
        !bucketFields.every((field) => isNonnegativeSafeInteger(entry[name][field]))
      ) {
        return { valid: false, code: "accounting_request_bucket_invalid", receipt: null };
      }
      for (const field of bucketFields) entryTotals[name][field] += entry[name][field];
    }
    if (
      bucketFields.some(
        (field) =>
          entry.reservation[field] +
            entry.supplement[field] -
            entry.refund[field] -
            entry.unreconciledReservation[field] !==
          entry.actual[field],
      )
    ) {
      return { valid: false, code: "accounting_request_reconciliation_invalid", receipt: null };
    }
    if (entry.status === "reconciled") {
      observedReconciled += 1;
      const expectedCost =
        (BigInt(entry.actual.inputTokens) * BigInt(pricing.input) +
          BigInt(entry.actual.outputTokens) * BigInt(pricing.output) +
          999_999n) /
        1_000_000n;
      if (
        BigInt(entry.actual.costMicroCNY) !== expectedCost ||
        Object.values(entry.unreconciledReservation).some((amount) => amount !== 0)
      ) {
        return { valid: false, code: "accounting_request_cost_invalid", receipt: null };
      }
    } else {
      observedUnreconciled += 1;
      if (
        ["actual", "refund", "supplement"].some((name) =>
          Object.values(entry[name]).some((amount) => amount !== 0),
        ) ||
        bucketFields.some(
          (field) => entry.unreconciledReservation[field] !== entry.reservation[field],
        )
      ) {
        return { valid: false, code: "accounting_request_ambiguity_invalid", receipt: null };
      }
    }
  }
  if (
    observedReconciled !== value.requests.reconciled ||
    observedUnreconciled !== value.requests.unreconciled ||
    bucketNames.some((name) =>
      bucketFields.some((field) => entryTotals[name][field] !== value[name][field]),
    ) ||
    (value.status === "reconciled") !== (value.requests.unreconciled === 0)
  ) {
    return { valid: false, code: "accounting_request_totals_invalid", receipt: null };
  }
  const picoMetadata = trialResult.agent_result?.metadata?.pico;
  const gatewayMetadata = picoMetadata?.gatewayAccounting;
  const harborInputTokens = trialResult.agent_result?.n_input_tokens;
  const harborOutputTokens = trialResult.agent_result?.n_output_tokens;
  const runtimeUsage = headless?.usage;
  if (
    !gatewayMetadata ||
    gatewayMetadata.receiptSha256 !== value.receiptSha256 ||
    gatewayMetadata.pricingSha256 !== value.pricingSha256 ||
    gatewayMetadata.costMicroCNY !== actual.costMicroCNY ||
    gatewayMetadata.costCNY !== actual.costCNY ||
    picoMetadata.costCNY !== actual.costCNY
  ) {
    return { valid: false, code: "accounting_metadata_mismatch", receipt: null };
  }
  if (
    !isNonnegativeSafeInteger(runtimeUsage?.promptTokens) ||
    !isNonnegativeSafeInteger(runtimeUsage?.completionTokens) ||
    !isNonnegativeSafeInteger(harborInputTokens) ||
    !isNonnegativeSafeInteger(harborOutputTokens) ||
    runtimeUsage.promptTokens !== actual.inputTokens ||
    runtimeUsage.completionTokens !== actual.outputTokens ||
    harborInputTokens !== actual.inputTokens ||
    harborOutputTokens !== actual.outputTokens
  ) {
    return { valid: false, code: "accounting_token_mismatch", receipt: null };
  }
  return { valid: true, code: null, receipt: value };
}

function isExactObject(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function accountingReceiptPayload(value, includeAuth) {
  const payload = structuredClone(value);
  delete payload.receiptSha256;
  if (!includeAuth) delete payload.auth;
  delete payload.actual.costCNY;
  return payload;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

function validatePolicyDenials(headless) {
  if (!headless || !Object.prototype.hasOwnProperty.call(headless, "policyDenials")) {
    return { valid: true, value: null };
  }
  const value = headless.policyDenials;
  if (
    !isExactObject(value, ["total", "byCode", "first", "last"]) ||
    !isNonnegativeSafeInteger(value.total) ||
    value.total === 0 ||
    !isExactObject(value.byCode, policyDenialCodes) ||
    policyDenialCodes.some((code) => !isNonnegativeSafeInteger(value.byCode[code])) ||
    policyDenialCodes.reduce((total, code) => total + value.byCode[code], 0) !== value.total ||
    !isPolicyDenialBoundary(value.first) ||
    !isPolicyDenialBoundary(value.last) ||
    value.byCode[value.first.code] === 0 ||
    value.byCode[value.last.code] === 0
  ) {
    return { valid: false, value: null };
  }
  return {
    valid: true,
    value: {
      total: value.total,
      byCode: Object.fromEntries(policyDenialCodes.map((code) => [code, value.byCode[code]])),
      first: projectPolicyDenialBoundary(value.first),
      last: projectPolicyDenialBoundary(value.last),
    },
  };
}

function isPolicyDenialBoundary(value) {
  return (
    isExactObject(value, ["source", "code", "toolName"]) &&
    ["safety", "permission"].includes(value.source) &&
    policyDenialCodes.includes(value.code) &&
    typeof value.toolName === "string" &&
    value.toolName.length > 0 &&
    value.toolName.length <= maxPolicyDenialToolNameLength
  );
}

function projectPolicyDenialBoundary(value) {
  return { source: value.source, code: value.code, toolName: value.toolName };
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

function classifyAdapter({ headless, exitCode, headlessReadError, accounting, policyDenials }) {
  if (headlessReadError) return { status: "error", code: "headless_result_invalid" };
  if (!headless) return { status: "error", code: "headless_result_missing" };
  if (!policyDenials.valid) return { status: "error", code: "policy_denials_invalid" };
  if (!accounting.valid) return { status: "error", code: accounting.code };
  if (accounting.receipt.status !== "reconciled") {
    return { status: "error", code: "accounting_unreconciled" };
  }
  if (accounting.receipt.withinBudget !== true) {
    return { status: "error", code: "accounting_budget_exceeded" };
  }
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

function classifyAgent(headless, exitCode, accounting, policyDenials) {
  const actual = accounting.valid ? accounting.receipt.actual : null;
  const agent = {
    status: headless?.status ?? "missing",
    exitCode,
    errorCode: headless?.error?.code ?? null,
    terminationConfirmed: headless?.terminationConfirmed ?? null,
    durationMs: headless?.durationMs ?? null,
    usage:
      actual === null
        ? null
        : {
            promptTokens: actual.inputTokens,
            completionTokens: actual.outputTokens,
            costCNY: actual.costCNY,
          },
    runtimeReportedUsage: headless?.usage ?? null,
  };
  if (policyDenials.valid && policyDenials.value !== null) {
    agent.policyDenials = policyDenials.value;
  }
  return agent;
}

function classifyPrimary({ infra, adapter, agent, verifier, reward, policyIncident }) {
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
      if (policyIncident) return "policy_blocked";
      return reward >= 1 ? "passed" : "task_failed";
    default:
      return "adapter_error";
  }
}

function classifyVerifierOutcome({ verifier, reward }) {
  if (verifier.status === "completed") return reward >= 1 ? "passed" : "failed";
  if (verifier.status === "missing" || verifier.exceptionType === "VerifierEvidenceMissing") {
    return "missing";
  }
  return "error";
}

function classifyExecutionOutcome({ infra, adapter, agent }) {
  if (agent.terminationConfirmed === false || infra.status === "error") return "infra_error";
  if (adapter.status === "error") return "adapter_error";
  return agent.status;
}

function rate(count, total) {
  return total === 0 ? 0 : count / total;
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
    const bytes = await readFile(path);
    return { value: JSON.parse(bytes.toString("utf8")), error: null, bytes };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: null, error: null, bytes: null };
    if (error instanceof SyntaxError) return { value: null, error: "invalid_json", bytes: null };
    throw error;
  }
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
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
