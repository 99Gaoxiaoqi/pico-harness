import type {
  RuntimeMemoryItem,
  RuntimeMemoryListItem,
  RuntimeMemoryPageInfo,
  RuntimeResult,
} from "@pico/protocol";

/** Read-only settings overview; mutations still go through the selected workspace. */
export type MemoryScopeTab = "saved" | "archived" | "pending" | "usage";
export interface MemoryScopePage {
  readonly memory?: {
    readonly items: readonly (RuntimeMemoryItem | RuntimeMemoryListItem)[];
    readonly pageInfo?: RuntimeMemoryPageInfo;
    readonly learningVersion?: 2;
  };
  readonly suggestions?: RuntimeResult<"memory.learning.query">;
  readonly usage?: RuntimeResult<"memory.experience.query">;
}
