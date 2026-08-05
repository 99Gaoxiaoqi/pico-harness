import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface DiscoveryLargeRepoFixtureOptions {
  readonly decoyCount?: number;
  readonly targetSymbol?: string;
  readonly expectedCanary?: string;
}

export interface DiscoveryLargeRepoFixture {
  readonly taskPath: string;
  readonly targetPath: string;
  readonly targetSymbol: string;
  readonly expectedCanary: string;
  readonly sourcePaths: readonly string[];
  readonly decoyPaths: readonly string[];
}

/**
 * Builds a deterministic large-repository shape with one randomized target after Repo Map's
 * default 200-file scan batch. The task names the symbol and behavior but never reveals its path.
 */
export async function createDiscoveryLargeRepoFixture(
  workDir: string,
  options: DiscoveryLargeRepoFixtureOptions = {},
): Promise<DiscoveryLargeRepoFixture> {
  const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
  const decoyCount = options.decoyCount ?? 205;
  if (!Number.isSafeInteger(decoyCount) || decoyCount < 200) {
    throw new Error("Discovery large-repo fixture requires at least 200 decoys");
  }
  const targetSymbol = options.targetSymbol ?? `resolvePolicy_${nonce}`;
  const expectedCanary = options.expectedCanary ?? `DISCOVERY_${nonce.toUpperCase()}`;
  const decoyDirectory = join(workDir, "a-decoys");
  const targetDirectory = join(workDir, "z-target");
  await mkdir(decoyDirectory, { recursive: true });
  await mkdir(targetDirectory, { recursive: true });

  const decoyPaths = Array.from({ length: decoyCount }, (_, index) =>
    join(decoyDirectory, `module-${String(index).padStart(4, "0")}.mjs`),
  );
  for (let offset = 0; offset < decoyPaths.length; offset += 25) {
    await Promise.all(
      decoyPaths.slice(offset, offset + 25).map((path, batchIndex) => {
        const ordinal = offset + batchIndex;
        return writeFile(
          path,
          [
            `export function decoyPolicy_${String(ordinal).padStart(4, "0")}() {`,
            `  return ${JSON.stringify(`DECOY_${ordinal}`)};`,
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
      }),
    );
  }

  const targetAbsolutePath = join(targetDirectory, `policy-${nonce}.mjs`);
  await writeFile(
    targetAbsolutePath,
    [`export function ${targetSymbol}() {`, '  return "LEGACY_POLICY";', "}", ""].join("\n"),
    "utf8",
  );
  const taskAbsolutePath = join(workDir, "TASK.md");
  await writeFile(
    taskAbsolutePath,
    [
      "A production request resolves to the legacy policy value.",
      `Locate the implementation of symbol ${targetSymbol} in this repository.`,
      `After approval, change that function to return exactly ${expectedCanary}.`,
      "Do not alter unrelated modules.",
      "",
    ].join("\n"),
    "utf8",
  );

  const relativePath = (path: string): string => relative(workDir, path).replaceAll("\\", "/");
  const targetPath = relativePath(targetAbsolutePath);
  return {
    taskPath: relativePath(taskAbsolutePath),
    targetPath,
    targetSymbol,
    expectedCanary,
    sourcePaths: [...decoyPaths.map(relativePath), targetPath],
    decoyPaths: decoyPaths.map(relativePath),
  };
}
