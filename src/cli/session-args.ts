import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveCliSession, type CliSessionSelection } from "./session-resolver.js";

export interface CliStartupSession {
  workDir: string;
  sessionSelection: CliSessionSelection;
}

export async function resolveCliStartupSession(
  args: readonly string[] = process.argv.slice(2),
): Promise<CliStartupSession> {
  const { values } = parseArgs({
    args: [...args],
    strict: false,
    options: {
      dir: { type: "string" },
      session: { type: "string", short: "S" },
      "continue": { type: "boolean", short: "c" },
      resume: { type: "string" },
      "fork": { type: "string" },
      "fork-session": { type: "string" },
    },
  });
  const workDir = await resolveCliWorkDir(
    typeof values.dir === "string" ? values.dir : undefined,
  );
  const sessionSelection = await resolveCliSession({
    workDir,
    ...(typeof values.session === "string" ? { session: values.session } : {}),
    ...(values["continue"] === true ? { continueSession: true } : {}),
    ...(typeof values.resume === "string" ? { resumeSession: values.resume } : {}),
    ...(typeof values["fork"] === "string"
      ? { forkSession: values["fork"] }
      : typeof values["fork-session"] === "string"
        ? { forkSession: values["fork-session"] }
        : {}),
  });

  return { workDir, sessionSelection };
}

export async function resolveCliWorkDir(dir: string | undefined): Promise<string> {
  const target = resolve(dir ?? process.cwd());
  await mkdir(target, { recursive: true });
  return realpath(target);
}
