import type { ParsedSlashInput } from "./types.js";

const COMMAND_NAME = "[A-Za-z0-9_?][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*|\\?";
const NAME_RE = new RegExp(`^/(${COMMAND_NAME})(?:\\s+([\\s\\S]*))?$`);
const COMMAND_NAME_RE = new RegExp(`^(?:${COMMAND_NAME})$`);
const PARTIAL_COMMAND_NAME_RE =
  /^(?:[A-Za-z0-9_?][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*:?)$/;

/**
 * 判断一个已输入完整的 slash command token 是否可被执行。
 * 命令名保持 ASCII，冒号用于 markdown/plugin 命令的层级命名空间。
 */
export function isSlashCommandName(name: string): boolean {
  return COMMAND_NAME_RE.test(name);
}

/**
 * 判断输入中的 command token 是否仍可能成为合法命令。
 * 唯一允许的不完整状态是层级命令末尾的 `:`，例如 `plugin:`。
 */
export function isPartialSlashCommandName(name: string): boolean {
  return PARTIAL_COMMAND_NAME_RE.test(name);
}

export function parseSlashInput(input: string): ParsedSlashInput | null {
  const raw = input;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") {
    return null;
  }

  const match = NAME_RE.exec(trimmed);
  if (match === null) {
    return null;
  }

  const name = match[1];
  const args = (match[2] ?? "").trim();
  if (name === undefined) {
    return null;
  }

  return {
    raw,
    name: name.toLowerCase(),
    args,
    argv: parseCommandArgs(args),
  };
}

export function parseCommandArgs(args: string): readonly string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of args) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current.length > 0) {
    out.push(current);
  }

  return out;
}
