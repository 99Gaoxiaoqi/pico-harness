/** Session lifecycle intent after an entrypoint has resolved its arguments. */
export type RuntimeSessionSelectionMode = "new" | "continue" | "resume" | "fork";

/**
 * Stable Session selection passed from CLI, daemon, or another Host adapter to
 * Runtime. Argument parsing and catalog lookup deliberately remain outside Core.
 */
export type RuntimeSessionSelection =
  | {
      readonly mode: Exclude<RuntimeSessionSelectionMode, "fork">;
      readonly sessionId: string;
    }
  | {
      readonly mode: "fork";
      readonly sessionId: string;
      readonly sourceSessionId: string;
    };
