import { Check, ListTodo, Plus, Sparkles, Workflow, Network } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface ConversationComposerModes {
  readonly planActive: boolean;
  readonly graphActive: boolean;
  readonly swarmActive?: boolean;
  readonly onSwarmChange?: (active: boolean) => void | Promise<void>;
  readonly disabled?: boolean | undefined;
  readonly onPlanChange: (active: boolean) => void | Promise<void>;
  readonly onGraphChange: (active: boolean) => void | Promise<void>;
}

/** Keep mode choices in the plus menu; only active modes occupy the composer footer. */
export function ConversationComposerMenu({
  children,
  modes,
  disabled = false,
  onAttach,
}: {
  children?: ReactNode;
  modes?: ConversationComposerModes | undefined;
  disabled?: boolean | undefined;
  onAttach?: (() => void) | undefined;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const locked = disabled || modes?.disabled || pending;
  const options = [
    {
      id: "plan",
      label: "Plan",
      Icon: ListTodo,
      active: modes?.planActive,
      change: modes?.onPlanChange,
    },
    {
      id: "swarm",
      label: "Swarm",
      Icon: Network,
      active: modes?.swarmActive,
      change: modes?.onSwarmChange,
    },
    {
      id: "graph",
      label: "Graph",
      Icon: Workflow,
      active: modes?.graphActive,
      change: modes?.onGraphChange,
    },
  ] as const;
  const items = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
  ];
  const close = () => {
    menu.current?.hidePopover();
    trigger.current?.focus();
  };
  const position = () => {
    if (!trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(232, window.innerWidth - 24);
    Object.assign(menu.current.style, {
      width: `${width}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      bottom: `${window.innerHeight - rect.top + 7}px`,
      maxHeight: `${Math.max(80, rect.top - 19)}px`,
    });
  };
  useLayoutEffect(() => {
    if (!open) return;
    position();
    items()[0]?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    const observer = new ResizeObserver(position);
    if (trigger.current) observer.observe(trigger.current.closest("form") ?? trigger.current);
    return () => {
      window.removeEventListener("resize", position);
      observer.disconnect();
    };
  }, [open]);
  useEffect(() => {
    if (disabled) menu.current?.hidePopover();
  }, [disabled]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const choices = items();
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    let target: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") target = choices[(index + 1) % choices.length];
    else if (event.key === "ArrowUp")
      target = choices[(index - 1 + choices.length) % choices.length];
    else if (event.key === "Home") target = choices[0];
    else if (event.key === "End") target = choices.at(-1);
    else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close();
      return;
    }
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  async function toggle(option: (typeof options)[number]) {
    if (locked || inFlight.current || !option.change) return;
    inFlight.current = true;
    setPending(true);
    try {
      await option.change(!option.active);
    } catch {
      // Session actions own error reporting; checked state follows the confirmed settings.
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="conversation-icon-button conversation-plus-trigger"
        disabled={disabled || (!onAttach && !modes)}
        popoverTarget={id}
        aria-label="添加上下文与模式"
        title="添加上下文与模式"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            menu.current?.showPopover();
          }
        }}
      >
        <Plus aria-hidden="true" />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label="添加上下文与模式"
        className="conversation-plus-menu"
        onBeforeToggle={(event) => {
          if (event.newState === "open") position();
        }}
        onToggle={(event) => setOpen(event.newState === "open")}
        onKeyDown={navigate}
      >
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={!onAttach || disabled}
          title={onAttach ? "选择 Skill 或子代理" : "选择项目后，可在空闲时添加 Skill 或子代理"}
          onClick={() => {
            close();
            onAttach?.();
          }}
        >
          <Sparkles aria-hidden="true" />
          <span>选择 Skill 或子代理</span>
        </button>
        {modes && (
          <>
            <div role="separator" className="conversation-plus-divider" />
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role={option.id === "plan" ? "menuitemcheckbox" : "menuitemradio"}
                aria-checked={option.active}
                disabled={locked}
                tabIndex={-1}
                title={
                  option.id === "plan"
                    ? "先规划，确认计划后执行"
                    : option.id === "swarm"
                      ? "并行处理独立任务，完成或遇到问题后统一汇总"
                      : "按任务依赖进行 Graph 编排"
                }
                onClick={() => void toggle(option)}
              >
                <option.Icon aria-hidden="true" />
                <span>{option.label}</span>
                {option.active && <Check className="conversation-plus-check" aria-hidden="true" />}
              </button>
            ))}
          </>
        )}
      </div>
      {children}
      {options
        .filter((option) => option.active)
        .map((option) => (
          <button
            key={option.id}
            type="button"
            className="conversation-mode-mark"
            data-mode={option.id}
            disabled={locked}
            aria-label={`关闭 ${option.label} 模式`}
            title={`${option.label} 模式已启用，点击关闭`}
            onClick={() => void toggle(option)}
          >
            <option.Icon aria-hidden="true" />
            {option.label}
          </button>
        ))}
    </>
  );
}
