import { classifyHardlineBashCommand, type HardlineBashReasonKind } from "./bash-hardline.js";
import { hostShellDialect, type HostShellDialect } from "./host-shell.js";
import { classifyPowerShellHardlineCommand } from "./powershell-safety.js";

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

/** Fail closed when the host shell cannot safely interpret a bash command. */
export function classifyHardlineCommand(
  toolName: string,
  args: string,
  workDir?: string,
): HardlineReasonKind | undefined {
  if (toolName !== "bash") return undefined;
  let dialect: HostShellDialect;
  try {
    dialect = hostShellDialect();
  } catch {
    return "unknown_hardline";
  }
  const command = parseBashCommand(args);
  if (command === undefined) return "unknown_hardline";
  return dialect === "powershell"
    ? classifyPowerShellHardlineCommand(command)
    : classifyHardlineBashCommand(command, workDir);
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
