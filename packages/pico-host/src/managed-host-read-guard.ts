import { SandboxViolationError, type SandboxProfile } from "./process-sandbox/index.js";
import type { BaseTool } from "./tool-registry-contract.js";

/** Fail closed for model-triggered host reads not yet representable in File Worker. */
export function guardManagedHostRead(
  tool: BaseTool,
  resolveSandbox: () => { readonly profile: SandboxProfile; readonly bypass?: boolean },
): BaseTool {
  return new Proxy(tool, {
    get(target, property) {
      if (property === "execute") {
        return async (args: string, context?: Parameters<BaseTool["execute"]>[1]) => {
          const sandbox = resolveSandbox();
          if (!(sandbox.bypass ?? sandbox.profile === "danger-full-access")) {
            throw new SandboxViolationError(
              "sandbox_unavailable",
              `${target.name()} 仍需宿主直接读取工作区；受限任务须先迁入 File Worker。`,
            );
          }
          return await target.execute(args, context);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
