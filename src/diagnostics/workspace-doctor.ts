import {
  runWorkspaceDoctor as runWorkspaceDoctorFromHost,
  type StorageDiagnosticPort,
  type WorkspaceDoctorOptions as HostWorkspaceDoctorOptions,
  type WorkspaceDoctorReport,
} from "@pico/pico-host/workspace-doctor";
import { StorageDoctor } from "@pico/pico-host/storage-doctor";

export { workspaceConfigurationDiagnosticFromRuntime } from "@pico/pico-host/workspace-configuration-diagnostic";
export type { WorkspaceConfigurationDiagnostic } from "@pico/pico-host/workspace-configuration-diagnostic";
export type {
  StorageDiagnosticComponent as StorageDoctorComponent,
  StorageDiagnosticFinding as StorageDoctorFinding,
  StorageDiagnosticPort,
  StorageDiagnosticReport as StorageDoctorReport,
  StorageDiagnosticSeverity as StorageDoctorSeverity,
  WorkspaceDiagnosticCheck,
  WorkspaceDiagnosticStatus,
  WorkspaceDoctorReport,
} from "@pico/pico-host/workspace-doctor";

export interface WorkspaceDoctorOptions extends Omit<HostWorkspaceDoctorOptions, "storageDoctor"> {
  /** Host-owned Pico state root. Omitted callers keep the CLI/process default. */
  readonly picoHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly storageDoctor?: StorageDiagnosticPort;
}

/** @deprecated Workspace Doctor 编排已迁入 @pico/pico-host。 */
export async function runWorkspaceDoctor(
  options: WorkspaceDoctorOptions,
): Promise<WorkspaceDoctorReport> {
  return runWorkspaceDoctorFromHost({
    ...options,
    storageDoctor:
      options.storageDoctor ??
      new StorageDoctor({
        workDir: options.workDir,
        ...(options.picoHome ? { picoHome: options.picoHome } : {}),
      }),
  });
}
