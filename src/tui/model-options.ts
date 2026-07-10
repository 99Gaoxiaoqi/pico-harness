import { MODEL_ARGUMENT_CANDIDATES } from "../input/pico-command-registry.js";
import type { ModelOption } from "./model-selector.js";

export function buildModelOptions(): ModelOption[] {
  return MODEL_ARGUMENT_CANDIDATES.map((hint) => ({
    id: hint.value,
    name: hint.value,
    description: hint.description,
  }));
}

export function modelSelectionToCommand(modelId: string): string {
  return `/model ${modelId}`;
}
