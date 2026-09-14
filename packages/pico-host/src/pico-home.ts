import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Device-local Pico state root used by Host-owned file surfaces. */
export function resolveHostPicoHome(picoHome: string | undefined): string {
  return resolve(picoHome?.trim() || process.env["PICO_HOME"]?.trim() || join(homedir(), ".pico"));
}
