import type React from "react";

export type DialogLayer = "overlay" | "modal";

export interface DialogRequest {
  id: string;
  layer: DialogLayer;
  content: React.ReactNode;
  priority?: number;
  active?: boolean;
}

export interface FocusedDialog extends DialogRequest {
  priority: number;
  focused: true;
}

export function pickFocusedDialog(requests: readonly DialogRequest[]): FocusedDialog | null {
  let focused: DialogRequest | null = null;
  let focusedPriority = Number.NEGATIVE_INFINITY;

  for (const request of requests) {
    if (request.active === false) continue;

    const priority = request.priority ?? 0;
    if (focused === null || priority > focusedPriority) {
      focused = request;
      focusedPriority = priority;
    }
  }

  if (focused === null) return null;

  return {
    ...focused,
    priority: focusedPriority,
    focused: true,
  };
}
