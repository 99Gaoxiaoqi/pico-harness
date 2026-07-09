import { spawnSync as defaultSpawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const TUI_SMOKE_CHECKS = [
  {
    label: "typecheck",
    args: ["run", "typecheck"],
  },
  {
    label: "tui-tests",
    args: ["run", "test", "--", "tests/tui/repl-input-routing.test.tsx", "tests/tui/app.test.tsx"],
  },
];

export function parseDotEnv(text) {
  const parsed = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const entry = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = entry.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    parsed[key] = stripEnvQuotes(entry.slice(equalsIndex + 1).trim());
  }

  return parsed;
}

export function validateProviderConfig(env) {
  const hasBaseUrl = hasValue(env.LLM_BASE_URL);
  const hasApiKey = hasValue(env.LLM_API_KEY) || hasValue(env.LLM_API_KEYS);

  if (!hasBaseUrl && !hasApiKey) {
    return "missing LLM_BASE_URL and LLM_API_KEY/LLM_API_KEYS in .env";
  }
  if (!hasBaseUrl) {
    return "missing LLM_BASE_URL in .env";
  }
  if (!hasApiKey) {
    return "missing LLM_API_KEY or LLM_API_KEYS in .env";
  }
  return null;
}

export function summarizeOutput(stdout, stderr) {
  const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
  const lines = stripAnsi(combined)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);

  if (lines.length === 0) {
    return "(no output)";
  }

  const summary = lines.join(" | ");
  return summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
}

export function runTuiSmoke(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const envPath = join(cwd, ".env");
  const log = options.log ?? ((line) => globalThis.console.log(line));
  const spawnSync = options.spawnSync ?? defaultSpawnSync;
  const envExists = options.envExists ?? existsSync;
  const readEnvFile = options.readEnvFile ?? ((path) => readFileSync(path, "utf8"));

  if (!envExists(envPath)) {
    log("SKIP tui smoke: missing .env");
    return 0;
  }

  const env = parseDotEnv(readEnvFile(envPath));
  const skipReason = validateProviderConfig(env);
  if (skipReason) {
    log(`SKIP tui smoke: ${skipReason}`);
    return 0;
  }

  let hasFailure = false;

  for (const check of TUI_SMOKE_CHECKS) {
    log(`RUN ${check.label}`);
    const result = spawnSync("npm", check.args, {
      cwd,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      stdio: "pipe",
    });
    const exitCode = typeof result.status === "number" ? result.status : 1;
    log(`EXIT ${check.label} ${exitCode}`);
    log(`SUMMARY ${check.label}: ${summarizeOutput(result.stdout, result.stderr)}`);

    if (result.error) {
      log(`ERROR ${check.label}: ${result.error.message}`);
    }
    if (exitCode !== 0) {
      hasFailure = true;
    }
  }

  return hasFailure ? 1 : 0;
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stripEnvQuotes(value) {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function stripAnsi(text) {
  const escape = String.fromCharCode(27);
  return text.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = runTuiSmoke();
}
