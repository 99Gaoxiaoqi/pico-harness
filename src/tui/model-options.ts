import { getSlashArgumentHints } from "../input/slash-argument-hints.js";
import type { ModelOption } from "./model-selector.js";

export function buildModelOptions(): ModelOption[] {
  return getSlashArgumentHints("model").map((hint) => ({
    id: hint.value,
    name: hint.value,
    description: hint.description,
  }));
}

export function modelSelectionToCommand(modelId: string): string {
  return `/model ${modelId}`;
}
