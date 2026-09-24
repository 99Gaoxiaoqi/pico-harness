import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolveSquirrelUpdaterPath(executablePath: string): string {
  // An MSIX-launched installer can see a virtual LocalAppData path that Explorer
  // cannot. Squirrel derives shortcut targets/icons from its own executable path.
  return realpathSync.native(resolve(dirname(executablePath), "..", "Update.exe"));
}
