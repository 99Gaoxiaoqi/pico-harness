import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  resolveCommandHookExecution,
  type ResolvedCommandHookInvocation,
} from "../hooks/config/referenced-scripts.js";
import type { HookTrustAuthority, HookTrustSubject } from "../hooks/trust/store.js";

export interface PluginHookTrustAuthorityOptions {
  readonly pluginId: string;
  readonly runtimeRoot: string;
  /** The installed resource digest which authorized this materialized tree. */
  readonly resourceDigest: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly isActive?: () => boolean;
}

export interface RevocablePluginHookTrustAuthority {
  readonly authority: HookTrustAuthority;
  revoke(): void;
}

/**
 * Bind executable plugin hooks to one verified, host-private materialized tree.
 *
 * PluginTrustStore authenticates the installed tree before materialization. This authority is the
 * second half of that contract: it never trusts an arbitrary `plugin` source, only a source under
 * the verified runtime root, and it is revoked before that root is removed. Command execution is
 * still resolved and revalidated through the normal Hook command safety layer.
 */
export function createPluginHookTrustAuthority(
  options: PluginHookTrustAuthorityOptions,
): RevocablePluginHookTrustAuthority {
  const runtimeRoot = resolve(options.runtimeRoot);
  if (!options.pluginId || !options.resourceDigest) {
    throw new Error("Plugin Hook trust authority 缺少 pluginId/resourceDigest");
  }
  let active = true;

  const matches = async (subject: HookTrustSubject): Promise<boolean> => {
    if (!active || options.isActive?.() === false) return false;
    if (subject.source.kind !== "plugin" || subject.source.componentId !== options.pluginId) {
      return false;
    }
    try {
      const sourcePath = await realpath(subject.source.path);
      return isWithin(runtimeRoot, sourcePath);
    } catch {
      return false;
    }
  };

  const resolveInvocation = async (
    subject: HookTrustSubject,
  ): Promise<ResolvedCommandHookInvocation | undefined> => {
    if (subject.handler.type !== "command" || !(await matches(subject))) return undefined;
    try {
      const invocation = await resolveCommandHookExecution(
        subject.handler,
        subject.workspace,
        options.env ?? process.env,
      );
      // A plugin may use the host interpreter (node/python/etc.), but every explicit code/data
      // file resolved from the handler must remain in the verified plugin tree. The resolver has
      // already rejected unsupported shell/package-manager indirection.
      if (
        invocation.referencedPaths.some((path) => !isWithin(runtimeRoot, path)) ||
        invocation.pathBindings.some(
          (binding) =>
            !isWithin(runtimeRoot, binding.logicalPath) &&
            !isTrustedRuntimeInterpreter(binding.canonicalPath),
        )
      ) {
        return undefined;
      }
      return invocation;
    } catch {
      return undefined;
    }
  };

  const authority: HookTrustAuthority = {
    identity: Object.freeze({
      kind: "plugin",
      pluginId: options.pluginId,
      resourceDigest: options.resourceDigest,
      runtimeRoot,
    }),
    async status(subject) {
      if (!(await matches(subject))) return "pending";
      if (subject.handler.type !== "command") return "active";
      return (await resolveInvocation(subject)) ? "active" : "pending";
    },
    async authorizeCommandExecution(subject) {
      if ((await authority.status(subject)) !== "active") return undefined;
      return await resolveInvocation(subject);
    },
  };

  return {
    authority,
    revoke() {
      active = false;
    },
  };
}

/** Exposed for diagnostics/tests; the digest is part of the immutable identity contract. */
export function pluginHookTrustIdentity(
  options: Pick<PluginHookTrustAuthorityOptions, "pluginId" | "resourceDigest">,
): string {
  return `${options.pluginId}@${options.resourceDigest}`;
}

function isTrustedRuntimeInterpreter(path: string): boolean {
  const name = path
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/u, "");
  return name === "node" || name === "nodejs" || name === "python" || name === "python3";
}

function isWithin(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
}
