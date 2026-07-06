import { SkillLoader, SkillViewTool } from "../context/skill.js";
import { BackgroundManager } from "./background-manager.js";
import {
  BashTool,
  EditFileTool,
  EchoTool,
  ReadFileTool,
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
  ToolRegistry,
  type ToolRegistryOptions,
  WriteFileTool,
} from "./registry-impl.js";

export interface DefaultToolRegistryOptions extends ToolRegistryOptions {
  backgroundManager?: BackgroundManager;
}

export function buildDefaultToolRegistry(
  workDir: string,
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const { backgroundManager = new BackgroundManager(), ...registryOptions } = options;
  const registry = new ToolRegistry(registryOptions);
  registry.register(new EchoTool());
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new EditFileTool(workDir));
  registry.register(new BashTool(workDir, backgroundManager));
  registry.register(new TaskListTool(backgroundManager));
  registry.register(new TaskOutputTool(backgroundManager));
  registry.register(new TaskStopTool(backgroundManager));
  registry.register(new SkillViewTool(new SkillLoader(workDir)));
  return registry;
}
