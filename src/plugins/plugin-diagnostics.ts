import type {
  PluginCompatibility,
  PluginDiagnostic,
  PluginDiagnosticSeverity,
  PluginScope,
} from "./plugin-types.js";

export type PluginDiagnosticOrigin = "resolver" | "scope" | "materialization" | "runtime";

export interface PluginDiagnosticInput {
  readonly origin: PluginDiagnosticOrigin;
  readonly pluginId?: string;
  readonly scope?: PluginScope;
  readonly code?: string;
  readonly severity?: PluginDiagnosticSeverity;
  readonly compatibility?: PluginCompatibility;
  readonly path?: string;
  readonly sourcePath?: string;
  readonly message: string;
}

/** Stable cross-surface diagnostic shape consumed by CLI, TUI and Desktop adapters. */
export interface PluginDiagnosticRecord {
  readonly id: string;
  readonly origin: PluginDiagnosticOrigin;
  readonly pluginId?: string;
  readonly scope?: PluginScope;
  readonly code: string;
  readonly severity: PluginDiagnosticSeverity;
  readonly compatibility: PluginCompatibility;
  readonly path?: string;
  readonly message: string;
}

export interface PluginDiagnosticSummary {
  readonly records: readonly PluginDiagnosticRecord[];
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly blocked: number;
  readonly text: string;
}

export interface PluginMaterializationDiagnosticLike {
  readonly pluginId: string;
  readonly sourcePath: string;
  readonly message: string;
  readonly code?: string;
  readonly scope?: PluginScope;
}

export interface PluginRuntimeDiagnosticLike {
  readonly pluginId: string;
  readonly sourcePath: string;
  readonly message: string;
  readonly code?: string;
  readonly scope?: PluginScope;
}

/** Convert resolver diagnostics into the common surface contract. */
export function fromPluginDiagnostics(
  pluginId: string,
  diagnostics: readonly PluginDiagnostic[],
  scope?: PluginScope,
): readonly PluginDiagnosticRecord[] {
  return normalizePluginDiagnostics(
    diagnostics.map((diagnostic) => ({
      origin: diagnostic.code.startsWith("plugin_scope_") ? "scope" : "resolver",
      pluginId,
      ...(scope ? { scope } : {}),
      code: diagnostic.code,
      severity: diagnostic.severity,
      compatibility: diagnostic.compatibility,
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
      message: diagnostic.message,
    })),
  );
}

/** Convert service materialization failures without coupling this module to the service layer. */
export function fromMaterializationDiagnostics(
  diagnostics: readonly PluginMaterializationDiagnosticLike[],
): readonly PluginDiagnosticRecord[] {
  return normalizePluginDiagnostics(
    diagnostics.map((diagnostic) => ({
      origin: "materialization" as const,
      pluginId: diagnostic.pluginId,
      ...(diagnostic.scope ? { scope: diagnostic.scope } : {}),
      code: diagnostic.code ?? "plugin_materialization_failed",
      severity: "error" as const,
      compatibility: "blocked" as const,
      path: diagnostic.sourcePath,
      message: diagnostic.message,
    })),
  );
}

/** Convert runtime contribution failures without importing the runtime snapshot implementation. */
export function fromRuntimeDiagnostics(
  diagnostics: readonly PluginRuntimeDiagnosticLike[],
): readonly PluginDiagnosticRecord[] {
  return normalizePluginDiagnostics(
    diagnostics.map((diagnostic) => ({
      origin: "runtime" as const,
      pluginId: diagnostic.pluginId,
      ...(diagnostic.scope ? { scope: diagnostic.scope } : {}),
      code: diagnostic.code ?? "plugin_runtime_contribution_invalid",
      severity: "warning" as const,
      compatibility: "degraded" as const,
      path: diagnostic.sourcePath,
      message: diagnostic.message,
    })),
  );
}

/** Normalize, deduplicate and freeze records while preserving producer order. */
export function normalizePluginDiagnostics(
  diagnostics: readonly PluginDiagnosticInput[],
): readonly PluginDiagnosticRecord[] {
  const seen = new Set<string>();
  const records: PluginDiagnosticRecord[] = [];
  for (const input of diagnostics) {
    const message = compactMessage(input.message);
    const code = input.code?.trim() || defaultCode(input.origin);
    const path = input.path ?? input.sourcePath;
    const id = diagnosticId(input.origin, input.pluginId, input.scope, code, path, message);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push(
      Object.freeze({
        id,
        origin: input.origin,
        ...(input.pluginId ? { pluginId: input.pluginId } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        code,
        severity: input.severity ?? defaultSeverity(input.origin),
        compatibility: input.compatibility ?? defaultCompatibility(input.origin),
        ...(path ? { path } : {}),
        message,
      }),
    );
  }
  return Object.freeze(records);
}

/** Stable plain text for terminal/TUI surfaces; no ANSI or locale-dependent formatting. */
export function formatPluginDiagnostics(
  diagnostics: readonly PluginDiagnosticRecord[],
  emptyText = "- none",
): readonly string[] {
  if (diagnostics.length === 0) return Object.freeze([emptyText]);
  return Object.freeze(
    diagnostics.map((diagnostic) => {
      const owner = [diagnostic.pluginId, diagnostic.scope].filter(Boolean).join(" ");
      const location = diagnostic.path ? ` · ${diagnostic.path}` : "";
      return `- [${diagnostic.severity}] ${diagnostic.code}${owner ? ` (${owner})` : ""}: ${diagnostic.message}${location}`;
    }),
  );
}

export function summarizePluginDiagnostics(
  diagnostics: readonly PluginDiagnosticRecord[],
): PluginDiagnosticSummary {
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  const infos = diagnostics.filter((item) => item.severity === "info").length;
  const blocked = diagnostics.filter((item) => item.compatibility === "blocked").length;
  return Object.freeze({
    records: diagnostics,
    errors,
    warnings,
    infos,
    blocked,
    text: formatPluginDiagnostics(diagnostics).join("\n"),
  });
}

function diagnosticId(
  origin: PluginDiagnosticOrigin,
  pluginId: string | undefined,
  scope: PluginScope | undefined,
  code: string,
  path: string | undefined,
  message: string,
): string {
  return [origin, pluginId ?? "", scope ?? "", code, path ?? "", message].join("\0");
}

function compactMessage(message: string): string {
  return message.replace(/\s+/gu, " ").trim();
}

function defaultCode(origin: PluginDiagnosticOrigin): string {
  switch (origin) {
    case "resolver":
      return "plugin_resolution_failed";
    case "scope":
      return "plugin_scope_invalid";
    case "materialization":
      return "plugin_materialization_failed";
    case "runtime":
      return "plugin_runtime_contribution_invalid";
  }
}

function defaultSeverity(origin: PluginDiagnosticOrigin): PluginDiagnosticSeverity {
  return origin === "runtime" ? "warning" : origin === "resolver" ? "warning" : "error";
}

function defaultCompatibility(origin: PluginDiagnosticOrigin): PluginCompatibility {
  return origin === "runtime" ? "degraded" : origin === "resolver" ? "degraded" : "blocked";
}
