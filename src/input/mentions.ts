export type MentionKind = "path" | "skill" | "agent";

export interface MentionReference {
  kind: MentionKind;
  raw: string;
  target: string;
  start: number;
  end: number;
  lineStart?: number;
  lineEnd?: number;
}

const TRAILING_PUNCTUATION = /[),.;!?，。；！？）]+$/;

export function parseMentions(input: string): MentionReference[] {
  const mentions: MentionReference[] = [];
  let index = 0;

  while (index < input.length) {
    const at = input.indexOf("@", index);
    if (at === -1) break;

    const parsed = parseAt(input, at);
    if (!parsed) {
      index = at + 1;
      continue;
    }

    mentions.push(parsed);
    index = parsed.end;
  }

  return mentions;
}

function parseAt(input: string, at: number): MentionReference | undefined {
  if (input.startsWith("@skill:", at)) {
    return parseNamedMention(input, at, "skill", "@skill:".length);
  }
  if (input.startsWith("@agent:", at)) {
    return parseNamedMention(input, at, "agent", "@agent:".length);
  }
  if (input.startsWith('@"', at)) {
    return parseQuotedPath(input, at);
  }
  return parsePlainPath(input, at);
}

function parseNamedMention(
  input: string,
  at: number,
  kind: "skill" | "agent",
  prefixLength: number,
): MentionReference | undefined {
  const start = at + prefixLength;
  let end = start;
  while (end < input.length && !/\s/.test(input[end] ?? "")) {
    end++;
  }
  const trimmedEnd = trimTrailingPunctuation(input, start, end);
  if (trimmedEnd === start) return undefined;

  return {
    kind,
    raw: input.slice(at, trimmedEnd),
    target: input.slice(start, trimmedEnd),
    start: at,
    end: trimmedEnd,
  };
}

function parseQuotedPath(input: string, at: number): MentionReference | undefined {
  const pathStart = at + 2;
  const quoteEnd = input.indexOf('"', pathStart);
  if (quoteEnd === -1) return undefined;

  const lineRange = parseLineRange(input, quoteEnd + 1);
  const end = lineRange?.end ?? quoteEnd + 1;
  const target = input.slice(pathStart, quoteEnd);
  if (target.length === 0) return undefined;

  return {
    kind: "path",
    raw: input.slice(at, end),
    target,
    start: at,
    end,
    ...lineRangeToFields(lineRange),
  };
}

function parsePlainPath(input: string, at: number): MentionReference | undefined {
  const start = at + 1;
  let end = start;
  while (end < input.length && !/\s/.test(input[end] ?? "")) {
    end++;
  }
  end = trimTrailingPunctuation(input, start, end);
  if (end === start) return undefined;

  const rawBody = input.slice(start, end);
  const parsed = splitLineRange(rawBody);
  if (parsed.target.length === 0) return undefined;

  return {
    kind: "path",
    raw: input.slice(at, end),
    target: parsed.target,
    start: at,
    end,
    ...lineRangeToFields(parsed.range),
  };
}

function parseLineRange(input: string, start: number): ParsedLineRange | undefined {
  const match = /^#L(\d+)(?:-(\d+))?/i.exec(input.slice(start));
  if (!match) return undefined;
  const lineStart = Number(match[1]);
  const lineEnd = match[2] ? Number(match[2]) : lineStart;
  if (!Number.isSafeInteger(lineStart) || lineStart < 1) return undefined;
  if (!Number.isSafeInteger(lineEnd) || lineEnd < 1) return undefined;
  return {
    start: lineStart,
    endLine: Math.max(lineStart, lineEnd),
    end: start + match[0].length,
  };
}

function splitLineRange(rawBody: string): {
  target: string;
  range?: ParsedLineRange;
} {
  const match = /#L(\d+)(?:-(\d+))?$/i.exec(rawBody);
  if (!match) return { target: rawBody };
  const lineStart = Number(match[1]);
  const lineEnd = match[2] ? Number(match[2]) : lineStart;
  if (!Number.isSafeInteger(lineStart) || lineStart < 1) return { target: rawBody };
  if (!Number.isSafeInteger(lineEnd) || lineEnd < 1) return { target: rawBody };

  return {
    target: rawBody.slice(0, match.index),
    range: {
      start: lineStart,
      endLine: Math.max(lineStart, lineEnd),
      end: rawBody.length,
    },
  };
}

function lineRangeToFields(
  range: ParsedLineRange | undefined,
): Pick<MentionReference, "lineStart" | "lineEnd"> {
  if (!range) return {};
  return {
    lineStart: range.start,
    lineEnd: range.endLine,
  };
}

function trimTrailingPunctuation(input: string, start: number, end: number): number {
  const body = input.slice(start, end);
  const trimmed = body.replace(TRAILING_PUNCTUATION, "");
  return start + trimmed.length;
}

interface ParsedLineRange {
  start: number;
  endLine: number;
  end: number;
}
