export type SwarmCommand =
  | { readonly kind: "status" }
  | { readonly kind: "set_mode"; readonly mode: "swarm" | "default" }
  | { readonly kind: "run_once"; readonly task: string };

/** Exact command tokens; arbitrary task text is never case-normalized. */
export function parseSwarmCommand(input: string): SwarmCommand | undefined {
  const text = input.trim();
  const token = text.split(/\s+/, 1)[0];
  if (token !== "/swarm") return undefined;
  const tail = text.slice(token.length).trim();
  if (!tail || tail === "status") return { kind: "status" };
  if (tail === "on") return { kind: "set_mode", mode: "swarm" };
  if (tail === "off") return { kind: "set_mode", mode: "default" };
  return { kind: "run_once", task: tail };
}
