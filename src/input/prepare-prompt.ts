import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { SkillLoader } from "../context/skill.js";
import type { ImagePart } from "../schema/message.js";
import { expandMentionsToPrompt } from "./context-attachments.js";

export interface PreparedUserPrompt {
  prompt: string;
  images?: ImagePart[];
  notices?: string[];
}

export async function preparePromptWithMentions(prompt: string, workDir: string): Promise<string> {
  return (await preparePromptForMessage(prompt, workDir)).prompt;
}

export async function preparePromptForMessage(
  prompt: string,
  workDir: string,
): Promise<PreparedUserPrompt> {
  const extracted = extractImageMentions(prompt);
  const skillLoader = new SkillLoader(workDir);
  const expanded = await expandMentionsToPrompt(extracted.prompt, {
    cwd: workDir,
    skills: (name) => skillLoader.viewBody(name),
    agents: (name) =>
      `请优先考虑使用子代理能力处理 @agent:${name} 指定的工作。可用时调用 spawn_subagent 或 delegate_task,并把任务交给 ${name}。`,
  });
  const images = extracted.paths.map((path) => loadImage(path, workDir));
  const preparedPrompt = expanded.prompt.trim() || (images.length > 0 ? "请查看这张图片。" : "");
  return {
    prompt: preparedPrompt,
    ...(images.length > 0 ? { images } : {}),
    ...(extracted.paths.length > 0
      ? { notices: extracted.paths.map((path) => `已附加图片: ${basename(path)}`) }
      : {}),
  };
}

export function loadImage(imagePath: string, workDir: string): ImagePart {
  const filePath = resolveImagePath(imagePath, workDir);
  const data = readFileSync(filePath).toString("base64");
  return { type: "image_base64", mimeType: inferImageMimeType(imagePath), data };
}

function extractImageMentions(prompt: string): { prompt: string; paths: string[] } {
  const paths: string[] = [];
  const output: string[] = [];

  for (let i = 0; i < prompt.length; ) {
    if (prompt.startsWith("@image:", i) && isImageMentionBoundary(prompt[i - 1])) {
      const parsed = readImagePath(prompt, i + "@image:".length);
      if (parsed) {
        paths.push(parsed.path);
        output.push(parsed.suffix);
        i = parsed.end;
        continue;
      }
    }

    output.push(prompt[i]!);
    i++;
  }

  const cleaned = output.join("");
  return {
    prompt: cleaned.replace(/\s{2,}/gu, " ").trim(),
    paths,
  };
}

function isImageMentionBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s([{（【]/u.test(char);
}

function readImagePath(
  text: string,
  start: number,
): { path: string; suffix: string; end: number } | null {
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    const end = findClosingQuote(text, start, quote);
    if (end === -1) return null;
    const raw = text.slice(start, end + 1);
    const path = quote === '"' ? parseJsonString(raw) : raw.slice(1, -1);
    return path ? { path, suffix: "", end: end + 1 } : null;
  }

  let end = start;
  while (end < text.length && !/\s/u.test(text[end]!)) end++;
  const token = text.slice(start, end);
  const path = token.replace(/[。．，,、；;：:！？!?）)\]】}]+$/u, "");
  if (!path) return null;
  return { path, suffix: token.slice(path.length), end };
}

function findClosingQuote(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== quote) continue;
    if (quote === '"' && text[i - 1] === "\\") continue;
    return i;
  }
  return -1;
}

function parseJsonString(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveImagePath(imagePath: string, workDir: string): string {
  const root = realpathSync(workDir);
  const target = resolve(root, imagePath);
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch (error) {
    throw new Error(
      `图片不存在或无法读取: ${imagePath}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const rel = relative(root, realTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`图片路径在工作区外: ${imagePath}`);
  }
  return realTarget;
}

function inferImageMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}
