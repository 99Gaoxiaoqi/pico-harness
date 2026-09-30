import {
  useCommandSuggestions,
  type ComposerCommands,
  type ComposerResources,
} from "./CommandSuggestions.js";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerInput,
  type ChatComposerInputHandle,
} from "@astryxdesign/core/Chat";
import { Selector } from "@astryxdesign/core/Selector";
import { ArrowUp, Pause, Play, Square } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useImperativeHandle,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type {
  ComposerBehavior,
  ComposerOptionView,
  ComposerStatus,
  ComposerSubmitValue,
} from "./types.js";
import {
  ConversationComposerMenu,
  type ConversationComposerModes,
} from "./ConversationComposerMenu.js";

export type ConversationComposerHandle = Pick<ChatComposerInputHandle, "focus"> & {
  openResources: (kind?: "skill" | "agent") => void;
};

export interface ConversationComposerProps {
  readonly commands?: ComposerCommands | undefined;
  readonly resources?: ComposerResources | undefined;
  readonly inputRef?: Ref<ConversationComposerHandle> | undefined;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: (value: ComposerSubmitValue) => void;
  readonly status: ComposerStatus;
  readonly startedAt?: number | undefined;
  readonly behavior?: ComposerBehavior | undefined;
  readonly onBehaviorChange?: ((behavior: ComposerBehavior) => void) | undefined;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly submitDisabled?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly statusText?: string | undefined;
  readonly options?: readonly ComposerOptionView[] | undefined;
  readonly selectedOption?: string | undefined;
  readonly onOptionChange?: ((value: string) => void) | undefined;
  readonly onAttach?: (() => void) | undefined;
  readonly modes?: ConversationComposerModes | undefined;
  readonly onSetGoal?: (() => void) | undefined;
  readonly goalDisabled?: boolean | undefined;
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

const runningPhrases = ["正在琢磨…", "正在梳理…", "正在推敲…", "正在打磨…", "正在权衡…"];

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function RunningStatus({ startedAt }: { readonly startedAt: number }) {
  const [now, setNow] = useState<number | undefined>(undefined);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedSeconds =
    now === undefined ? undefined : Math.max(0, Math.floor((now - startedAt) / 1_000));
  const phraseIndex =
    elapsedSeconds === undefined || reducedMotion
      ? 0
      : Math.floor(elapsedSeconds / 20) % runningPhrases.length;

  return (
    <span className="conversation-composer__status-live" aria-hidden="true">
      <span className="conversation-composer__status-activity">{runningPhrases[phraseIndex]}</span>
      {elapsedSeconds !== undefined && (
        <>
          <span className="conversation-composer__status-separator">·</span>
          <time className="conversation-composer__status-time">
            {formatElapsed(elapsedSeconds)}
          </time>
        </>
      )}
    </span>
  );
}

function defaultBehavior(status: ComposerStatus): ComposerBehavior {
  return status === "idle" ? "auto" : "steer";
}

export function ConversationComposer({
  commands,
  resources,
  inputRef,
  value,
  onValueChange,
  onSubmit,
  status,
  startedAt,
  behavior = defaultBehavior(status),
  onBehaviorChange,
  placeholder = "给 Pico 发消息",
  disabled = false,
  submitDisabled = false,
  busy = false,
  statusText,
  options = [],
  selectedOption,
  onOptionChange,
  onAttach,
  modes,
  onSetGoal,
  goalDisabled,
  onPause,
  onResume,
  onStop,
  leadingAccessory,
  trailingAccessory,
}: ConversationComposerProps) {
  const editorRef = useRef<ChatComposerInputHandle>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(
    inputRef,
    () => ({
      focus: () => editorRef.current?.focus(),
      openResources: (kind = "skill") => {
        editorRef.current?.focus();
        editorRef.current?.insertText(` /${kind} `);
      },
    }),
    [],
  );
  const commandMenu = useCommandSuggestions(value, onValueChange, commands, resources, editableRef);
  const statusId = useId();
  const canSubmit = value.trim().length > 0 && !disabled && !submitDisabled && !busy;
  const effectiveBehavior = status === "idle" ? "auto" : behavior === "auto" ? "steer" : behavior;
  const defaultStatusText =
    statusText ??
    (busy
      ? "正在发送…"
      : status === "running"
        ? "正在处理…"
        : status === "paused"
          ? "已暂停"
          : undefined);
  const resolvedStatusText =
    status === "pause_requested"
      ? ["等待暂停，将在安全边界暂停", statusText].filter(Boolean).join(" · ")
      : defaultStatusText;
  const showLiveRunStatus = status === "running" && !busy && !statusText && startedAt !== undefined;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ text: value.trim(), behavior: effectiveBehavior });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (commandMenu.onKeyDown(event)) return;
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      className="conversation-composer"
      data-status={status}
      data-behavior={effectiveBehavior}
      data-has-value={value.trim().length > 0 || undefined}
      aria-label="消息输入"
      aria-busy={busy}
      onSubmit={handleSubmit}
    >
      {commandMenu.menu}
      <ChatComposer
        className="pico-astryx-composer"
        value={value}
        onChange={onValueChange}
        onSubmit={submit}
        isDisabled={disabled}
        elevation="none"
        input={
          <ChatComposerInput
            {...commandMenu.inputProps}
            handleRef={editorRef}
            className="pico-chat-input"
            value={value}
            onChange={onValueChange}
            onSubmit={submit}
            hasHistory={false}
            pasteAsToken={false}
            maxRows={200 / 22}
            label="消息"
            isDisabled={disabled}
            placeholder={placeholder}
            aria-describedby={resolvedStatusText ? statusId : undefined}
            onKeyDown={handleKeyDown}
          />
        }
        footerActions={
          <div className="conversation-composer__controls">
            <ConversationComposerMenu
              onAttach={onAttach}
              modes={modes}
              onSetGoal={onSetGoal}
              goalDisabled={goalDisabled}
              disabled={disabled || busy}
            >
              {leadingAccessory}
            </ConversationComposerMenu>
            {options.length > 0 && (
              <Selector
                className="conversation-context-option"
                label="会话选项"
                isLabelHidden
                variant="ghost"
                size="sm"
                value={selectedOption}
                isDisabled={disabled || !onOptionChange}
                onChange={onOptionChange}
                options={options.map(({ value, label }) => ({ value, label }))}
              />
            )}
          </div>
        }
        sendActions={
          <div className="conversation-composer__actions">
            {status !== "idle" && (
              <Selector
                className="conversation-behavior"
                label="运行中消息行为"
                isLabelHidden
                variant="ghost"
                size="sm"
                value={effectiveBehavior}
                isDisabled={disabled || !onBehaviorChange}
                onChange={(next) => onBehaviorChange?.(next as ComposerBehavior)}
                options={Object.entries(behaviorLabels).map(([value, label]) => ({ value, label }))}
              />
            )}
            {resolvedStatusText && (
              <span
                id={statusId}
                className="conversation-composer__status"
                role="status"
                aria-label={showLiveRunStatus ? "Pico 正在处理" : undefined}
              >
                {showLiveRunStatus ? <RunningStatus startedAt={startedAt} /> : resolvedStatusText}
              </span>
            )}
            {trailingAccessory}
            {status === "running" && onPause && (
              <Button
                label="暂停运行"
                isIconOnly
                icon={<Pause aria-hidden="true" />}
                variant="ghost"
                size="sm"
                className="conversation-icon-button"
                onClick={onPause}
              />
            )}
            {status === "paused" && onResume && (
              <Button
                label="继续运行"
                isIconOnly
                icon={<Play aria-hidden="true" />}
                variant="ghost"
                size="sm"
                className="conversation-icon-button"
                onClick={onResume}
              />
            )}
            {status !== "idle" && onStop && (
              <Button
                label="停止运行"
                isIconOnly
                icon={<Square aria-hidden="true" />}
                variant="ghost"
                size="sm"
                className="conversation-icon-button"
                onClick={onStop}
              />
            )}
          </div>
        }
        sendButton={
          <Button
            type="submit"
            className="conversation-send-button"
            isDisabled={!canSubmit}
            isIconOnly
            icon={<ArrowUp aria-hidden="true" />}
            size="sm"
            label={
              effectiveBehavior === "queue"
                ? "将消息排到下一轮"
                : effectiveBehavior === "replace"
                  ? "停止当前执行并发送"
                  : "发送消息"
            }
          />
        }
      />
    </form>
  );
}
