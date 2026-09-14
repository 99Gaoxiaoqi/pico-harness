import {
  canonicalSessionEntryKey,
  claimSessionManagerKey,
  registerSessionDrain,
  releaseSessionManagerKey,
  sessionDrains,
} from "@pico/runtime/session-manager-state";
import { resolvePicoPaths } from "./pico-paths.js";

export { claimSessionManagerKey, registerSessionDrain, releaseSessionManagerKey, sessionDrains };

/** @deprecated Runtime state lives in @pico/runtime; this adapter resolves a Pico workspace root. */
export function sessionEntryKey(
  id: string,
  workDir: string,
  picoHome?: string,
  runtimeStorageRoot?: string,
): string {
  return canonicalSessionEntryKey(
    runtimeStorageRoot ??
      resolvePicoPaths(workDir, picoHome === undefined ? {} : { picoHome }).workspace.root,
    id,
  );
}
