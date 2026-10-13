import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import {
  createBashAnalysisBudget,
  initializeBashParser,
  parseBashScript,
} from "@pico/runtime/bash-parser";
import type { ExecutionCondition } from "@pico/core";
import type { ExecutionEvidenceIO } from "./execution-learning-evidence.js";

export interface NativeDependencyInstallation {
  readonly command: string;
  readonly cwd: string;
  readonly packageName: string;
  readonly manifestHash: string;
  readonly condition: Extract<ExecutionCondition, { kind: "node-package" }>;
}
/** Only one static local npm install has a deterministic package identity. */
export async function dependencyPreparation(
  command: string,
  cwd: string,
): Promise<{ command: string; cwd: string; packageName: string } | undefined> {
  const parsed = await preparationCommand(command, cwd);
  if (!parsed) return undefined;
  const { argv } = parsed;
  cwd = parsed.cwd;
  if (argv.length !== 3 || argv[0] !== "npm" || argv[1] !== "install") return undefined;
  const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@[a-z0-9.^~*+-]+)?$/u.exec(argv[2]!);
  return match ? { command, cwd: resolve(cwd), packageName: match[1]! } : undefined;
}
async function preparationCommand(
  command: string,
  cwd: string,
): Promise<{ argv: string[]; cwd: string; cd: boolean } | undefined> {
  if (/[;&|<>\n\r]/u.test(command.replaceAll("&&", ""))) return undefined;
  const segments = command.split("&&");
  if (segments.length > 2) return undefined;
  await initializeBashParser();
  const commands: string[][] = [];
  for (const segment of segments) {
    const parsed = parseBashScript(segment, createBashAnalysisBudget());
    if (
      parsed.ambiguous ||
      parsed.nestedCommands.length ||
      parsed.commands.length !== 1 ||
      parsed.commands[0]!.some((w) => w.dynamic || w.unquotedExpansion || w.outputRedirection)
    )
      return undefined;
    commands.push(parsed.commands[0]!.map((w) => w.value));
  }
  const first = commands[0]!;
  if (segments.length === 2) {
    if (first.length !== 2 || first[0] !== "cd" || !first[1] || first[1].startsWith("-"))
      return undefined;
    return { argv: commands[1]!, cwd: resolve(cwd, first[1]), cd: true };
  }
  return { argv: first, cwd: resolve(cwd), cd: false };
}
export async function cwdPreparation(
  command: string,
  cwd: string,
  io: ExecutionEvidenceIO,
): Promise<string | undefined> {
  const parsed = await preparationCommand(command, cwd);
  if (!parsed) return undefined;
  if (parsed.cd && parsed.argv.length === 1 && parsed.argv[0] === "pwd")
    return io.realpath(parsed.cwd);
  if (
    !parsed.cd &&
    parsed.argv.length === 2 &&
    parsed.argv[0] === "cd" &&
    parsed.argv[1] &&
    !parsed.argv[1].startsWith("-")
  )
    return io.realpath(resolve(cwd, parsed.argv[1]));
  return undefined;
}
export async function observeInstalledDependency(
  preparation: { command: string; cwd: string; packageName: string },
  io: ExecutionEvidenceIO,
): Promise<NativeDependencyInstallation | undefined> {
  try {
    const manifestPath = resolve(
      preparation.cwd,
      "node_modules",
      preparation.packageName,
      "package.json",
    );
    const canonical = await io.realpath(manifestPath);
    if (canonical !== manifestPath) return undefined;
    const raw = await io.readFile(canonical, 512 * 1024);
    if (!raw) return undefined;
    const bytes = typeof raw === "string" ? Buffer.from(raw) : raw;
    const manifest: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
    const data = manifest as Record<string, unknown>;
    if (
      Object.hasOwn(data, "exports") ||
      (Object.hasOwn(data, "main") && (typeof data.main !== "string" || !data.main))
    )
      return undefined;
    if (
      data.name !== preparation.packageName ||
      typeof data.version !== "string" ||
      !data.version ||
      data.version.length > 128
    )
      return undefined;
    const entryPath = resolve(
      manifestPath,
      "..",
      typeof data.main === "string" ? data.main : "index.js",
    );
    const rel = relative(resolve(manifestPath, ".."), entryPath);
    if (rel.startsWith("..") || isAbsolute(rel) || (await io.realpath(entryPath)) !== entryPath)
      return undefined;
    const entry = await io.readFile(entryPath, 512 * 1024);
    if (!entry) return undefined;
    return {
      ...preparation,
      manifestHash: createHash("sha256").update(bytes).digest("hex"),
      condition: {
        kind: "node-package",
        path: manifestPath,
        name: preparation.packageName,
        version: data.version,
        entryPath,
        entryHash: createHash("sha256").update(entry).digest("hex"),
      },
    };
  } catch {
    return undefined;
  }
}
