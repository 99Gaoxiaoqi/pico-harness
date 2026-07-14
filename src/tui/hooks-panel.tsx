import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { HookManagementItem, HookManagementService } from "../hooks/management/service.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { truncateTerminalText } from "./terminal-width.js";

export const HOOKS_PANEL_DIALOG_ID = "local-ui:hooks";

export interface HooksPanelProps {
  management: HookManagementService;
  onClose(): void;
}

export function createHooksPanelDialogRequest(
  management: HookManagementService,
  onClose: () => void,
): DialogRequest {
  return {
    id: HOOKS_PANEL_DIALOG_ID,
    layer: "modal",
    priority: 45,
    content: <HooksPanel management={management} onClose={onClose} />,
  };
}

/** 只操作 handler id，不接收或编辑任意命令字符串。 */
export function HooksPanel({ management, onClose }: HooksPanelProps): React.ReactNode {
  const [items, setItems] = useState<readonly HookManagementItem[]>(() => management.list());
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("");
  const [confirmTrust, setConfirmTrust] = useState<string>();
  const [busy, setBusy] = useState(false);
  const item = items[Math.min(selected, Math.max(0, items.length - 1))];

  const run = (action: () => Promise<string>): void => {
    if (busy) return;
    setBusy(true);
    void action()
      .then((nextMessage) => {
        setMessage(nextMessage);
        setItems(management.list());
        setConfirmTrust(undefined);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow && items.length > 0) {
      setSelected((current) => (current - 1 + items.length) % items.length);
      setConfirmTrust(undefined);
      return;
    }
    if (key.downArrow && items.length > 0) {
      setSelected((current) => (current + 1) % items.length);
      setConfirmTrust(undefined);
      return;
    }
    if (!item || busy) return;
    if (key.return) {
      run(async () => truncateTerminalText(JSON.stringify(await management.review(item.id)), 500));
      return;
    }
    if (_input.toLowerCase() === "r") {
      run(async () => ((await management.reload()) ? "Hooks reloaded" : "Hook reload rejected"));
      return;
    }
    if (_input.toLowerCase() === "e") {
      run(async () => {
        if (item.status === "disabled") {
          await management.enable(item.id);
          return `Enabled ${item.id}`;
        }
        await management.disable(item.id);
        return `Disabled ${item.id}`;
      });
      return;
    }
    if (_input.toLowerCase() === "t") {
      if (item.status !== "pending") {
        setMessage("Selected Hook is not pending trust");
      } else if (confirmTrust !== item.id) {
        setConfirmTrust(item.id);
        setMessage(`Press T again to trust ${item.id}`);
      } else {
        run(async () => {
          await management.trust(item.id);
          return `Trusted ${item.id}`;
        });
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="cyan">Hooks · {items.length} handlers</Text>
      <Text>
        {item
          ? `[${selected + 1}/${items.length}] ${item.event} ${item.type} ${item.status}`
          : "No Hooks configured"}
      </Text>
      <Text>{item ? truncateTerminalText(item.id, 100) : " "}</Text>
      <Text dimColor>↑/↓ 选择 · Enter 审查 · T×2 信任 · E 启停 · R 重载 · Esc 关闭</Text>
      <Text color={confirmTrust ? "yellow" : busy ? "cyan" : undefined}>
        {busy ? "Working…" : message || " "}
      </Text>
    </Box>
  );
}
