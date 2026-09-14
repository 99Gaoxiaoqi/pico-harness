import type { PermissionSessionScope } from "@pico/runtime/session-permission-policy";

/** Runtime 进程内 grant store 的最小写入能力。 */
export interface PermissionSessionGrantStore {
  addNetwork(sessionId: string, workDir: string, picoHome?: string): void;
  add(sessionId: string, workDir: string, scope: PermissionSessionScope, picoHome?: string): void;
}

/** 产品宿主对目录授权的写入能力。 */
export interface PermissionDirectoryAuthority {
  addDirectory(directory: string): Promise<{ path: string }>;
}

/** 产品宿主对 session 设置的读写投影。 */
export interface PermissionSessionSettingsPort<TSettings> {
  additionalDirectories(settings: TSettings): readonly string[] | undefined;
  setAdditionalDirectories(settings: TSettings, directories: readonly string[]): void;
  enableAutoEdits(settings: TSettings): void;
}

/**
 * 将结构化授权投影为 Pico session 设置与已授权目录。
 *
 * Runtime 持有授权的构造、匹配与进程内 state；本层只处理产品会话的持久设置投影。
 */
export async function applySessionPermissionScope<TSettings>(
  scope: PermissionSessionScope,
  options: {
    sessionId: string;
    workDir: string;
    settings: TSettings;
    workspaceRoots: PermissionDirectoryAuthority;
    settingsPort: PermissionSessionSettingsPort<TSettings>;
    grants: PermissionSessionGrantStore;
    picoHome?: string;
  },
): Promise<void> {
  if (scope.type === "network") {
    options.grants.addNetwork(options.sessionId, options.workDir, options.picoHome);
    return;
  }
  if (scope.type === "directories") {
    const added: string[] = [];
    for (const directory of scope.directories) {
      const result = await options.workspaceRoots.addDirectory(directory);
      added.push(result.path);
    }
    const existingDirectories = options.settingsPort.additionalDirectories(options.settings);
    if (existingDirectories !== undefined) {
      options.settingsPort.setAdditionalDirectories(options.settings, [
        ...existingDirectories,
        ...added,
      ]);
    }
    if (scope.enableAutoEdits) options.settingsPort.enableAutoEdits(options.settings);
  } else if (scope.type === "all-edits") {
    options.settingsPort.enableAutoEdits(options.settings);
  }
  // all-edits 由权威 permissionMode=auto 表达，directory 由 WorkspaceRoots 表达；
  // 仅无法投影到这两者的规则进入结构化 grant store。
  if (scope.type !== "all-edits" && scope.type !== "directories") {
    options.grants.add(options.sessionId, options.workDir, scope, options.picoHome);
  }
}
