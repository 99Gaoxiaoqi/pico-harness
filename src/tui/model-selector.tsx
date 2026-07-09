import React from "react";
import { Box, Text } from "ink";

export const MODEL_NAME_DISPLAY_WIDTH = 28;
export const MODEL_DESCRIPTION_DISPLAY_WIDTH = 44;

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  efforts?: readonly string[];
}

export type ModelSelectorStatus = "selecting" | "confirmed" | "cancelled";

export interface ModelSelectorState {
  selectedIndex: number;
  status: ModelSelectorStatus;
  selectedModelId?: string;
}

export interface ModelSelectorProps {
  models: readonly ModelOption[];
  currentModelId?: string;
  state?: ModelSelectorState;
  maxItems?: number;
}

export interface ModelSelectorCallbacks {
  onConfirm?: (model: ModelOption) => void;
  onCancel?: () => void;
}

export interface ModelSelectorKeyEvent {
  input: string;
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    return?: boolean;
    escape?: boolean;
  };
}

export function ModelSelector({
  models,
  currentModelId,
  state = createModelSelectorState(models, currentModelId),
  maxItems,
}: ModelSelectorProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      {formatModelSelector(models, { currentModelId, state, maxItems })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function createModelSelectorState(
  models: readonly ModelOption[],
  currentModelId?: string,
): ModelSelectorState {
  const selectedIndex = Math.max(
    0,
    models.findIndex((model) => model.id === currentModelId),
  );
  return { selectedIndex, status: "selecting" };
}

export function moveModelSelection(
  state: ModelSelectorState,
  models: readonly ModelOption[],
  direction: "up" | "down",
): ModelSelectorState {
  if (models.length === 0) return { ...state, selectedIndex: 0, status: "selecting" };

  const delta = direction === "up" ? -1 : 1;
  const selectedIndex = modulo(state.selectedIndex + delta, models.length);
  return { selectedIndex, status: "selecting" };
}

export function confirmModelSelection(
  state: ModelSelectorState,
  models: readonly ModelOption[],
  callbacks: ModelSelectorCallbacks = {},
): ModelSelectorState {
  const model = models[state.selectedIndex];
  if (!model) return { selectedIndex: 0, status: "cancelled" };

  callbacks.onConfirm?.(model);
  return {
    selectedIndex: state.selectedIndex,
    selectedModelId: model.id,
    status: "confirmed",
  };
}

export function cancelModelSelection(
  state: ModelSelectorState,
  callbacks: ModelSelectorCallbacks = {},
): ModelSelectorState {
  callbacks.onCancel?.();
  return { selectedIndex: state.selectedIndex, status: "cancelled" };
}

export function resolveModelSelectorKey(
  state: ModelSelectorState,
  models: readonly ModelOption[],
  event: ModelSelectorKeyEvent,
  callbacks: ModelSelectorCallbacks = {},
): ModelSelectorState {
  if (event.key.upArrow) return moveModelSelection(state, models, "up");
  if (event.key.downArrow) return moveModelSelection(state, models, "down");
  if (event.key.return) return confirmModelSelection(state, models, callbacks);
  if (event.key.escape || event.input === "\u001b") {
    return cancelModelSelection(state, callbacks);
  }
  return state;
}

export function formatModelSelector(
  models: readonly ModelOption[],
  options: {
    currentModelId?: string;
    state?: ModelSelectorState;
    maxItems?: number;
    maxNameLength?: number;
    maxDescriptionLength?: number;
  } = {},
): string {
  if (models.length === 0) return "Models\nNo models available.";

  const state = options.state ?? createModelSelectorState(models, options.currentModelId);
  const maxItems = options.maxItems ?? 12;
  const maxNameLength = options.maxNameLength ?? MODEL_NAME_DISPLAY_WIDTH;
  const maxDescriptionLength = options.maxDescriptionLength ?? MODEL_DESCRIPTION_DISPLAY_WIDTH;
  const visible = models.slice(0, maxItems);
  const lines = ["Models"];

  for (const [index, model] of visible.entries()) {
    const selected = index === state.selectedIndex;
    const current = model.id === options.currentModelId;
    const marker = selected ? "›" : " ";
    const currentLabel = current ? " [current]" : "";
    const name = truncateInline(model.name, maxNameLength);
    const description = truncateInline(model.description ?? "", maxDescriptionLength);
    const effort = formatEfforts(model.efforts);
    const details = [description, effort].filter(Boolean).join(" · ");
    lines.push(`${marker} ${name}${currentLabel}${details ? ` - ${details}` : ""}`);
  }

  const hidden = models.length - visible.length;
  if (hidden > 0) lines.push(`... ${hidden} more models hidden`);
  lines.push("Enter to select · Esc to cancel");
  return lines.join("\n");
}

function formatEfforts(efforts: readonly string[] | undefined): string {
  if (!efforts || efforts.length === 0) return "";
  return `effort: ${efforts.join("/")}`;
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (inline.length <= maxLength) return inline;
  return `${inline.slice(0, Math.max(0, maxLength - 3))}...`;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
