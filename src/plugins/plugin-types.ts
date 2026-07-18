export type PluginScope = "user" | "project" | "local";

export type PluginManifestSource =
  | "pico-native"
  | "claude-compatible"
  | "legacy-root"
  | "manifestless";

export type PluginCompatibility = "compatible" | "degraded" | "blocked";

export type PluginDiagnosticSeverity = "info" | "warning" | "error";

export type PluginContributionKind =
  | "skill"
  | "command"
  | "agent"
  | "hook"
  | "mcp"
  | "lsp"
  | "capability";

/**
 * Declarative extension only. A plugin never supplies a module path or
 * executable here; the host resolves the id/version through a trusted factory.
 */
export interface PluginCapabilityDeclaration {
  readonly id: string;
  readonly version: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export type PluginCapabilityKind = "provider" | "tool";

export type PluginCapabilityDeclarationInput =
  | PluginCapabilityDeclaration
  | readonly PluginCapabilityDeclaration[];

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly compatibility: PluginCompatibility;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly component?: PluginContributionKind | "manifest" | "resources";
}

export type PluginPathDeclaration = string | readonly string[];
export type PluginConfigDeclaration =
  | string
  | Readonly<Record<string, unknown>>
  | readonly (string | Readonly<Record<string, unknown>>)[];

/** Claude/Pico plugin manifest 的最小公共子集。未识别字段保留供诊断和向后兼容。 */
export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly skills?: PluginPathDeclaration;
  readonly commands?: PluginPathDeclaration;
  readonly agents?: PluginPathDeclaration;
  readonly hooks?: PluginConfigDeclaration;
  readonly mcpServers?: PluginConfigDeclaration;
  readonly lspServers?: PluginConfigDeclaration;
  readonly capabilities?: PluginCapabilityDeclarationInput;
  readonly [key: string]: unknown;
}

export interface ResolvedPluginIdentity {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly version?: string;
  readonly description?: string;
  readonly root: string;
  readonly manifestPath?: string;
  readonly manifestSource: PluginManifestSource;
}

export type PluginContributionOrigin = "default" | "manifest" | "root-skill";

export interface PluginPathContribution {
  readonly kind: "skill" | "command" | "agent";
  readonly pluginId: string;
  readonly namespace: string;
  readonly path: string;
  readonly sourcePath: string;
  readonly origin: PluginContributionOrigin;
}

export interface PluginConfigContribution {
  readonly kind: "hook" | "mcp" | "lsp";
  readonly pluginId: string;
  readonly namespace: string;
  readonly sourcePath: string;
  readonly origin: "default" | "manifest";
  readonly path?: string;
  readonly inline?: Readonly<Record<string, unknown>>;
}

export interface PluginResourceFingerprint {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface PluginContributionSet {
  readonly plugin: ResolvedPluginIdentity;
  readonly manifest: PluginManifest;
  readonly compatibility: PluginCompatibility;
  readonly diagnostics: readonly PluginDiagnostic[];
  readonly skills: readonly PluginPathContribution[];
  readonly commands: readonly PluginPathContribution[];
  readonly agents: readonly PluginPathContribution[];
  readonly hooks: readonly PluginConfigContribution[];
  readonly mcpServers: readonly PluginConfigContribution[];
  readonly lspServers: readonly PluginConfigContribution[];
  readonly fingerprint?: PluginResourceFingerprint;
}

export interface PluginVariableMap {
  readonly CLAUDE_PLUGIN_ROOT: string;
  readonly CLAUDE_PLUGIN_DATA: string;
  readonly CLAUDE_PROJECT_DIR: string;
  readonly PICO_PLUGIN_ROOT: string;
  readonly PICO_PLUGIN_DATA: string;
  readonly PICO_PROJECT_DIR: string;
}
