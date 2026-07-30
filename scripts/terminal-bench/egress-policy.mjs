export const publicEgressProxyPolicyVersion = 1;

export const publicEgressLimits = Object.freeze({
  maxConnections: 32,
  maxRequests: 4_096,
  maxTotalBytes: 1_073_741_824,
  connectionTimeoutSec: 120,
  maxAuditDecisions: 256,
  allowedHttpPorts: Object.freeze([80]),
  allowedConnectPorts: Object.freeze([443]),
});

export const publicEgressDnsPolicy = Object.freeze({
  mode: "pinned-doh",
  host: "cloudflare-dns.com",
  endpointIps: Object.freeze(["1.1.1.1", "1.0.0.1"]),
  systemFallback: false,
  ipv4Only: true,
});

const taskNamePattern = /^terminal-bench\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function parseTaskAllowInternet(taskToml, taskName) {
  assertTaskName(taskName);
  if (typeof taskToml !== "string") {
    throw policyError(taskName, "task.toml is unavailable");
  }
  const sanitized = maskTomlStringsAndComments(taskToml, taskName);
  let currentSection = null;
  let environmentSectionCount = 0;
  const assignments = [];
  for (const rawLine of sanitized.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("[")) {
      const section = line.match(/^\[\s*([A-Za-z0-9_-]+)\s*\]$/u);
      currentSection = section?.[1] ?? null;
      if (currentSection === "environment") environmentSectionCount += 1;
      continue;
    }
    if (currentSection !== "environment") continue;
    const assignment = line.match(/^allow_internet\s*=\s*(.*)$/u);
    if (assignment !== null) assignments.push(assignment[1]);
  }
  if (environmentSectionCount !== 1) {
    throw policyError(taskName, "task.toml must define exactly one [environment] section");
  }
  if (assignments.length !== 1) {
    throw policyError(taskName, "task.toml [environment] must define exactly one allow_internet");
  }
  if (assignments[0] === "true") return true;
  if (assignments[0] === "false") return false;
  throw policyError(taskName, "task.toml allow_internet must be the boolean true or false");
}

export function buildEgressPolicyManifest(tasks, egressPolicyByTask) {
  if (
    !Array.isArray(tasks) ||
    tasks.length === 0 ||
    new Set(tasks).size !== tasks.length ||
    tasks.some((taskName) => !taskNamePattern.test(taskName))
  ) {
    throw new Error("Terminal-Bench egress manifest tasks are invalid");
  }
  if (
    egressPolicyByTask === null ||
    typeof egressPolicyByTask !== "object" ||
    Array.isArray(egressPolicyByTask)
  ) {
    throw new Error("Terminal-Bench egress policy map is invalid");
  }
  const policyTaskNames = Object.keys(egressPolicyByTask);
  if (
    policyTaskNames.length !== tasks.length ||
    policyTaskNames.some((taskName) => !tasks.includes(taskName))
  ) {
    throw new Error("Terminal-Bench egress policy map does not match the exact task list");
  }
  return {
    proxyPolicyVersion: publicEgressProxyPolicyVersion,
    limits: {
      maxConnections: publicEgressLimits.maxConnections,
      maxRequests: publicEgressLimits.maxRequests,
      maxTotalBytes: publicEgressLimits.maxTotalBytes,
      connectionTimeoutSec: publicEgressLimits.connectionTimeoutSec,
      maxAuditDecisions: publicEgressLimits.maxAuditDecisions,
      allowedHttpPorts: [...publicEgressLimits.allowedHttpPorts],
      allowedConnectPorts: [...publicEgressLimits.allowedConnectPorts],
    },
    dns: {
      mode: publicEgressDnsPolicy.mode,
      host: publicEgressDnsPolicy.host,
      endpointIps: [...publicEgressDnsPolicy.endpointIps],
      systemFallback: publicEgressDnsPolicy.systemFallback,
      ipv4Only: publicEgressDnsPolicy.ipv4Only,
    },
    tasks: tasks.map((taskName) => {
      const policy = egressPolicyByTask[taskName];
      if (
        policy === null ||
        typeof policy !== "object" ||
        Array.isArray(policy) ||
        Object.keys(policy).length !== 1 ||
        !Object.hasOwn(policy, "allowInternet") ||
        typeof policy.allowInternet !== "boolean"
      ) {
        throw new Error(`Terminal-Bench egress policy entry is invalid: ${taskName}`);
      }
      return { taskName, allowInternet: policy.allowInternet };
    }),
  };
}

function maskTomlStringsAndComments(source, taskName) {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextThree = source.slice(index, index + 3);
    if (state === "comment") {
      if (character === "\n" || character === "\r") {
        state = "code";
        result += character;
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "basic") {
      if (character === "\\") {
        result += " ";
        if (index + 1 < source.length) {
          index += 1;
          result += " ";
        }
      } else if (character === '"') {
        state = "code";
        result += " ";
      } else if (character === "\n" || character === "\r") {
        throw policyError(taskName, "task.toml contains an unterminated string");
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "literal") {
      if (character === "'") {
        state = "code";
        result += " ";
      } else if (character === "\n" || character === "\r") {
        throw policyError(taskName, "task.toml contains an unterminated string");
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "multiline-basic") {
      if (nextThree === '"""') {
        state = "code";
        result += "   ";
        index += 2;
      } else if (character === "\\") {
        result += " ";
        if (index + 1 < source.length) {
          index += 1;
          result += source[index] === "\n" || source[index] === "\r" ? source[index] : " ";
        }
      } else {
        result += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (state === "multiline-literal") {
      if (nextThree === "'''") {
        state = "code";
        result += "   ";
        index += 2;
      } else {
        result += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (character === "#") {
      state = "comment";
      result += " ";
    } else if (nextThree === '"""') {
      state = "multiline-basic";
      result += "   ";
      index += 2;
    } else if (nextThree === "'''") {
      state = "multiline-literal";
      result += "   ";
      index += 2;
    } else if (character === '"') {
      state = "basic";
      result += " ";
    } else if (character === "'") {
      state = "literal";
      result += " ";
    } else {
      result += character;
    }
  }
  if (state !== "code" && state !== "comment") {
    throw policyError(taskName, "task.toml contains an unterminated string");
  }
  return result;
}

function assertTaskName(taskName) {
  if (typeof taskName !== "string" || !taskNamePattern.test(taskName)) {
    throw new Error("Terminal-Bench egress policy task name is invalid");
  }
}

function policyError(taskName, message) {
  return new Error(`Terminal-Bench egress policy is invalid for ${taskName}: ${message}`);
}
