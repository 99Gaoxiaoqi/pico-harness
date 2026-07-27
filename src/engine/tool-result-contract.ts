export type RuntimeToolResultStatus =
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled"
  | "interrupted";

export type RuntimeToolResultBody =
  | {
      readonly storage: "inline";
      readonly content: string;
      readonly sha256: string;
      readonly sizeBytes: number;
    }
  | {
      readonly storage: "evidence";
      readonly sha256: string;
      readonly sizeBytes: number;
    };

export interface RuntimeToolResultProjection {
  readonly version: 1;
  readonly mode: "full" | "preview" | "synthetic";
  readonly text: string;
  readonly strategy: string;
  readonly truncated: boolean;
}
