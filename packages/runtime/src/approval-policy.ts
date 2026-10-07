import {
  analyzeHardlineBashCommand,
  type BashHardlineAnalysis,
  type HardlineBashReasonKind,
} from "./bash-hardline.js";
import { hostShellDialect } from "./host-shell.js";
import { analyzePowerShellHardlineCommand } from "./powershell-safety.js";

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bfind\b.*(-delete|-exec\s+rm)/i,
  /\bunlink\b/i,
  /\bsudo\b/i,
  /\b(drop|truncate)\s+/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{/,
  /\bchmod\s+(-R\s+)?0?777\b/i,
  />\s*[^|]*\.(ts|js|go|py|rs|java|c|cpp|h)\s*$/i,
  /\bkubectl\s+delete\b/i,
  /\bgit\s+push\s+(-f|--force)\b/i,
  /\bkill(all|-9)?\s+-?9?\b/i,
  /\bnginx\s+-s\b/i,
  /\bsystemctl\b/i,
  /\bcat\s+.*\s*>\s*\/(etc|usr|bin|boot|sys|proc)\b/i,
];

/** Conservative depth-in-defense signal; no match is never an authorization decision. */
export function isDangerousCommand(toolName: string, args: string): boolean {
  if (toolName !== "bash" && toolName !== "write_file" && toolName !== "edit_file") return false;
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(args));
}

export type HardlineReasonKind = HardlineBashReasonKind;

export function classifyHardlineCommand(
  toolName: string,
  args: string,
  workDir?: string,
): HardlineReasonKind | undefined {
  const analysis = analyzeHardlineCommand(toolName, args, workDir);
  return analysis.kind === "deny" ? analysis.reasonKind : undefined;
}

export function analyzeHardlineCommand(
  toolName: string,
  args: string,
  workDir?: string,
): BashHardlineAnalysis {
  if (toolName !== "bash") return { kind: "no_match" };
  const dialect = hostShellDialect();
  const command = parseBashCommand(args);
  if (command === undefined) return { kind: "unknown", reasonKind: "unknown_hardline" };
  return dialect === "powershell"
    ? analyzePowerShellHardlineCommand(command)
    : analyzeHardlineBashCommand(command, workDir);
}

export function isHardlineCommand(toolName: string, args: string, workDir?: string): boolean {
  return classifyHardlineCommand(toolName, args, workDir) !== undefined;
}

function parseBashCommand(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}
