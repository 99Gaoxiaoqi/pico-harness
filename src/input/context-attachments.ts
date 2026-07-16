import { constants, type Stats } from "node:fs";
import { open, opendir, type FileHandle } from "node:fs/promises";
import { relative } from "node:path";
import { WorkspaceRoots } from "../tools/workspace-roots.js";
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
  let workspaceRoots: WorkspaceRoots | undefined;

  for (const mention of mentions) {
    if (mention.kind === "path") {
      workspaceRoots ??= await WorkspaceRoots.create(options.cwd);
      attachments.push(await resolvePathAttachment(mention, workspaceRoots, limits));
    } else if (mention.kind === "skill" || mention.kind === "agent") {
      attachments.push(await resolveNamedAttachment(mention, options));
    }
  }

  return attachments;
}

export function injectContextAttachments(prompt: string, attachments: ContextAttachment[]): string {
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
  workspaceRoots: WorkspaceRoots,
  limits: AttachmentLimits,
): Promise<ContextAttachment> {
  let fullPath: string;
  try {
    fullPath = await workspaceRoots.assertAllowed(mention.target);
  } catch (error) {
    const reference = normalizeReference(mention.target);
    return missingAttachment(
      reference,
      `Unable to read path: ${reference}\n${errorMessage(error)}`,
    );
  }

  const physicalRoot = workspaceRoots.list()[0] ?? fullPath;
  const reference = toReference(physicalRoot, fullPath);
  let handle: FileHandle;
  let info: Stats;
  try {
    handle = await open(
      fullPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    info = await handle.stat();
  } catch (error) {
    return missingAttachment(reference, `File not found: ${reference}\n${errorMessage(error)}`);
  }

  try {
    if (info.isDirectory()) {
      return await readDirectoryAttachment(fullPath, reference, limits);
    }
    if (info.isFile()) {
      return await readFileAttachment(handle, reference, mention, limits, info.size);
    }

    return {
      type: "missing",
      reference,
      content: `Unsupported path type: ${reference}`,
      truncated: false,
    };
  } finally {
    await handle.close();
  }
}

function missingAttachment(reference: string, content: string): ContextAttachment {
  return {
    type: "missing",
    reference,
    content,
    truncated: false,
  };
}

async function readFileAttachment(
  handle: FileHandle,
  reference: string,
  mention: MentionReference,
  limits: AttachmentLimits,
  knownSize: number,
): Promise<ContextAttachment> {
  const { data, truncated: bytesTruncated } = await readBounded(
    handle,
    limits.maxFileBytes,
    knownSize,
  );
  const text = data.toString("utf8");
  const allLoadedLines = splitLines(text);
  const requestedStart = mention.lineStart ?? 1;
  const requestedEnd = mention.lineEnd ?? allLoadedLines.length;
  const startIndex = Math.max(0, requestedStart - 1);
  const endIndexExclusive = Math.min(requestedEnd, allLoadedLines.length);
  const selected = allLoadedLines.slice(startIndex, endIndexExclusive);
  const lineLimited = selected.length > limits.maxFileLines;
  const renderedLines = selected.slice(0, limits.maxFileLines);
  const actualEnd =
    renderedLines.length > 0 ? requestedStart + renderedLines.length - 1 : requestedStart;
  const rangeClipped =
    requestedEnd > allLoadedLines.length || requestedStart > allLoadedLines.length;
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

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  knownSize: number,
): Promise<{ data: Buffer; truncated: boolean }> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return {
    data: buffer.subarray(0, Math.min(offset, maxBytes)),
    truncated: knownSize > maxBytes || offset > maxBytes,
  };
}

async function readDirectoryAttachment(
  fullPath: string,
  reference: string,
  limits: AttachmentLimits,
): Promise<ContextAttachment> {
  const directory = await opendir(fullPath);
  const sampledNames: string[] = [];
  try {
    while (sampledNames.length <= limits.maxDirectoryEntries) {
      const entry = await directory.read();
      if (!entry) break;
      sampledNames.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }
  } finally {
    await directory.close();
  }

  const truncated = sampledNames.length > limits.maxDirectoryEntries;
  const visible = sampledNames.slice(0, limits.maxDirectoryEntries).sort();
  const content = truncated
    ? `${visible.join("\n")}\n... (目录项超过 ${limits.maxDirectoryEntries} 项，已截断)`
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

function renderNumberedLines(lines: string[], startLine: number, truncated: boolean): string {
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

function normalizeReference(reference: string): string {
  return reference.replaceAll("\\", "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
