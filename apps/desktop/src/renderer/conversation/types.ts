import type { ReactNode } from "react";

export type ConversationRunStatus = "started" | "completed" | "interrupted" | "failed";

export type ConversationProgressState = "waiting" | "active" | "done" | "failed";

interface ConversationItemBase {
  readonly id: string;
  readonly at?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly originalBytes?: number | undefined;
}

export interface UserMessageItemView extends ConversationItemBase {
  readonly kind: "userMessage";
  readonly text: string;
}

export interface AssistantMessageItemView extends ConversationItemBase {
  readonly kind: "assistantMessage";
  readonly text: string;
  readonly streaming?: boolean | undefined;
}

export interface RunBoundaryItemView extends ConversationItemBase {
  readonly kind: "runBoundary";
  readonly status: ConversationRunStatus;
  readonly label: string;
  readonly duration?: string | undefined;
  readonly detail?: string | undefined;
}

export interface PlanStepView {
  readonly id: string;
  readonly title: string;
  readonly state: ConversationProgressState;
}

export interface PlanItemView extends ConversationItemBase {
  readonly kind: "plan";
  readonly title?: string | undefined;
  readonly steps: readonly PlanStepView[];
}

export interface ToolItemView extends ConversationItemBase {
  readonly kind: "tool";
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly output?: string | undefined;
  readonly state: ConversationProgressState;
}

export interface StatusItemView extends ConversationItemBase {
  readonly kind: "status";
  readonly title: string;
  readonly detail?: string | undefined;
  readonly tone?: "neutral" | "success" | "warning" | "error" | undefined;
}

export interface SubagentItemView extends ConversationItemBase {
  readonly kind: "subagent";
  readonly name: string;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly state: ConversationProgressState;
}

export interface ApprovalItemView extends ConversationItemBase {
  readonly kind: "approval";
  readonly title: string;
  readonly detail: string;
  readonly state: "pending" | "allowed" | "denied";
}

export interface PromptItemView extends ConversationItemBase {
  readonly kind: "prompt";
  readonly question: string;
  readonly detail?: string | undefined;
  readonly state: "pending" | "answered";
}

export interface ChangesItemView extends ConversationItemBase {
  readonly kind: "changes";
  readonly title: string;
  readonly detail?: string | undefined;
  readonly files: readonly string[];
  readonly state?: "pending" | "applied" | "conflict" | undefined;
}

export interface GoalItemView extends ConversationItemBase {
  readonly kind: "goal";
  readonly title: string;
  readonly detail?: string | undefined;
  readonly state: ConversationProgressState;
}

export type ConversationItemView =
  | UserMessageItemView
  | AssistantMessageItemView
  | RunBoundaryItemView
  | PlanItemView
  | ToolItemView
  | StatusItemView
  | SubagentItemView
  | ApprovalItemView
  | PromptItemView
  | ChangesItemView
  | GoalItemView;

export type ComposerStatus = "idle" | "running" | "paused";
export type ComposerBehavior = "auto" | "steer" | "queue" | "replace";

export interface ComposerSubmitValue {
  readonly text: string;
  readonly behavior: ComposerBehavior;
}

export interface ComposerOptionView {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ConversationInspectorView {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly content: ReactNode;
}
