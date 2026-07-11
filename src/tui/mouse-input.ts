import { useCallback, useEffect, useRef } from "react";
import { useStdout } from "ink";
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  setTerminalMouseTrackingMode,
} from "./terminal-grid.js";

export { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING };

export type SgrMouseInput =
  | { kind: "wheel"; direction: "up" | "down"; column: number; row: number }
  | { kind: "other"; column: number; row: number };

/**
 * Parse one SGR mouse report after Ink has decoded stdin. Ink strips the leading
 * escape byte before calling useInput, while render harnesses may retain it, so
 * both forms are accepted here.
 */
export function parseSgrMouseInput(input: string): SgrMouseInput | null {
  const normalized = input.startsWith("\u001b") ? input.slice(1) : input;
  const match = /^\[<(\d+);(\d+);(\d+)[Mm]$/u.exec(normalized);
  if (!match) return null;

  const button = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  // Modifier bits (Shift/Alt/Ctrl) do not change wheel direction.
  const unmodifiedButton = button & ~0b11100;
  if (unmodifiedButton === 64 || unmodifiedButton === 65) {
    return {
      kind: "wheel",
      direction: unmodifiedButton === 64 ? "up" : "down",
      column,
      row,
    };
  }
  return { kind: "other", column, row };
}

export interface TerminalMouseMode {
  enable: () => void;
  disable: () => void;
}

/**
 * Enable normal mouse tracking plus SGR coordinates for the lifetime of the Ink
 * tree. Normal tracking is enough for wheel input and avoids drag-motion noise.
 * Mouse-aware terminals keep native text selection available via Shift+drag.
 */
export function useTerminalMouseMode(): TerminalMouseMode {
  const { stdout } = useStdout();
  const mounted = useRef(false);
  const enabled = useRef(false);

  const enable = useCallback(() => {
    if (!mounted.current || !stdout.isTTY) return;
    setTerminalMouseTrackingMode(stdout, true);
    enabled.current = true;
  }, [stdout]);

  const disable = useCallback(() => {
    if (!enabled.current || !stdout.isTTY) return;
    setTerminalMouseTrackingMode(stdout, false);
    enabled.current = false;
  }, [stdout]);

  useEffect(() => {
    mounted.current = true;
    enable();
    stdout.on("resize", enable);
    return () => {
      stdout.off("resize", enable);
      disable();
      mounted.current = false;
    };
  }, [disable, enable]);

  return { enable, disable };
}

/** Suspend the current Unix process until its controlling shell resumes it. */
export async function suspendProcessUntilContinued(): Promise<void> {
  if (process.platform === "win32") return;
  await new Promise<void>((resolve, reject) => {
    const handleContinue = () => resolve();
    process.once("SIGCONT", handleContinue);
    try {
      process.kill(process.pid, "SIGTSTP");
    } catch (error) {
      process.off("SIGCONT", handleContinue);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
