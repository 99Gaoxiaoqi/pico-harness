import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, resolve, sep } from "node:path";

const root = resolve(process.cwd());
const reportDirectory = join(root, "output/security");
const allowedPairs = new Map([
  ["braces|GHSA-vfj7-8cjw-p6xm", { version: "3.0.3", source: 1240992 }],
  ["node-forge|GHSA-86w9-cpqp-85rv", { version: "1.4.0", source: 1240912 }],
]);
const severityRanks = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function checkedPath(relativePath) {
  requireCondition(
    typeof relativePath === "string" &&
      relativePath.length > 0 &&
      !isAbsolute(relativePath) &&
      !relativePath.includes("\\") &&
      posix.normalize(relativePath) === relativePath &&
      !relativePath.split("/").includes(".."),
    "Invalid exception file path",
  );
  const absolute = join(root, relativePath);
  requireCondition(
    realpathSync(absolute).startsWith(realpathSync(root) + sep),
    "Exception files must belong to this installation",
  );
  return absolute;
}

function verifyHash(relativePath, expected) {
  requireCondition(
    typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected),
    "Invalid SHA-256 for " + relativePath,
  );
  const actual = createHash("sha256")
    .update(readFileSync(checkedPath(relativePath)))
    .digest("hex");
  requireCondition(actual === expected, "Patch or installed file differs: " + relativePath);
}

function loadVerifiedExceptions(lock) {
  const policy = readJson("scripts/dependency-audit-exceptions.json");
  requireCondition(
    object(policy) && policy.version === 1 && Array.isArray(policy.exceptions),
    "Invalid dependency audit exception policy",
  );
  const verified = new Map();
  for (const exception of policy.exceptions) {
    requireCondition(object(exception), "Invalid exception");
    const key = exception.package + "|" + exception.advisory;
    const allowed = allowedPairs.get(key);
    requireCondition(
      allowed &&
        exception.version === allowed.version &&
        exception.source === allowed.source &&
        !verified.has(key),
      "Unsupported or duplicate dependency audit exception: " + key,
    );
    requireCondition(
      typeof exception.expiresAt === "string" &&
        Number.isFinite(Date.parse(exception.expiresAt)) &&
        Date.now() < Date.parse(exception.expiresAt),
      "Expired dependency audit exception: " + key,
    );
    requireCondition(
      ["owner", "reason", "upstream", "advisoryRange", "integrity"].every(
        (field) => typeof exception[field] === "string" && exception[field].length > 0,
      ),
      "Incomplete dependency audit exception: " + key,
    );
    requireCondition(
      exception.patch === "patches/" + exception.package + "+" + exception.version + ".patch" &&
        Array.isArray(exception.installedPaths) &&
        exception.installedPaths.length > 0 &&
        new Set(exception.installedPaths).size === exception.installedPaths.length &&
        Array.isArray(exception.repairedFiles) &&
        exception.repairedFiles.length > 0,
      "Invalid patch installation contract: " + key,
    );
    verifyHash(exception.patch, exception.patchSha256);
    const patchFiles = readFileSync(checkedPath(exception.patch), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("+++ b/"))
      .map((line) => line.slice(6));
    const recordedFiles = exception.repairedFiles.map(
      (file) => exception.installedPaths[0] + "/" + file.path,
    );
    requireCondition(
      patchFiles.length > 0 &&
        patchFiles.length === recordedFiles.length &&
        new Set(recordedFiles).size === recordedFiles.length &&
        patchFiles.every((file) => recordedFiles.includes(file)),
      "Every patched source file must have an installed hash: " + key,
    );
    for (const nodePath of exception.installedPaths) {
      requireCondition(
        typeof nodePath === "string" &&
          nodePath.startsWith("node_modules/") &&
          nodePath.endsWith("/" + exception.package),
        "Invalid installation path: " + key,
      );
      const locked = lock.packages[nodePath];
      const installed = JSON.parse(readFileSync(checkedPath(nodePath + "/package.json"), "utf8"));
      requireCondition(
        object(locked) &&
          locked.version === exception.version &&
          locked.integrity === exception.integrity &&
          installed.name === exception.package &&
          installed.version === exception.version,
        "Exception version or integrity drift: " + nodePath,
      );
      for (const file of exception.repairedFiles) {
        requireCondition(object(file), "Invalid repaired file: " + key);
        verifyHash(nodePath + "/" + file.path, file.sha256);
      }
    }
    verified.set(key, exception);
  }
  return verified;
}

function collectLeaves(vulnerabilities) {
  const leaves = new Map();
  const reachable = new Map();
  const edges = new Map();
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    requireCondition(
      object(vulnerability) &&
        vulnerability.name === name &&
        severityRanks.has(vulnerability.severity) &&
        Array.isArray(vulnerability.nodes) &&
        vulnerability.nodes.length > 0 &&
        vulnerability.nodes.every((node) => typeof node === "string") &&
        Array.isArray(vulnerability.via) &&
        vulnerability.via.length > 0,
      "Invalid audit vulnerability: " + name,
    );
    const own = new Set();
    const references = [];
    for (const via of vulnerability.via) {
      if (typeof via === "string") {
        requireCondition(
          Object.hasOwn(vulnerabilities, via),
          "Unresolved audit dependency: " + name + " -> " + via,
        );
        references.push(via);
        continue;
      }
      requireCondition(
        object(via) &&
          Number.isSafeInteger(via.source) &&
          via.name === name &&
          via.dependency === name &&
          severityRanks.has(via.severity) &&
          typeof via.range === "string" &&
          typeof via.url === "string" &&
          /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(
            via.url,
          ),
        "Unknown audit advisory format: " + name,
      );
      const id = name + "|" + via.source + "|" + via.url;
      requireCondition(!leaves.has(id), "Duplicate audit advisory: " + id);
      leaves.set(id, { name, advisory: via, nodes: vulnerability.nodes });
      own.add(id);
    }
    reachable.set(name, own);
    edges.set(name, references);
  }
  // A fixed point resolves npm's cyclic meta-vulnerability graph without losing leaves.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, references] of edges) {
      const current = reachable.get(name);
      for (const reference of references) {
        for (const id of reachable.get(reference)) {
          if (!current.has(id)) {
            current.add(id);
            changed = true;
          }
        }
      }
    }
  }
  for (const [name, ids] of reachable) {
    requireCondition(ids.size > 0, "Audit dependency cycle has no resolved advisory: " + name);
  }
  return { leaves, reachable };
}

function main() {
  requireCondition(typeof process.env.npm_execpath === "string", "Run npm run audit:check");
  const audit = spawnSync(
    process.execPath,
    [process.env.npm_execpath, "audit", "--json", "--audit-level=low"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, "dependency-audit.json"), audit.stdout ?? "");
  requireCondition(
    !audit.error && !audit.signal && [0, 1].includes(audit.status),
    "Dependency audit could not complete; raw output was retained",
  );
  const report = JSON.parse(audit.stdout);
  requireCondition(
    object(report) &&
      report.auditReportVersion === 2 &&
      !report.error &&
      object(report.vulnerabilities) &&
      object(report.metadata) &&
      object(report.metadata.vulnerabilities),
    "Invalid dependency audit response",
  );
  const total = Object.keys(report.vulnerabilities).length;
  const counts = report.metadata.vulnerabilities;
  requireCondition(
    ["info", "low", "moderate", "high", "critical", "total"].every(
      (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
    ) &&
      counts.total === total &&
      ["info", "low", "moderate", "high", "critical"].reduce((sum, key) => sum + counts[key], 0) ===
        total,
    "Inconsistent dependency audit counts",
  );
  const hasFindings = counts.low + counts.moderate + counts.high + counts.critical > 0;
  requireCondition(audit.status === (hasFindings ? 1 : 0), "Inconsistent npm audit exit status");
  const lock = readJson("package-lock.json");
  requireCondition(object(lock) && object(lock.packages), "Missing dependency lock");
  const verified = loadVerifiedExceptions(lock);
  const { leaves, reachable } = collectLeaves(report.vulnerabilities);
  const used = new Set();
  const failures = [];
  for (const leaf of leaves.values()) {
    if (severityRanks.get(leaf.advisory.severity) < 1) continue;
    const ghsa = leaf.advisory.url.split("/").at(-1);
    const key = leaf.name + "|" + ghsa;
    const exception = verified.get(key);
    if (
      !exception ||
      leaf.advisory.source !== exception.source ||
      leaf.advisory.range !== exception.advisoryRange ||
      leaf.nodes.length !== exception.installedPaths.length ||
      !leaf.nodes.every((node) => exception.installedPaths.includes(node))
    ) {
      failures.push(key);
    } else used.add(key);
  }
  for (const key of verified.keys()) {
    requireCondition(used.has(key), "Unused audit exception must be removed: " + key);
  }
  requireCondition(
    failures.length === 0,
    "Unexcepted dependency advisories: " + failures.join(", "),
  );
  requireCondition(
    [...reachable.entries()].every(
      ([name, ids]) =>
        severityRanks.get(report.vulnerabilities[name].severity) < 1 ||
        [...ids].some((id) => severityRanks.get(leaves.get(id).advisory.severity) >= 1),
    ),
    "Unresolved audit severity inheritance",
  );
  console.log(
    "[dependency-audit] passed: " +
      used.size +
      " verified temporary patch exceptions; " +
      total +
      " affected package entries retained in output/security/dependency-audit.json",
  );
}

try {
  main();
} catch (error) {
  console.error("[dependency-audit] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
