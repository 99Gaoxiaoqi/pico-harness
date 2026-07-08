import { readFile, readdir, stat } from "node:fs/promises";
import { relative } from "node:path";
import { safeResolve } from "../tools/registry-impl.js";
import { parseMentions, type MentionReference } from "./mentions.js";

export type ContextAttachmentType = "file" | "directory" | "skill" | "agent" | "missing";

export interface ContextAttachment {
  type: ContextAttachmentType;
  reference: string;
  content: string;
  truncated: boolean;
  lineStart?: number;
  lineEnd?: number;
}

export interface AttachmentLimits {
  maxFileLines: number;
  maxFileBytes: number;
  maxDirectoryEntries: number;
}

export interface ResolveContextAttachmentOptions {
  cwd: string;
  limits?: Partial<AttachmentLimits>;
  skills?: AttachmentContentSource;
  agents?: AttachmentContentSource;
}

export interface ExpandedPrompt {
  prompt: string;
  mentions: MentionReference[];
  attachments: ContextAttachment[];
}

type AttachmentContentSource =
  | Record<string, string>
  | ((name: string) => string | undefined | Promise<string | undefined>);

const DEFAULT_LIMITS: AttachmentLimits = {
  maxFileLines: 200,
  maxFileBytes: 20 * 1024,
  maxDirectoryEntries: 100,
};

export async function expandMentionsToPrompt(
  prompt: string,
  options: ResolveContextAttachmentOptions,
): Promise<ExpandedPrompt> {
  const mentions = parseMentions(prompt);
  const attachments = await resolveContextAttachments(mentions, options);
  return {
    prompt: injectContextAttachments(prompt, attachments),
    mentions,
    attachments,
  };
}

export async function resolveContextAttachments(
  mentions: MentionReference[],
  options: ResolveContextAttachmentOptions,
): Promise<ContextAttachment[]> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const attachments: ContextAttachment[] = [];

  for (const mention of mentions) {
    if (mention.kind === "path") {
      attachments.push(await resolvePathAttachment(mention, options.cwd, limits));
    } else if (mention.kind === "skill" || mention.kind === "agent") {
      attachments.push(await resolveNamedAttachment(mention, options));
    }
  }

  return attachments;
}

export function injectContextAttachments(
  prompt: string,
  attachments: ContextAttachment[],
): string {
  if (attachments.length === 0) return prompt;

  const blocks = attachments.map((attachment) => {
    const attrs = [
      `type="${escapeAttribute(attachment.type)}"`,
      `reference="${escapeAttribute(attachment.reference)}"`,
      `truncated="${attachment.truncated ? "true" : "false"}"`,
    ];
    if (attachment.lineStart !== undefined && attachment.lineEnd !== undefined) {
      attrs.push(`lines="${attachment.lineStart}-${attachment.lineEnd}"`);
    }
    return `<attachment ${attrs.join(" ")}>\n${attachment.content}\n</attachment>`;
  });

  return `${prompt}\n\n<context-attachments>\n${blocks.join("\n")}\n</context-attachments>`;
}

async function resolvePathAttachment(
  mention: MentionReference,
  cwd: string,
  limits: AttachmentLimits,
): Promise<ContextAttachment> {
  const fullPath = safeResolve(cwd, mention.target);
  const info = await stat(fullPath);
  const reference = toReference(cwd, fullPath);

  if (info.isDirectory()) {
    return readDirectoryAttachment(fullPath, reference, limits);
  }
  if (info.isFile()) {
    return readFileAttachment(fullPath, reference, mention, limits);
  }

  return {
    type: "missing",
    reference,
    content: `Unsupported path type: ${reference}`,
    truncated: false,
  };
}

async function readFileAttachment(
  fullPath: string,
  reference: string,
  mention: MentionReference,
  limits: AttachmentLimits,
): Promise<ContextAttachment> {
  const data = await readFile(fullPath);
  const bytesTruncated = data.byteLength > limits.maxFileBytes;
  const text = data.subarray(0, limits.maxFileBytes).toString("utf8");
  const allLoadedLines = splitLines(text);
  const requestedStart = mention.lineStart ?? 1;
  const requestedEnd = mention.lineEnd ?? allLoadedLines.length;
  const startIndex = Math.max(0, requestedStart - 1);
  const endIndexExclusive = Math.min(requestedEnd, allLoadedLines.length);
  const selected = allLoadedLines.slice(startIndex, endIndexExclusive);
  const lineLimited = selected.length > limits.maxFileLines;
  const renderedLines = selected.slice(0, limits.maxFileLines);
  const actualEnd = renderedLines.length > 0 ? requestedStart + renderedLines.length - 1 : requestedStart;
  const rangeClipped = requestedEnd > allLoadedLines.length || requestedStart > allLoadedLines.length;
  const truncated = bytesTruncated || lineLimited || rangeClipped;
  const content = renderNumberedLines(renderedLines, requestedStart, truncated);

  return {
    type: "file",
    reference,
    content,
    truncated,
    lineStart: requestedStart,
    lineEnd: actualEnd,
  };
}

async function readDirectoryAttachment(
  fullPath: string,
  reference: string,
  limits: AttachmentLimits,
): Promise<ContextAttachment> {
  const entries = await readdir(fullPath, { withFileTypes: true });
  const names = entries
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort();
  const visible = names.slice(0, limits.maxDirectoryEntries);
  const truncated = names.length > visible.length;
  const content = truncated
    ? `${visible.join("\n")}\n... (共 ${names.length} 项,已截断至前 ${visible.length} 项)`
    : visible.join("\n");

  return {
    type: "directory",
    reference,
    content,
    truncated,
  };
}

async function resolveNamedAttachment(
  mention: MentionReference,
  options: ResolveContextAttachmentOptions,
): Promise<ContextAttachment> {
  const type = mention.kind === "agent" ? "agent" : "skill";
  const source = type === "skill" ? options.skills : options.agents;
  const content = await readNamedSource(source, mention.target);

  return {
    type,
    reference: mention.target,
    content: content ?? `未找到 ${type}: ${mention.target}`,
    truncated: false,
  };
}

async function readNamedSource(
  source: AttachmentContentSource | undefined,
  name: string,
): Promise<string | undefined> {
  if (!source) return undefined;
  if (typeof source === "function") return source(name);
  return source[name];
}

function renderNumberedLines(
  lines: string[],
  startLine: number,
  truncated: boolean,
): string {
  const rendered = lines.map((line, index) => `${startLine + index}: ${line}`);
  if (truncated) rendered.push("... (已截断)");
  return rendered.join("\n");
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function toReference(cwd: string, fullPath: string): string {
  const rel = relative(cwd, fullPath).replaceAll("\\", "/");
  return rel.length === 0 ? "." : rel;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
