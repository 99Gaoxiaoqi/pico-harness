import { useCallback, useReducer, useState } from "react";
import { loadWorkbarState } from "./persistence.js";
import { createWorkbarState, reduceWorkbarState } from "./state.js";
import type { WorkbarAction, WorkbarState } from "./types.js";

/** Keep transient panel IDs with their session, including late close results. */
export function useSessionWorkbar(sessionKey: string) {
  const [initial] = useState(() => {
    const fallback = createWorkbarState();
    return typeof window === "undefined"
      ? fallback
      : loadWorkbarState(window.localStorage, fallback);
  });
  const [sessions, dispatch] = useReducer(
    (
      states: ReadonlyMap<string, WorkbarState>,
      update: { readonly sessionKey: string; readonly action: WorkbarAction },
    ) => {
      const previous = states.get(update.sessionKey) ?? initial;
      const next = reduceWorkbarState(previous, update.action);
      if (next === previous) return states;
      return new Map(states).set(update.sessionKey, next);
    },
    new Map<string, WorkbarState>(),
  );
  const dispatchAction = useCallback(
    (action: WorkbarAction) => dispatch({ sessionKey, action }),
    [sessionKey],
  );
  return [sessions.get(sessionKey) ?? initial, dispatchAction] as const;
}
