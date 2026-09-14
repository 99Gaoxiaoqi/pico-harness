import { parseArgs } from "node:util";

/** CLI 入口到 Session resolver 之间的纯 argv 适配结果。 */
export interface ParsedCliSessionArguments {
  readonly dir?: string;
  readonly continueSession: boolean;
  readonly resumeSession?: string;
  readonly forkSession?: string;
}

export function parseCliSessionArguments(args: readonly string[]): ParsedCliSessionArguments {
  const { values } = parseArgs({
    args: [...args],
    strict: false,
    options: {
      dir: { type: "string" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "S" },
      fork: { type: "string" },
    },
  });
  return {
    ...(typeof values.dir === "string" ? { dir: values.dir } : {}),
    continueSession: values["continue"] === true,
    ...(typeof values.resume === "string" ? { resumeSession: values.resume } : {}),
    ...(typeof values["fork"] === "string" ? { forkSession: values["fork"] } : {}),
  };
}
