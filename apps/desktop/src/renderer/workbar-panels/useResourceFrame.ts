import type { RuntimeSessionSubscriptionFrame } from "@pico/protocol";
import { useEffect, useRef } from "react";
import { workbarErrorMessage } from "./workbar-runtime.js";

export interface WorkbarResourceGate {
  readonly active: boolean;
  readonly sessionId: string;
  readonly resource: "tasks" | "artifacts" | "trace" | "context";
  readonly revision?: number;
  readonly watermark?: number;
}

export function shouldRefreshWorkbarResource(
  frame: RuntimeSessionSubscriptionFrame,
  gate: WorkbarResourceGate,
): boolean {
  if (
    !gate.active ||
    frame.type !== "subscription.resource_changed" ||
    frame.sessionId !== gate.sessionId ||
    frame.resource !== gate.resource
  ) {
    return false;
  }
  if (
    frame.revision !== undefined &&
    gate.revision !== undefined &&
    frame.revision <= gate.revision
  ) {
    return false;
  }
  if (
    frame.watermark !== undefined &&
    gate.watermark !== undefined &&
    frame.watermark <= gate.watermark
  ) {
    return false;
  }
  return true;
}

export function useResourceFrame(
  gate: WorkbarResourceGate,
  refresh: (watermark?: number) => unknown,
  onError?: (message: string) => void,
) {
  const refreshRef = useRef(refresh);
  const errorRef = useRef(onError);
  refreshRef.current = refresh;
  errorRef.current = onError;
  useEffect(() => {
    const subscription = window.pico.sessionFrames.subscribe((frame) => {
      if (!shouldRefreshWorkbarResource(frame, gate)) return;
      try {
        void Promise.resolve(
          refreshRef.current(
            frame.type === "subscription.resource_changed" ? frame.watermark : undefined,
          ),
        ).catch((cause: unknown) => errorRef.current?.(workbarErrorMessage(cause)));
      } catch (cause) {
        errorRef.current?.(workbarErrorMessage(cause));
      }
    });
    return () => subscription.dispose();
  }, [gate.active, gate.resource, gate.revision, gate.sessionId, gate.watermark]);
}
