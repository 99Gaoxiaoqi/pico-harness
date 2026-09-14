import { existsSync } from "node:fs";
import { join } from "node:path";
import { isSupportedNodeVersion, NODE_RUNTIME_SUPPORT_LABEL } from "@pico/runtime";
import type { WorkspaceConfigurationDiagnostic } from "./workspace-configuration-diagnostic.js";

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

export const STORAGE_DIAGNOSTIC_COMPONENTS = [
  "session",
  "runtime",
  "task",
  "operation",
  "file_history",
  "projection",
] as const;

export type StorageDiagnosticComponent = (typeof STORAGE_DIAGNOSTIC_COMPONENTS)[number];
export type StorageDiagnosticSeverity = "info" | "warning" | "error" | "critical";

export interface StorageDiagnosticFinding {
  readonly code: string;
  readonly severity: StorageDiagnosticSeverity;
  readonly component: StorageDiagnosticComponent;
  readonly path: string;
  readonly message: string;
  readonly recommendation: string;
}

export interface StorageDiagnosticReport {
  readonly healthy: boolean;
  readonly findings: readonly StorageDiagnosticFinding[];
  readonly scanned: Readonly<Record<StorageDiagnosticComponent, number>>;
}

/** Host composes a read-only storage diagnostic implementation through this narrow port. */
export interface StorageDiagnosticPort {
  scan(): Promise<StorageDiagnosticReport>;
}

export interface WorkspaceDoctorOptions {
  readonly workDir: string;
  readonly provider: string;
  readonly model: string;
  readonly taskRuntimeAvailable?: boolean;
  readonly taskRuntimeDiagnostic?: string;
  readonly storageDoctor?: StorageDiagnosticPort;
  readonly configuration?: WorkspaceConfigurationDiagnostic;
}

/** Shared read-only `/doctor` domain operation. It never repairs, rebuilds, or runs GC. */
export async function runWorkspaceDoctor(
  options: WorkspaceDoctorOptions,
): Promise<WorkspaceDoctorReport> {
  const envPath = join(options.workDir, ".env");
  const nodeOk = isSupportedNodeVersion(process.versions.node);
  const nodeSummary = `${process.version} (${nodeOk ? "ok" : `requires ${NODE_RUNTIME_SUPPORT_LABEL}`})`;
  const cwdOk = existsSync(options.workDir);
  const defaultProviderId = options.configuration?.defaultProviderId;
  const defaultProviderSource = defaultProviderId
    ? options.configuration?.providerSources[defaultProviderId]
    : undefined;
  const defaultCredentialState =
    (defaultProviderId ? options.configuration?.credentialStates[defaultProviderId] : undefined) ??
    "missing";
  const defaultCredentialAvailable = ["none", "config", "environment", "keychain"].includes(
    defaultCredentialState,
  );
  const storage = await scanStorage(options.storageDoctor);
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
      "Provider routes",
      defaultProviderSource ? "ok" : "warning",
      defaultProviderSource
        ? `${defaultProviderId} provided by ${defaultProviderSource} configuration`
        : `missing for ${defaultProviderId ?? "default provider"}`,
    ),
    check(
      "api-key",
      "Provider credentials",
      defaultCredentialAvailable ? "ok" : "warning",
      defaultCredentialAvailable
        ? `${defaultProviderId} available from ${defaultCredentialState}`
        : `missing for ${defaultProviderId ?? "default provider"}`,
    ),
    check("node", "Node", nodeOk ? "ok" : "error", nodeSummary),
    runtimeLedgerCheck(storage.report, storage.error),
    check(
      "task-runtime",
      "Task runtime",
      options.taskRuntimeAvailable ? "ok" : "unavailable",
      options.taskRuntimeAvailable ? "healthy" : "unavailable",
      options.taskRuntimeDiagnostic,
    ),
    storageCheck(storage.report, storage.error),
  ];
  const output = [
    `CWD: ${options.workDir} (${cwdOk ? "ok" : "missing"})`,
    `.env: ${existsSync(envPath) ? "found" : "missing"}`,
    `Provider: ${options.provider}`,
    `Model: ${options.model}`,
    ...renderConfiguration(options.configuration),
    `Provider routes: ${
      defaultProviderSource
        ? `${defaultProviderId} provided by ${defaultProviderSource} configuration`
        : `missing for ${defaultProviderId ?? "default provider"}`
    }`,
    `Provider credentials: ${
      defaultCredentialAvailable
        ? `${defaultProviderId} available from ${defaultCredentialState}`
        : `missing for ${defaultProviderId ?? "default provider"}`
    }`,
    `Node: ${nodeSummary}`,
    ...renderRuntimeLedger(storage.report, storage.error),
    `Task runtime: ${options.taskRuntimeAvailable ? "healthy" : "unavailable"}`,
    ...(options.taskRuntimeDiagnostic
      ? [`Task runtime reason: ${options.taskRuntimeDiagnostic}`]
      : []),
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
  if (!configuration) return check("configuration", "Configuration", "unavailable", "missing");
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
  if (!configuration) return ["Configuration sources: unavailable"];
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

function runtimeLedgerCheck(
  report: StorageDiagnosticReport | undefined,
  error: string | undefined,
): WorkspaceDiagnosticCheck {
  if (!report) {
    return check(
      "runtime-ledger",
      "Runtime ledger",
      "unavailable",
      error ?? "diagnostic unavailable",
      "retry /doctor after checking the workspace runtime storage permissions",
    );
  }
  const findings = runtimeLedgerFindings(report);
  const status = findings.some(
    (finding) => finding.severity === "critical" || finding.severity === "error",
  )
    ? "error"
    : findings.some((finding) => finding.severity === "warning")
      ? "warning"
      : "ok";
  return check(
    "runtime-ledger",
    "Runtime ledger",
    status,
    `${report.scanned.session} session(s); ${report.scanned.runtime > 0 ? "schema present" : "not created"}`,
    findings[0]?.recommendation,
  );
}

function storageCheck(
  report: StorageDiagnosticReport | undefined,
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

async function scanStorage(storageDoctor: StorageDiagnosticPort | undefined): Promise<{
  report?: StorageDiagnosticReport;
  error?: string;
}> {
  if (!storageDoctor) return { error: "diagnostic unavailable" };
  try {
    return { report: await storageDoctor.scan() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function renderRuntimeLedger(
  report: StorageDiagnosticReport | undefined,
  error: string | undefined,
): string[] {
  if (!report) return [`Runtime ledger: unavailable (${error ?? "unknown error"})`];
  const findings = runtimeLedgerFindings(report);
  return [
    `Runtime ledger: ${findings.length === 0 ? "healthy" : "degraded"} (${report.scanned.session} session(s))`,
    ...findings
      .slice(0, 3)
      .flatMap((finding) => [
        `Runtime ledger finding: [${finding.severity}/${finding.code}] ${finding.message}`,
        `Runtime ledger recommendation: ${finding.recommendation}`,
      ]),
  ];
}

function runtimeLedgerFindings(
  report: StorageDiagnosticReport,
): readonly StorageDiagnosticFinding[] {
  return report.findings.filter(
    (finding) => finding.component === "runtime" || finding.component === "session",
  );
}

function renderStorage(
  report: StorageDiagnosticReport | undefined,
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
    `Storage scanned: ${STORAGE_DIAGNOSTIC_COMPONENTS.map(
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
  findings: readonly StorageDiagnosticFinding[],
  severity: StorageDiagnosticSeverity,
): number {
  return findings.filter((finding) => finding.severity === severity).length;
}
