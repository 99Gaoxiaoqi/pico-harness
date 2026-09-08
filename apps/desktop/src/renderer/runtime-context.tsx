import { createContext, useContext } from "react";
import type { RuntimeStore } from "./runtime.js";

export const RuntimeContext = createContext<RuntimeStore | null>(null);

export function useRuntime(): RuntimeStore {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("RuntimeContext is missing");
  return value;
}
