export type PluginScope = "user" | "project" | "local";

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  [key: string]: unknown;
}

export interface PluginOperationResult {
  success: boolean;
  message: string;
  pluginId?: string;
  pluginName?: string;
  scope?: PluginScope;
}

export interface InstalledPlugin {
  id: string;
  scope: PluginScope;
  manifest: PluginManifest;
  installPath: string;
  enabled: boolean;
}
