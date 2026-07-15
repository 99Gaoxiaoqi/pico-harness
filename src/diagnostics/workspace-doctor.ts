import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionCatalogProjectionHealth } from "../storage/session-catalog-projection.js";
import { readSessionCatalogProjectionHealth } from "../storage/session-catalog-projection.js";
import {
  STORAGE_DOCTOR_COMPONENTS,
  StorageDoctor,
  type StorageDoctorFinding,
  type StorageDoctorReport,
} from "../storage/storage-doctor.js";
import type { MemoryBackendStatus } from "../memory/memory-store.js";

export type WorkspaceDiagnosticStatus = "ok" | "warning" | "error" | "unavailable";

export interface WorkspaceDiagnosticCheck {
  readonly id: string;
  readonly label: string;
  readonly status: WorkspaceDiagnosticStatus;
  readonly summary: string;
  readonly recommendation?: string;
}

export interface WorkspaceDoctorReport {
  readonly workspacePath: string;
  readonly healthy: boolean;
  readonly checks: readonly WorkspaceDiagnosticCheck[];
  readonly output: string;
}

export interface WorkspaceDoctorOptions {
  readonly workDir: string;
  readonly provider: string;
  readonly model: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly catalogHealth?: SessionCatalogProjectionHealth;
  readonly taskRuntimeAvailable?: boolean;
  readonly taskRuntimeDiagnostic?: string;
  readonly memoryStatus?: MemoryBackendStatus;
  readonly storageDoctor?: Pick<StorageDoctor, "scan">;
  readonly configuration?: WorkspaceConfigurationDiagnostic;
}

export interface WorkspaceConfigurationDiagnostic {
  readonly defaultModelRouteId?: string;
  readonly defaultSource?: string;
  readonly providerSources: Readonly<Record<string, string>>;
  readonly credentialStates: Readonly<Record<string, string>>;
}

/** Shared read-only `/doctor` domain operation. It never repairs, rebuilds, or runs GC. */
export async function runWorkspaceDoctor(
  options: WorkspaceDoctorOptions,
): Promise<WorkspaceDoctorReport> {
  const env = options.env ?? process.env;
  const envPath = join(options.workDir, ".env");
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  const nodeOk = nodeMajor >= 22;
  const cwdOk = existsSync(options.workDir);
  const apiKeys = readApiKeys(env);
  const effectiveProviderCount = Object.keys(options.configuration?.providerSources ?? {}).length;
  const effectiveCredentialCount = Object.values(
    options.configuration?.credentialStates ?? {},
  ).filter((state) => state === "environment" || state === "keychain").length;
  const catalogHealth =
    options.catalogHealth ?? (await readSessionCatalogProjectionHealth(options.workDir));
  const storage = await scanStorage(options);
  const checks: WorkspaceDiagnosticCheck[] = [
    check("cwd", "CWD", cwdOk ? "ok" : "error", `${options.workDir} (${cwdOk ? "ok" : "missing"})`),
    check(
      "env-file",
      ".env",
      existsSync(envPath) ? "ok" : "warning",
      existsSync(envPath) ? "found" : "missing",
    ),
    check("provider", "Provider", options.provider ? "ok" : "error", options.provider || "missing"),
    check("model", "Model", options.model ? "ok" : "error", options.model || "missing"),
    configurationCheck(options.configuration),
    check(
      "base-url",
      "LLM_BASE_URL",
      env["LLM_BASE_URL"] || effectiveProviderCount > 0 ? "ok" : "warning",
      env["LLM_BASE_URL"]
        ? "set in environment"
        : effectiveProviderCount > 0
          ? "provided by effective configuration"
          : "missing",
    ),
    check(
      "api-key",
      "LLM_API_KEY[S]",
      apiKeys.length > 0 || effectiveCredentialCount > 0 ? "ok" : "warning",
      apiKeys.length > 0
        ? `${apiKeys.length} configured in environment`
        : effectiveCredentialCount > 0
          ? `${effectiveCredentialCount} available from effective configuration`
          : "missing",
    ),
    check(
      "node",
      "Node",
      nodeOk ? "ok" : "error",
      `${process.version} (${nodeOk ? "ok" : "requires >=22.0.0"})`,
    ),
    check(
      "session-catalog",
      "Session catalog",
      catalogHealth.state === "healthy"
        ? "ok"
        : catalogHealth.state === "stale"
          ? "warning"
          : "error",
      catalogHealth.state,
      catalogHealth.state === "healthy" ? undefined : catalogHealth.recommendation,
    ),
    check(
      "task-runtime",
      "Task runtime",
      options.taskRuntimeAvailable ? "ok" : "unavailable",
      options.taskRuntimeAvailable ? "healthy" : "unavailable",
      options.taskRuntimeDiagnostic,
    ),
    memoryCheck(options.memoryStatus),
    storageCheck(storage.report, storage.error),
  ];
  const output = [
    `CWD: ${options.workDir} (${cwdOk ? "ok" : "missing"})`,
    `.env: ${existsSync(envPath) ? "found" : "missing"}`,
    `Provider: ${options.provider}`,
    `Model: ${options.model}${env["LLM_MODEL"] && env["LLM_MODEL"] !== options.model ? ` (env: ${env["LLM_MODEL"]})` : ""}`,
    ...renderConfiguration(options.configuration),
    `LLM_BASE_URL: ${
      env["LLM_BASE_URL"]
        ? "set in environment"
        : effectiveProviderCount > 0
          ? "provided by effective configuration"
          : "missing"
    }`,
    `LLM_API_KEY[S]: ${
      apiKeys.length > 0
        ? `${apiKeys.length} configured in environment`
        : effectiveCredentialCount > 0
          ? `${effectiveCredentialCount} available from effective configuration`
          : "missing"
    }`,
    `Node: ${process.version} (${nodeOk ? "ok" : "requires >=22.0.0"})`,
    `Session catalog: ${catalogHealth.state}`,
    ...(catalogHealth.diagnostic ? [`Session catalog reason: ${catalogHealth.diagnostic}`] : []),
    ...(catalogHealth.state !== "healthy"
      ? [`Session catalog recommendation: ${catalogHealth.recommendation}`]
      : []),
    `Task runtime: ${options.taskRuntimeAvailable ? "healthy" : "unavailable"}`,
    ...(options.taskRuntimeDiagnostic
      ? [`Task runtime reason: ${options.taskRuntimeDiagnostic}`]
      : []),
    ...renderMemoryBackend(options.memoryStatus),
    ...renderStorage(storage.report, storage.error),
  ].join("\n");
  return {
    workspacePath: options.workDir,
    healthy: checks.every((item) => item.status !== "error"),
    checks: Object.freeze(checks),
    output,
  };
}

function configurationCheck(
  configuration: WorkspaceConfigurationDiagnostic | undefined,
): WorkspaceDiagnosticCheck {
  if (!configuration) return check("configuration", "Configuration", "unavailable", "legacy");
  const providerCount = Object.keys(configuration.providerSources).length;
  return check(
    "configuration",
    "Configuration",
    providerCount > 0 ? "ok" : "warning",
    `${providerCount} provider(s); default source=${configuration.defaultSource ?? "built-in"}`,
  );
}

function renderConfiguration(
  configuration: WorkspaceConfigurationDiagnostic | undefined,
): string[] {
  if (!configuration) return ["Configuration sources: legacy environment diagnostics only"];
  const providers = Object.entries(configuration.providerSources);
  return [
    `Configuration default: ${configuration.defaultModelRouteId ?? "none"} (source=${configuration.defaultSource ?? "built-in"})`,
    `Configuration providers: ${
      providers.length > 0
        ? providers
            .map(
              ([id, source]) =>
                `${id}=${source}/credential-${configuration.credentialStates[id] ?? "unknown"}`,
            )
            .join(", ")
        : "none"
    }`,
  ];
}

function check(
  id: string,
  label: string,
  status: WorkspaceDiagnosticStatus,
  summary: string,
  recommendation?: string,
): WorkspaceDiagnosticCheck {
  return { id, label, status, summary, ...(recommendation ? { recommendation } : {}) };
}

function memoryCheck(status: MemoryBackendStatus | undefined): WorkspaceDiagnosticCheck {
  if (!status) return check("memory", "Memory", "unavailable", "no live session");
  return check(
    "memory",
    "Memory",
    status.state === "healthy" ? "ok" : "warning",
    `${status.backend} (${status.state}; source=${status.persistentSource})`,
    status.recommendation,
  );
}

function storageCheck(
  report: StorageDoctorReport | undefined,
  error: string | undefined,
): WorkspaceDiagnosticCheck {
  if (!report) {
    return check(
      "storage",
      "Storage",
      "unavailable",
      error ?? "diagnostic unavailable",
      "retry /doctor after checking storage permissions; no repair or GC was run",
    );
  }
  return check(
    "storage",
    "Storage",
    report.healthy ? "ok" : "error",
    report.healthy ? "healthy" : "degraded",
  );
}

async function scanStorage(options: WorkspaceDoctorOptions): Promise<{
  report?: StorageDoctorReport;
  error?: string;
}> {
  try {
    return {
      report: await (
        options.storageDoctor ?? new StorageDoctor({ workDir: options.workDir })
      ).scan(),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function renderMemoryBackend(status: MemoryBackendStatus | undefined): string[] {
  if (!status) return ["Memory: unavailable (no live session)"];
  return [
    `Memory: ${status.backend} (${status.state}; source=${status.persistentSource})`,
    `Memory runtime: ${status.nodeVersion}; ABI ${status.nodeModuleAbi ?? "unknown"}`,
    ...(status.reason ? [`Memory reason: ${status.reason}`] : []),
    ...(status.recommendation ? [`Memory recommendation: ${status.recommendation}`] : []),
  ];
}

function renderStorage(
  report: StorageDoctorReport | undefined,
  error: string | undefined,
): string[] {
  if (!report) {
    return [
      "Storage: diagnostic unavailable",
      `Storage diagnostic: ${error ?? "unknown error"}`,
      "Storage recommendation: retry /doctor after checking storage permissions; no repair or GC was run.",
    ];
  }
  const severityCounts = {
    critical: countStorageFindings(report.findings, "critical"),
    error: countStorageFindings(report.findings, "error"),
    warning: countStorageFindings(report.findings, "warning"),
  };
  const sessionTruthHealthy = !report.findings.some(
    (finding) =>
      finding.component === "session" &&
      (finding.severity === "critical" || finding.severity === "error"),
  );
  const priorityFindings = report.findings
    .filter((finding) => finding.severity !== "info")
    .slice(0, 5);
  return [
    `Storage: ${report.healthy ? "healthy" : "degraded"}`,
    `Storage scanned: ${STORAGE_DOCTOR_COMPONENTS.map(
      (component) => `${component}=${report.scanned[component]}`,
    ).join(", ")}`,
    `Storage severity: critical=${severityCounts.critical}, error=${severityCounts.error}, warning=${severityCounts.warning}`,
    `Storage Session truth: ${sessionTruthHealthy ? "healthy" : "degraded"} (scanned=${report.scanned.session})`,
    ...priorityFindings.flatMap((finding, index) => [
      `Storage finding ${index + 1}: [${finding.severity}/${finding.component}/${finding.code}] ${finding.message} (${finding.path})`,
      `Storage recommendation ${index + 1}: ${finding.recommendation}`,
    ]),
  ];
}

function countStorageFindings(
  findings: readonly StorageDoctorFinding[],
  severity: StorageDoctorFinding["severity"],
): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function readApiKeys(env: Readonly<Record<string, string | undefined>>): string[] {
  const multi = env["LLM_API_KEYS"]
    ?.split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (multi && multi.length > 0) return multi;
  const single = env["LLM_API_KEY"]?.trim();
  return single ? [single] : [];
}
