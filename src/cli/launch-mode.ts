export interface LaunchModeInput {
  tui?: boolean;
  prompt?: string;
  positionals: readonly string[];
}

export function shouldStartTuiByDefault(input: LaunchModeInput): boolean {
  if (input.tui === true) return true;
  if (input.prompt !== undefined) return false;
  return input.positionals.length === 0;
}
