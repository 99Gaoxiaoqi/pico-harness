import {
  prepareStorageRootIdentityRepair,
  repairStorageRootIdentity,
  resolveStorageRoot,
  StorageRootAuthorityError,
} from "@pico/runtime-host";

export interface DesktopRuntimeStorageRecoveryOptions {
  readonly rootPath: string;
  readonly confirmRepair: (storagePath: string) => Promise<boolean>;
}

/**
 * Runs before the first Runtime request, while Electron can show native UI but the daemon may not
 * exist yet. Only an identity collision is repairable here; malformed or foreign markers remain
 * fail-closed. The branded, one-shot candidate keeps confirmation separate from mutation.
 */
export async function ensureDesktopRuntimeStorageRoot(
  options: DesktopRuntimeStorageRecoveryOptions,
): Promise<boolean> {
  try {
    await resolveStorageRoot({ path: options.rootPath, kind: "interactive" });
    return true;
  } catch (error) {
    if (!(error instanceof StorageRootAuthorityError) || error.code !== "root_identity_collision") {
      throw error;
    }
  }

  const candidate = await prepareStorageRootIdentityRepair({
    path: options.rootPath,
    kind: "interactive",
  });
  if (!candidate) return true;
  if (!(await options.confirmRepair(candidate.canonicalPath))) return false;
  await repairStorageRootIdentity(candidate);
  return true;
}
