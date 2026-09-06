import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { truncateTerminalText } from "./terminal-width.js";

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
  query?: string;
  status: ModelSelectorStatus;
  selectedModelId?: string;
}

export interface ModelSelectorProps {
  models: readonly ModelOption[];
  currentModelId?: string;
  state?: ModelSelectorState;
  maxItems?: number;
  /** 选择确认回调（3-D 客户端接线；缺省为纯浏览）。 */
  callbacks?: ModelSelectorCallbacks;
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
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  };
}

export function ModelSelector({
  models,
  currentModelId,
  state = createModelSelectorState(models, currentModelId),
  maxItems,
  callbacks: _callbacks,
}: ModelSelectorProps): React.ReactNode {
  void _callbacks;
  return (
    <Box flexDirection="column">
      {formatModelSelector(models, { currentModelId, state, maxItems })
        .split("\n")
        .map((line, index) => (
          <Text
            key={`${index}:${line}`}
            bold={index === 0 || line.startsWith("  ›")}
            color={line.startsWith("  ›") ? "cyan" : undefined}
            dimColor={
              line.startsWith("当前：") || line.startsWith("↑↓") || line.startsWith("显示 ")
            }
          >
            {line}
          </Text>
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
    selectableModels(models).findIndex((model) => model.id === currentModelId),
  );
  return { selectedIndex, status: "selecting" };
}

export function moveModelSelection(
  state: ModelSelectorState,
  models: readonly ModelOption[],
  direction: "up" | "down",
): ModelSelectorState {
  models = selectableModels(models, state.query);
  if (models.length === 0) return { ...state, selectedIndex: 0, status: "selecting" };

  const delta = direction === "up" ? -1 : 1;
  const selectedIndex = modulo(state.selectedIndex + delta, models.length);
  return { ...state, selectedIndex, status: "selecting" };
}

export function confirmModelSelection(
  state: ModelSelectorState,
  models: readonly ModelOption[],
  callbacks: ModelSelectorCallbacks = {},
): ModelSelectorState {
  const model = selectableModels(models, state.query)[state.selectedIndex];
  if (!model) return state;

  callbacks.onConfirm?.(model);
  return {
    ...state,
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
  if (event.key.backspace || event.key.delete) {
    return {
      selectedIndex: 0,
      status: "selecting",
      query: Array.from(state.query ?? "")
        .slice(0, -1)
        .join(""),
    };
  }
  if (event.key.ctrl && event.input === "u") {
    return { selectedIndex: 0, status: "selecting", query: "" };
  }
  if (
    !event.key.ctrl &&
    !event.key.meta &&
    event.input &&
    Array.from(event.input).every((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127;
    })
  ) {
    return { selectedIndex: 0, status: "selecting", query: `${state.query ?? ""}${event.input}` };
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
  if (models.length === 0)
    return "选择模型\n暂无可用模型。\n请在 Pico App 的「设置 → 模型」中添加厂商，\n或按 Esc 后运行 /provider import-env <厂商 ID> 导入环境配置。\nEsc 取消";

  const state = options.state ?? createModelSelectorState(models, options.currentModelId);
  const current = models.find((model) => model.id === options.currentModelId);
  models = selectableModels(models, state.query);
  const maxItems = Math.max(1, options.maxItems ?? 8);
  const maxNameLength = options.maxNameLength ?? MODEL_NAME_DISPLAY_WIDTH;
  const maxDescriptionLength = options.maxDescriptionLength ?? MODEL_DESCRIPTION_DISPLAY_WIDTH;
  const selectedIndex = clampSelection(state.selectedIndex, models.length);
  const firstVisibleIndex = visibleWindowStart(selectedIndex, models.length, maxItems);
  const visible = models.slice(firstVisibleIndex, firstVisibleIndex + maxItems);
  const lines = [
    "选择模型",
    `当前：${current?.id ?? options.currentModelId ?? "未设置"}`,
    `筛选：${state.query || "输入模型名或厂商名"}`,
    "",
  ];
  if (models.length === 0) lines.push("没有匹配的模型，请退格修改或按 Ctrl+U 清空筛选。");
  let lastProvider: string | undefined;

  for (const [index, model] of visible.entries()) {
    const modelIndex = firstVisibleIndex + index;
    const provider = modelProvider(model);
    if (provider !== lastProvider) {
      lines.push(`  ${provider}`);
      lastProvider = provider;
    }
    const selected = modelIndex === selectedIndex;
    const current = model.id === options.currentModelId;
    const marker = selected ? "›" : " ";
    const currentLabel = current ? " ✓ 当前" : "";
    const name = truncateInline(model.name, maxNameLength);
    const description = truncateInline(model.description ?? "", maxDescriptionLength);
    const effort = formatEfforts(model.efforts);
    const details = [description, effort].filter(Boolean).join(" · ");
    lines.push(`  ${marker} ${name}${currentLabel}${details ? ` · ${details}` : ""}`);
  }

  const hidden = models.length - visible.length;
  if (hidden > 0)
    lines.push(
      `显示 ${firstVisibleIndex + 1}–${firstVisibleIndex + visible.length} / ${models.length} 个模型`,
    );
  const selectedModel = models[selectedIndex];
  if (selectedModel) lines.push(`已选：${selectedModel.id}`);
  lines.push("↑↓ 移动 · Enter 确认 · Esc 取消 · Ctrl+U 清空筛选");
  return lines.join("\n");
}

function formatEfforts(efforts: readonly string[] | undefined): string {
  if (!efforts || efforts.length === 0) return "";
  return `思考强度：${efforts.join("/")}`;
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  return truncateTerminalText(inline, maxLength);
}

function modelProvider(model: ModelOption): string {
  const separator = model.id.indexOf("/");
  return separator > 0 ? model.id.slice(0, separator) : "其他模型";
}

function selectableModels(models: readonly ModelOption[], query = ""): ModelOption[] {
  const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  const groups = new Map<string, ModelOption[]>();
  for (const model of models) {
    const haystack = `${model.id} ${model.name} ${model.description ?? ""}`.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    const provider = modelProvider(model);
    const group = groups.get(provider) ?? [];
    group.push(model);
    groups.set(provider, group);
  }
  return [...groups.values()].flat();
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clampSelection(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(0, index), itemCount - 1);
}

function visibleWindowStart(selectedIndex: number, itemCount: number, maxItems: number): number {
  const visibleCount = Math.max(1, maxItems);
  if (itemCount <= visibleCount) return 0;
  return Math.min(Math.max(0, selectedIndex - visibleCount + 1), itemCount - visibleCount);
}

export interface InteractiveModelSelectorProps {
  models: readonly ModelOption[];
  currentModelId?: string;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

/**
 * 键盘交互模型选择器（3-D 对抗评审二轮 P0 提取自 repl.tsx，客户端对话框共用）：
 * 方向键移动、Enter 确认 onSelect、Esc 取消 onCancel。
 */
export function InteractiveModelSelector({
  models,
  currentModelId,
  onSelect,
  onCancel,
}: InteractiveModelSelectorProps): React.ReactNode {
  const [state, setState] = useState<ModelSelectorState>(() =>
    createModelSelectorState(models, currentModelId),
  );

  useInput((input, key) => {
    const next = resolveModelSelectorKey(
      state,
      models,
      { input, key },
      {
        onConfirm: (model) => onSelect(model.id),
        onCancel,
      },
    );
    if (next.status === "selecting") setState(next);
  });

  return <ModelSelector models={models} currentModelId={currentModelId} state={state} />;
}
