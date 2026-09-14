import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCliSessionArguments } from "@pico/cli";
import { resolveCliSession, type CliSessionSelection } from "@pico/cli/session-resolver";

export interface CliStartupSession {
  workDir: string;
  sessionSelection: CliSessionSelection;
}

export interface ResolveCliStartupSessionOptions {
  /**
   * 已经过宿主信任门校验的真实工作区路径。提供后不再从 argv 解析目录。
   */
  trustedWorkDir?: string;
}

export async function resolveCliStartupSession(
  args: readonly string[] = process.argv.slice(2),
  options: ResolveCliStartupSessionOptions = {},
): Promise<CliStartupSession> {
  const parsed = parseCliSessionArguments(args);
  const workDir = options.trustedWorkDir ?? (await resolveCliWorkDir(parsed.dir));
  const sessionSelection = await resolveCliSession({
    workDir,
    ...(parsed.continueSession ? { continueSession: true } : {}),
    ...(parsed.resumeSession ? { resumeSession: parsed.resumeSession } : {}),
    ...(parsed.forkSession ? { forkSession: parsed.forkSession } : {}),
  });

  return { workDir, sessionSelection };
}

export async function resolveCliWorkDir(dir: string | undefined): Promise<string> {
  const target = resolve(dir ?? process.cwd());
  await mkdir(target, { recursive: true });
  return realpath(target);
}
