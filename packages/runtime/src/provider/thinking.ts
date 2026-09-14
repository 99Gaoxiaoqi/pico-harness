// 统一思考强度 (ThinkingEffort) 抽象层。
//
// ThinkingEffort 控制模型原生 reasoning 能力，通过模型路由的能力
// profile 将当前档位翻译为各厂商的请求参数。

/** 统一思考强度档位。 */
export type ThinkingEffort = "off" | "low" | "medium" | "high";

/** always-thinking 模型在用户请求 off 时使用的当前默认档位。 */
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "high";

const VALID_EFFORTS = new Set<ThinkingEffort>(["off", "low", "medium", "high"]);

/** 判断字符串是否为当前 ThinkingEffort 档位。 */
export function isValidThinkingEffort(value: string): value is ThinkingEffort {
  return VALID_EFFORTS.has(value as ThinkingEffort);
}

/** 对无法关闭推理的模型，把 off 提升到默认档位。 */
export function clampThinkingEffort(
  effort: ThinkingEffort,
  alwaysThinking: boolean,
): ThinkingEffort {
  if (effort === "off" && alwaysThinking) {
    return DEFAULT_THINKING_EFFORT;
  }
  return effort;
}
