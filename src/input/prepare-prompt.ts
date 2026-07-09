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
  const cleaned = prompt.replace(/(^|\s)@image:(\S+)/gu, (_match, prefix: string, path: string) => {
    paths.push(unquote(path));
    return prefix;
  });
  return {
    prompt: cleaned.replace(/\s{2,}/gu, " ").trim(),
    paths,
  };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
