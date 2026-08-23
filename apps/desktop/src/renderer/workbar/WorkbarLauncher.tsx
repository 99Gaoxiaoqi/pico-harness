import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { WORKBAR_TOOL_REGISTRY, type WorkbarToolDefinition } from "./registry.js";
import type { WorkbarDock, WorkbarToolKind } from "./types.js";

export interface WorkbarLauncherAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface WorkbarLauncherProps {
  readonly dock: WorkbarDock;
  readonly tools?: readonly WorkbarToolDefinition[];
  readonly availability?: ((kind: WorkbarToolKind) => WorkbarLauncherAvailability) | undefined;
  readonly renderIcon?: ((kind: WorkbarToolKind) => ReactNode) | undefined;
  readonly onOpen: (kind: WorkbarToolKind, dock: WorkbarDock) => void;
  readonly onClose: () => void;
}

export function WorkbarLauncher({
  dock,
  tools = WORKBAR_TOOL_REGISTRY,
  availability,
  renderIcon,
  onOpen,
  onClose,
}: WorkbarLauncherProps) {
  const buttonRefs = useRef(new Map<WorkbarToolKind, HTMLButtonElement>());

  useEffect(() => {
    const first = tools.find((tool) => availability?.(tool.kind).available !== false);
    if (first) buttonRefs.current.get(first.kind)?.focus();
  }, [availability, tools]);

  const focusAt = (requestedIndex: number) => {
    if (tools.length === 0) return;
    for (let offset = 0; offset < tools.length; offset += 1) {
      const index = (requestedIndex + offset + tools.length) % tools.length;
      const tool = tools[index];
      if (tool && availability?.(tool.kind).available !== false) {
        buttonRefs.current.get(tool.kind)?.focus();
        return;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const currentIndex = tools.findIndex(
      (tool) => buttonRefs.current.get(tool.kind) === document.activeElement,
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(currentIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(currentIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(tools.length - 1);
    }
  };

  return (
    <div
      className="session-workbar__launcher-menu session-workbar__launcher-menu--full"
      role="menu"
      aria-label={`在${dock === "right" ? "右侧" : "底部"}工作栏打开工具`}
      onKeyDown={handleKeyDown}
    >
      <header>
        <strong>打开工具</strong>
        <span>{dock === "right" ? "右侧" : "底部"}工作栏</span>
      </header>
      {tools.map((tool) => {
        const status = availability?.(tool.kind) ?? { available: true };
        return (
          <button
            key={tool.kind}
            ref={(node) => {
              if (node) buttonRefs.current.set(tool.kind, node);
              else buttonRefs.current.delete(tool.kind);
            }}
            type="button"
            role="menuitem"
            data-kind={tool.kind}
            disabled={!status.available}
            aria-describedby={
              status.reason ? `workbar-tool-${dock}-${tool.kind}-reason` : undefined
            }
            onClick={() => onOpen(tool.kind, dock)}
          >
            <span className="session-workbar__launcher-icon" aria-hidden="true">
              {renderIcon?.(tool.kind)}
            </span>
            <span className="session-workbar__launcher-copy">
              <span className="session-workbar__launcher-title">
                <strong>{tool.label}</strong>
                {tool.shortcut && <kbd>{tool.shortcut}</kbd>}
              </span>
              <span>{tool.description}</span>
              {status.reason && (
                <span
                  id={`workbar-tool-${dock}-${tool.kind}-reason`}
                  className="session-workbar__launcher-reason"
                >
                  {status.reason}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
