import { createHash } from "node:crypto";
import { constants, statSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

/** Identify the executable without running it or reading its contents. */
export function executableFingerprint(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) return undefined;
    return createHash("sha256")
      .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":"))
      .digest("hex");
  } catch {
    return undefined;
  }
}

export async function currentExecutionRunner(
  argv0: string,
  cwd: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<{ execPath: string; fingerprint: string } | undefined> {
  const paths =
    isAbsolute(argv0) || argv0.includes("/")
      ? [resolve(cwd, argv0)]
      : (env.PATH ?? "").split(delimiter).map((dir) => resolve(cwd, dir, argv0));
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      const physical = await realpath(path);
      const fingerprint = executableFingerprint(physical);
      if (fingerprint) return { execPath: physical, fingerprint };
    } catch {
      // Follow the same PATH order as the foreground shell.
    }
  }
  return undefined;
}
