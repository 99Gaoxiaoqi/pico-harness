export interface ToolResultSummaryInput {
  toolName: string;
  arguments: string;
  output: string;
  isError?: boolean;
  maxChars?: number;
}

export interface ToolResultSummary {
  text: string;
  strategy: string;
  originalChars: number;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 1600;

export function summarizeToolResult(input: ToolResultSummaryInput): ToolResultSummary {
  const maxChars = normalizeMaxChars(input.maxChars);
  const parsedArgs = parseJsonObject(input.arguments);
  const command = readString(parsedArgs, "command");
  const toolName = input.toolName.trim();

  if (isBashTool(toolName)) {
    if (isTscOutput(command, input.output)) {
      return summarizeDiagnosticLines(input, "bash-tsc", maxChars, isTscLine, 1);
    }
    if (isTestOutput(command, input.output, input.isError ?? false)) {
      return summarizeDiagnosticLines(input, "bash-test", maxChars, isTestLine, 2);
    }
    if (hasLine(input.output, isLogErrorLine)) {
      return summarizeDiagnosticLines(input, "bash-error-lines", maxChars, isLogErrorLine, 0);
    }
  }

  if (isTscTool(toolName) || isTscOutput(command, input.output)) {
    return summarizeDiagnosticLines(input, "bash-tsc", maxChars, isTscLine, 1);
  }

  if (isReadFileTool(toolName)) {
    return summarizeReadFile(input, maxChars, readString(parsedArgs, "path") ?? "(unknown)");
  }

  if (isRgTool(toolName, command)) {
    return summarizeRg(input, maxChars);
  }

  return summarizeHeadTail(input, "fallback-head-tail", maxChars, [
    `tool: ${toolName || "(unknown)"}`,
    `originalChars: ${input.output.length}`,
  ]);
}

function normalizeMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined || !Number.isFinite(maxChars)) {
    return DEFAULT_MAX_CHARS;
  }
  return Math.max(0, Math.floor(maxChars));
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function isBashTool(toolName: string): boolean {
  return toolName === "bash";
}

function isTscTool(toolName: string): boolean {
  return toolName === "tsc";
}

function isReadFileTool(toolName: string): boolean {
  return toolName === "read_file";
}

function isRgTool(toolName: string, command: string | undefined): boolean {
  if (toolName === "rg") {
    return true;
  }
  return Boolean(command?.trim().match(/^(?:npx\s+)?rg\b/));
}

function isTscOutput(command: string | undefined, output: string): boolean {
  const commandLooksLikeTsc = Boolean(command?.match(/\b(?:tsc|typecheck)\b/));
  const outputLooksLikeTsc =
    /TS\d{4}/.test(output) && /\S+\.(?:ts|tsx|mts|cts):\d+:\d+/.test(output);
  return commandLooksLikeTsc || outputLooksLikeTsc;
}

function isTestOutput(command: string | undefined, output: string, isError: boolean): boolean {
  const commandLooksLikeTest = Boolean(
    command?.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b/),
  );
  const outputLooksLikeTest =
    /\bFAIL\b|AssertionError|Test Files\s+.*failed|Tests\s+.*failed/i.test(output);
  return commandLooksLikeTest || (isError && outputLooksLikeTest) || outputLooksLikeTest;
}

function isTscLine(line: string): boolean {
  return /TS\d{4}/.test(line) || /^Found \d+ errors?\b/i.test(line);
}

function isTestLine(line: string): boolean {
  return (
    /\bFAIL\b/i.test(line) ||
    /\bfailed\b/i.test(line) ||
    /AssertionError/.test(line) ||
    /\bError(?::|\b)/.test(line) ||
    /^\s+at .+:\d+:\d+/.test(line) ||
    /^Test Files\b/.test(line) ||
    /^Tests\b/.test(line)
  );
}

function isLogErrorLine(line: string): boolean {
  return /\b(?:CRITICAL|FATAL|ERROR|ERR|PANIC|Exception|Traceback|Unhandled|E_[A-Z0-9_]+)\b/i.test(
    line,
  );
}

function hasLine(output: string, matcher: (line: string) => boolean): boolean {
  return output.split(/\r?\n/).some(matcher);
}

function summarizeDiagnosticLines(
  input: ToolResultSummaryInput,
  strategy: string,
  maxChars: number,
  matcher: (line: string) => boolean,
  radius: number,
): ToolResultSummary {
  const selected = selectContextLines(input.output, matcher, radius);
  const compactSelected = selectContextLines(input.output, matcher, 0);
  const header = [`strategy: ${strategy}`, `originalChars: ${input.output.length}`];
  const selectedText = selected.join("\n");
  const compactSelectedText = compactSelected.join("\n");
  const selectedBody =
    joinWithHeader(header, selectedText).length <= maxChars ? selectedText : compactSelectedText;
  if (selectedBody.length > 0) {
    return finish(
      input,
      strategy,
      joinWithHeader(header, selectedBody),
      selectedBody !== input.output,
      maxChars,
    );
  }

  const fallback = buildHeadTailText(input.output, header, maxChars);
  return finish(input, strategy, fallback.text, fallback.truncated, maxChars);
}

function selectContextLines(
  output: string,
  matcher: (line: string) => boolean,
  radius: number,
): string[] {
  const lines = output.split(/\r?\n/);
  const indexes = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!matcher(lines[i] ?? "")) {
      continue;
    }
    const start = Math.max(0, i - radius);
    const end = Math.min(lines.length - 1, i + radius);
    for (let j = start; j <= end; j++) {
      indexes.add(j);
    }
  }

  const out: string[] = [];
  let previous = -1;
  for (const index of [...indexes].sort((a, b) => a - b)) {
    if (previous !== -1 && index > previous + 1) {
      out.push(`... ${index - previous - 1} lines omitted ...`);
    }
    out.push(lines[index] ?? "");
    previous = index;
  }
  return out;
}

function summarizeReadFile(
  input: ToolResultSummaryInput,
  maxChars: number,
  path: string,
): ToolResultSummary {
  const header = [
    "strategy: read_file-head-tail",
    `path: ${path}`,
    `originalChars: ${input.output.length}`,
  ];
  const { text, truncated } = buildHeadTailText(input.output, header, maxChars);
  return finish(input, "read_file-head-tail", text, truncated, maxChars);
}

function summarizeRg(input: ToolResultSummaryInput, maxChars: number): ToolResultSummary {
  if (input.output.length <= maxChars) {
    return finish(input, "rg-original", input.output, false, maxChars);
  }

  const lines = input.output.split(/\r?\n/).filter((line) => line.length > 0);
  const header = ["strategy: rg-first-matches", `matches: ${lines.length}`];
  const selected: string[] = [];
  let used = header.join("\n").length + 1;
  for (const line of lines) {
    const nextCost = line.length + 1;
    if (used + nextCost > maxChars) {
      break;
    }
    selected.push(line);
    used += nextCost;
  }
  const body = selected.length > 0 ? selected.join("\n") : input.output.slice(0, maxChars);
  return finish(input, "rg-first-matches", joinWithHeader(header, body), true, maxChars);
}

function summarizeHeadTail(
  input: ToolResultSummaryInput,
  strategy: string,
  maxChars: number,
  header: string[],
): ToolResultSummary {
  const { text, truncated } = buildHeadTailText(
    input.output,
    [`strategy: ${strategy}`, ...header],
    maxChars,
  );
  return finish(input, strategy, text, truncated, maxChars);
}

function buildHeadTailText(
  output: string,
  headerLines: string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const prefix = `${headerLines.join("\n")}\n`;
  if (prefix.length + output.length <= maxChars) {
    return { text: `${prefix}${output}`, truncated: false };
  }

  const markerBase = "\n...[omitted]...\n";
  const available = maxChars - prefix.length - markerBase.length;
  if (available <= 0) {
    return { text: fitToBudget(prefix, maxChars), truncated: true };
  }

  const headChars = Math.ceil(available / 2);
  const tailChars = available - headChars;
  const omittedChars = Math.max(0, output.length - headChars - tailChars);
  const marker = `\n...[omitted ${omittedChars} chars]...\n`;
  const adjustedAvailable = Math.max(0, maxChars - prefix.length - marker.length);
  const adjustedHeadChars = Math.ceil(adjustedAvailable / 2);
  const adjustedTailChars = adjustedAvailable - adjustedHeadChars;
  const tail = adjustedTailChars > 0 ? output.slice(-adjustedTailChars) : "";
  return {
    text: `${prefix}${output.slice(0, adjustedHeadChars)}${marker}${tail}`,
    truncated: true,
  };
}

function joinWithHeader(headerLines: string[], body: string): string {
  const header = headerLines.join("\n");
  return body.length > 0 ? `${header}\n${body}` : header;
}

function finish(
  input: ToolResultSummaryInput,
  strategy: string,
  text: string,
  truncated: boolean,
  maxChars: number,
): ToolResultSummary {
  const fitted = fitToBudget(text, maxChars);
  return {
    text: fitted,
    strategy,
    originalChars: input.output.length,
    truncated: truncated || fitted.length < text.length,
  };
}

function fitToBudget(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  const marker = "\n...[truncated]...\n";
  if (maxChars <= marker.length) {
    return text.slice(0, maxChars);
  }
  const available = maxChars - marker.length;
  const headChars = Math.ceil(available / 2);
  const tailChars = available - headChars;
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  return `${text.slice(0, headChars)}${marker}${tail}`;
}
