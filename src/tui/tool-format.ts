const TARGET_KEYS = [
  "path",
  "file_path",
  "command",
  "query",
  "pattern",
  "url",
  "glob",
  "task",
  "goal",
] as const;

export function compactToolName(name: string): string {
  if (name === "bash") return "bash";
  if (name === "read_file") return "read";
  if (name === "write_file") return "write";
  if (name === "edit_file") return "edit";
  if (name === "search_tools") return "search";
  if (name === "web_search") return "web";
  if (name === "delegate_task") return "agents";
  if (name === "delegate_status") return "agents";
  return name;
}

export function summarizeToolTarget(name: string, args: string, maxWidth = 56): string | undefined {
  const parsed = parseJsonObject(args);
  if (!parsed) return undefined;

  const groupedCount =
    typeof parsed["groupedCount"] === "number" ? parsed["groupedCount"] : undefined;
  if (groupedCount && groupedCount > 1) return `${groupedCount} calls`;

  const raw = targetValue(name, parsed);
  if (!raw) return undefined;
  return name === "bash" ? compactCommand(raw, maxWidth) : compactText(raw, maxWidth);
}

export function compactCommand(command: string, maxWidth = 56): string {
  const oneLine = normalizeSpace(command);
  const curlTarget = summarizeCurlTarget(oneLine);
  return compactText(curlTarget ?? oneLine, maxWidth);
}

export function compactText(value: string, maxWidth = 80): string {
  const text = normalizeSpace(value);
  if (maxWidth <= 1) return text.slice(0, Math.max(0, maxWidth));
  if (text.length <= maxWidth) return text;

  const keep = maxWidth - 1;
  const head = Math.ceil(keep * 0.62);
  const tail = keep - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function targetValue(name: string, parsed: Record<string, unknown>): string | undefined {
  if (name === "bash") return stringField(parsed, "command");
  if (name === "read_file" || name === "write_file" || name === "edit_file") {
    return stringField(parsed, "path") ?? stringField(parsed, "file_path");
  }
  if (name === "grep") return stringField(parsed, "pattern") ?? stringField(parsed, "path");
  if (name === "glob") return stringField(parsed, "pattern") ?? stringField(parsed, "glob");
  if (name === "web_search" || name === "search_tools") return stringField(parsed, "query");
  if (name === "delegate_task") return stringField(parsed, "goal") ?? stringField(parsed, "task");

  for (const key of TARGET_KEYS) {
    const value = stringField(parsed, key);
    if (value) return value;
  }
  return undefined;
}

function summarizeCurlTarget(command: string): string | undefined {
  const match = command.match(/\bcurl\b[\s\S]*?(https?:\/\/[^\s"'`]+)/i);
  if (!match?.[1]) return undefined;

  try {
    const url = new URL(match[1]);
    const path = `${url.pathname}${url.search}`;
    return `curl ${url.host}${path === "/" ? "" : path}`;
  } catch {
    return undefined;
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
