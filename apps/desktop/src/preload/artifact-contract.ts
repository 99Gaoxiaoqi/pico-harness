import type { DesktopResult } from "./contract.js";

export const DESKTOP_ARTIFACT_CHANNELS = {
  open: "pico:artifact:open",
  saveAs: "pico:artifact:save-as",
} as const;

export interface DesktopArtifactReference {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly artifactId: string;
}

export interface DesktopArtifactsApi {
  open(reference: DesktopArtifactReference): Promise<DesktopResult<void>>;
  saveAs(reference: DesktopArtifactReference): Promise<DesktopResult<void>>;
}

export function isArtifactReference(value: unknown): value is DesktopArtifactReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = ["workspacePath", "sessionId", "artifactId"];
  return (
    Object.keys(input).length === keys.length &&
    keys.every(
      (key) =>
        typeof input[key] === "string" && input[key].trim().length > 0 && input[key].length <= 4096,
    )
  );
}
