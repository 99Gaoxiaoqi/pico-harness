export interface LaunchModeInput {
  tui?: boolean;
  prompt?: string;
  positionals: readonly string[];
}

export function shouldStartTuiByDefault(input: LaunchModeInput): boolean {
  void input;
  return true;
}
