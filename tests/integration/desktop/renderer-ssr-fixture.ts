import { registerHooks } from "node:module";
import * as React from "react";

/** Supply browser-only imports and tsx's classic JSX runtime before loading renderer modules. */
export function installRendererSsr() {
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  const stylesheetHook = registerHooks({
    load(url, context, nextLoad) {
      return url.endsWith(".css")
        ? { format: "module", source: "export {};", shortCircuit: true }
        : nextLoad(url, context);
    },
  });
  return () => {
    stylesheetHook.deregister();
    if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
    else Reflect.deleteProperty(globalThis, "React");
  };
}
