import { SkillLoader } from "../context/skill.js";
import { expandMentionsToPrompt } from "./context-attachments.js";

export async function preparePromptWithMentions(prompt: string, workDir: string): Promise<string> {
  const skillLoader = new SkillLoader(workDir);
  const expanded = await expandMentionsToPrompt(prompt, {
    cwd: workDir,
    skills: (name) => skillLoader.viewBody(name),
    agents: (name) =>
      `请优先考虑使用子代理能力处理 @agent:${name} 指定的工作。可用时调用 spawn_subagent 或 delegate_task,并把任务交给 ${name}。`,
  });
  return expanded.prompt;
}
