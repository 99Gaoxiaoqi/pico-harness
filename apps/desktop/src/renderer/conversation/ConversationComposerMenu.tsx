import { ListTodo, Plus, Sparkles, Workflow, Network, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuDivider,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";

export interface ConversationComposerModes {
  readonly planActive: boolean;
  readonly researchActive?: boolean;
  readonly onResearchChange?: (active: boolean) => void | Promise<void>;
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
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const locked = disabled || modes?.disabled || pending;
  const options = [
    {
      id: "research",
      label: "深度研究",
      Icon: Search,
      active: modes?.researchActive,
      change: modes?.onResearchChange,
    },
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
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

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
      <DropdownMenu
        className="pico-composer-menu"
        button={{
          label: "添加上下文与模式",
          icon: <Plus aria-hidden="true" />,
          isIconOnly: true,
          variant: "ghost",
          size: "sm",
          className: "conversation-icon-button conversation-plus-trigger",
          isDisabled: disabled || (!onAttach && !modes),
        }}
        hasChevron={false}
        placement="above"
        alignment="start"
        menuWidth={232}
        isMenuOpen={open}
        onOpenChange={setOpen}
      >
        <DropdownMenuItem
          label="选择 Skill 或子代理"
          icon={<Sparkles aria-hidden="true" />}
          isDisabled={!onAttach || disabled}
          onClick={() => onAttach?.()}
        />
        {modes && (
          <>
            <DropdownMenuDivider />
            {options
              .filter((option) => option.id === "plan" || option.id === "research")
              .map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.id}
                  label={option.label}
                  icon={<option.Icon aria-hidden="true" />}
                  value={Boolean(option.active)}
                  isDisabled={Boolean(locked)}
                  onChange={() => void toggle(option)}
                />
              ))}
            <DropdownMenuRadioGroup
              label="编排模式"
              value={modes.swarmActive ? "swarm" : modes.graphActive ? "graph" : undefined}
              hasCloseOnSelect={false}
              onChange={(id) => {
                const option = options.find((option) => option.id === id);
                if (option) void toggle(option);
              }}
            >
              {options
                .filter((option) => option.id === "swarm" || option.id === "graph")
                .map((option) => (
                  <DropdownMenuRadioItem
                    key={option.id}
                    value={option.id}
                    label={option.label}
                    icon={<option.Icon aria-hidden="true" />}
                    isDisabled={Boolean(locked)}
                  />
                ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenu>
      {children}
      {options
        .filter((option) => option.active)
        .map((option) => (
          <Button
            key={option.id}
            className="conversation-mode-mark"
            data-mode={option.id}
            isDisabled={Boolean(locked)}
            label={`关闭 ${option.label} 模式`}
            tooltip={`${option.label} 模式已启用，点击关闭`}
            onClick={() => void toggle(option)}
            icon={<option.Icon aria-hidden="true" />}
            variant="ghost"
            size="sm"
          >
            {option.label}
          </Button>
        ))}
    </>
  );
}
