/** Public Host admission bounds for one Agent run. */
export const MIN_HOST_AGENT_MAX_TURNS = 1;
export const MAX_HOST_AGENT_MAX_TURNS = 200;

export function resolveHostAgentMaxTurns(value?: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_HOST_AGENT_MAX_TURNS ||
    value > MAX_HOST_AGENT_MAX_TURNS
  ) {
    throw new Error(
      `maxTurns 必须是 ${MIN_HOST_AGENT_MAX_TURNS}..${MAX_HOST_AGENT_MAX_TURNS} 范围内的整数`,
    );
  }
  return value;
}
