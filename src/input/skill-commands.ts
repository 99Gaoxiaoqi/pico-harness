import type { SkillLoader, SkillSummary } from "../context/skill.js";

export type SkillCommandResolution =
  | { found: true; name: string; body: string }
  | { found: false; name: string; available: SkillSummary[] };

export async function renderSkillListCommand(loader: SkillLoader): Promise<string> {
  const skills = await loader.listSummaries();
  if (skills.length === 0) return "当前没有可用 Skills。";

  const lines = ["可用 Skills:"];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description}`);
  }
  return lines.join("\n");
}

export async function resolveSkillCommand(
  loader: SkillLoader,
  rawName: string,
): Promise<SkillCommandResolution> {
  const name = rawName.trim();
  const body = name ? await loader.viewBody(name) : undefined;
  if (body !== undefined) {
    return { found: true, name, body };
  }

  return {
    available: await loader.listSummaries(),
    found: false,
    name,
  };
}

export async function renderSkillCommand(loader: SkillLoader, rawName: string): Promise<string> {
  const result = await resolveSkillCommand(loader, rawName);
  if (result.found) return result.body;

  const names = result.available.map((skill) => skill.name).join(", ");
  return names
    ? `未找到 Skill: ${result.name}\n可用 Skills: ${names}`
    : `未找到 Skill: ${result.name}\n当前没有可用 Skills。`;
}
