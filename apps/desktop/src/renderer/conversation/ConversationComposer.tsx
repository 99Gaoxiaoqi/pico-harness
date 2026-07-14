import { ArrowUp, Paperclip, Pause, Play, Square } from "lucide-react";
import { useId, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type {
  ComposerBehavior,
  ComposerOptionView,
  ComposerStatus,
  ComposerSubmitValue,
} from "./types.js";

export interface ConversationComposerProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: (value: ComposerSubmitValue) => void;
  readonly status: ComposerStatus;
  readonly behavior?: ComposerBehavior | undefined;
  readonly onBehaviorChange?: ((behavior: ComposerBehavior) => void) | undefined;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly statusText?: string | undefined;
  readonly options?: readonly ComposerOptionView[] | undefined;
  readonly selectedOption?: string | undefined;
  readonly onOptionChange?: ((value: string) => void) | undefined;
  readonly onAttach?: (() => void) | undefined;
  readonly onPause?: (() => void) | undefined;
  readonly onResume?: (() => void) | undefined;
  readonly onStop?: (() => void) | undefined;
  readonly leadingAccessory?: ReactNode | undefined;
  readonly trailingAccessory?: ReactNode | undefined;
}

const behaviorLabels: Readonly<Record<Exclude<ComposerBehavior, "auto">, string>> = {
  steer: "调整当前执行",
  queue: "排在下一轮",
  replace: "停止并替换",
};

function defaultBehavior(status: ComposerStatus): ComposerBehavior {
  return status === "idle" ? "auto" : "steer";
}

export function ConversationComposer({
  value,
  onValueChange,
  onSubmit,
  status,
  behavior = defaultBehavior(status),
  onBehaviorChange,
  placeholder = "给 Pico 发消息",
  disabled = false,
  busy = false,
  statusText,
  options = [],
  selectedOption,
  onOptionChange,
  onAttach,
  onPause,
  onResume,
  onStop,
  leadingAccessory,
  trailingAccessory,
}: ConversationComposerProps) {
  const textareaId = useId();
  const statusId = useId();
  const canSubmit = value.trim().length > 0 && !disabled && !busy;
  const effectiveBehavior = status === "idle" ? "auto" : behavior === "auto" ? "steer" : behavior;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ text: value.trim(), behavior: effectiveBehavior });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const handleBehaviorChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onBehaviorChange?.(event.target.value as ComposerBehavior);
  };

  return (
    <form
      className="conversation-composer"
      data-status={status}
      aria-label="消息输入"
      onSubmit={handleSubmit}
    >
      <label className="conversation-sr-only" htmlFor={textareaId}>
        消息
      </label>
      <textarea
        id={textareaId}
        value={value}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        aria-describedby={statusId}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="conversation-composer__footer">
        <div className="conversation-composer__controls">
          {onAttach && (
            <button
              type="button"
              className="conversation-icon-button"
              onClick={onAttach}
              aria-label="添加附件"
            >
              <Paperclip aria-hidden="true" />
            </button>
          )}
          {leadingAccessory}
          {status !== "idle" && (
            <label className="conversation-behavior">
              <span className="conversation-sr-only">运行中消息行为</span>
              <select
                value={effectiveBehavior}
                disabled={disabled || !onBehaviorChange}
                onChange={handleBehaviorChange}
              >
                {Object.entries(behaviorLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {options.length > 0 && (
            <label className="conversation-context-option">
              <span className="conversation-sr-only">会话选项</span>
              <select
                value={selectedOption}
                disabled={disabled || !onOptionChange}
                onChange={(event) => onOptionChange?.(event.target.value)}
              >
                {options.map((option) => (
                  <option key={option.id} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="conversation-composer__actions">
          <span id={statusId} className="conversation-composer__status" role="status">
            {statusText ??
              (status === "idle" ? "就绪" : status === "running" ? "Pico 正在工作" : "已暂停")}
          </span>
          {trailingAccessory}
          {status === "running" && onPause && (
            <button
              type="button"
              className="conversation-icon-button"
              onClick={onPause}
              aria-label="暂停运行"
            >
              <Pause aria-hidden="true" />
            </button>
          )}
          {status === "paused" && onResume && (
            <button
              type="button"
              className="conversation-icon-button"
              onClick={onResume}
              aria-label="继续运行"
            >
              <Play aria-hidden="true" />
            </button>
          )}
          {status !== "idle" && onStop && (
            <button
              type="button"
              className="conversation-icon-button"
              onClick={onStop}
              aria-label="停止运行"
            >
              <Square aria-hidden="true" />
            </button>
          )}
          <button
            type="submit"
            className="conversation-send-button"
            disabled={!canSubmit}
            aria-label={
              effectiveBehavior === "queue"
                ? "将消息排到下一轮"
                : effectiveBehavior === "replace"
                  ? "停止当前执行并发送"
                  : "发送消息"
            }
          >
            <ArrowUp aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>
  );
}
