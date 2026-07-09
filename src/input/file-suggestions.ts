import {
  DEFAULT_FILE_SUGGESTION_LIMIT,
  FileIndex,
  type CommandRunner,
} from "./file-index.js";

export type { CommandRunner } from "./file-index.js";

export interface FileSuggestionOptions {
  cwd: string;
  query?: string;
  limit?: number;
  commandRunner?: CommandRunner;
  fileIndex?: FileIndex;
}

export async function listFileSuggestions(
  options: FileSuggestionOptions,
): Promise<string[]> {
  const limit = options.limit ?? DEFAULT_FILE_SUGGESTION_LIMIT;
  const index =
    options.fileIndex ??
    FileIndex.create({
      cwd: options.cwd,
      commandRunner: options.commandRunner,
    });

  return index.query(options.query ?? "", limit);
}
