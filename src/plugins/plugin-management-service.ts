import { PluginManager, type InstalledPlugin } from "./plugin-manager.js";
import { resolvePluginContributions } from "./plugin-resolver.js";
import {
  PluginTrustStore,
  type PluginTrustProposal,
  type PluginTrustStatus,
} from "./plugin-trust.js";
import type { PluginContributionSet, PluginScope } from "./plugin-types.js";

export interface PluginReference {
  readonly id: string;
  readonly scope: PluginScope;
}

export interface ManagedPluginInspection {
  readonly installed: InstalledPlugin;
  readonly contributions: PluginContributionSet;
  readonly trust: PluginTrustStatus;
  readonly changedSinceInstall: boolean;
  readonly active: boolean;
}

export interface PluginManagementServiceOptions {
  readonly workDir: string;
  readonly manager?: PluginManager;
  readonly trustStore?: PluginTrustStore;
  readonly picoHome?: string;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class PluginManagementService {
  private readonly manager: PluginManager;
  private readonly trustStore: PluginTrustStore;

  constructor(options: PluginManagementServiceOptions) {
    this.manager = options.manager ?? new PluginManager(options);
    this.trustStore = options.trustStore ?? new PluginTrustStore(options);
  }

  async install(path: string, scope: PluginScope) {
    return await this.manager.installFromDirectory(path, scope);
  }

  async list(): Promise<readonly ManagedPluginInspection[]> {
    return await Promise.all(
      (await this.manager.list()).map((plugin) => this.inspectInstalled(plugin)),
    );
  }

  async inspect(reference: PluginReference): Promise<ManagedPluginInspection> {
    return await this.inspectInstalled(await this.requireInstalled(reference));
  }

  async prepareTrust(reference: PluginReference): Promise<PluginTrustProposal> {
    const inspection = await this.inspect(reference);
    if (
      inspection.contributions.compatibility === "blocked" ||
      !inspection.contributions.fingerprint
    ) {
      throw new Error(
        `Plugin ${reference.id} 当前不可信任: ${inspection.contributions.compatibility}`,
      );
    }
    if (inspection.changedSinceInstall) {
      const refreshed = await this.manager.installFromDirectory(
        inspection.installed.installPath,
        inspection.installed.scope,
      );
      if (!refreshed.success) throw new Error(refreshed.message);
    }
    return await this.trustStore.prepare(await this.requireInstalled(reference));
  }

  async trust(proposal: PluginTrustProposal): Promise<void> {
    const reference = { id: proposal.pluginId, scope: proposal.scope } satisfies PluginReference;
    const fresh = await this.prepareTrust(reference);
    if (fresh.id !== proposal.id || fresh.resourceDigest !== proposal.resourceDigest) {
      throw new Error("Plugin 内容在确认期间发生变化，请重新 inspect/trust");
    }
    await this.trustStore.trust(fresh);
  }

  async enable(reference: PluginReference): Promise<void> {
    const inspection = await this.inspect(reference);
    if (inspection.changedSinceInstall) throw new Error("Plugin 内容已变化，请重新 trust");
    if (inspection.trust !== "active") throw new Error("Plugin 尚未信任，请先执行 trust");
    const result = await this.manager.enable(reference.id, reference.scope);
    if (!result.success) throw new Error(result.message);
  }

  async disable(reference: PluginReference): Promise<void> {
    const result = await this.manager.disable(reference.id, reference.scope);
    if (!result.success) throw new Error(result.message);
  }

  async activeContributions(): Promise<readonly PluginContributionSet[]> {
    const plugins = await this.list();
    return plugins.filter((plugin) => plugin.active).map((plugin) => plugin.contributions);
  }

  private async inspectInstalled(plugin: InstalledPlugin): Promise<ManagedPluginInspection> {
    const contributions = await resolvePluginContributions(plugin.installPath);
    const changedSinceInstall =
      contributions.fingerprint?.digest !== plugin.resourceFingerprint.digest;
    const trust = changedSinceInstall ? "pending" : await this.trustStore.status(plugin);
    return Object.freeze({
      installed: plugin,
      contributions,
      trust,
      changedSinceInstall,
      active:
        plugin.enabled &&
        trust === "active" &&
        !changedSinceInstall &&
        contributions.compatibility !== "blocked",
    });
  }

  private async requireInstalled(reference: PluginReference): Promise<InstalledPlugin> {
    const plugin = (await this.manager.list()).find(
      (item) => item.id === reference.id && item.scope === reference.scope,
    );
    if (!plugin) throw new Error(`Plugin ${reference.id} is not installed in ${reference.scope}`);
    return plugin;
  }
}
