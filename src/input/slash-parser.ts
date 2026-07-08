import type { ParsedSlashInput } from "./types.js";

const NAME_RE = /^\/([A-Za-z0-9_?][A-Za-z0-9_-]*|\?)(?:\s+([\s\S]*))?$/;

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
