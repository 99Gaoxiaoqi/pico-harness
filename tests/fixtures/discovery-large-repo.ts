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
  readonly entryPath: string;
  readonly servicePath: string;
  readonly routerPath: string;
  readonly verificationPath: string;
  readonly targetPath: string;
  readonly targetSymbol: string;
  readonly expectedCanary: string;
  readonly sourcePaths: readonly string[];
  readonly decoyPaths: readonly string[];
  readonly sameSymbolDecoyPaths: readonly string[];
}

/**
 * Builds a deterministic large-repository shape with one randomized production target after Repo
 * Map's default 200-file scan batch. The task exposes only an observable behavior and verification
 * command; locating the target requires following a four-file call chain past same-symbol decoys.
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
  const sameSymbolDecoyPaths = decoyPaths.slice(0, 3);
  for (let offset = 0; offset < decoyPaths.length; offset += 25) {
    await Promise.all(
      decoyPaths.slice(offset, offset + 25).map((path, batchIndex) => {
        const ordinal = offset + batchIndex;
        const exportedSymbol =
          ordinal < sameSymbolDecoyPaths.length
            ? targetSymbol
            : `decoyPolicy_${String(ordinal).padStart(4, "0")}`;
        return writeFile(
          path,
          [
            `export function ${exportedSymbol}() {`,
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

  const entryAbsolutePath = join(workDir, "apps", "api", "policy-entry.mjs");
  const serviceAbsolutePath = join(workDir, "src", "services", "policy-service.mjs");
  const routerAbsolutePath = join(workDir, "src", "domain", "policy-router.mjs");
  const verificationAbsolutePath = join(workDir, "scripts", "verify-production-policy.mjs");
  await mkdir(join(workDir, "apps", "api"), { recursive: true });
  await mkdir(join(workDir, "src", "services"), { recursive: true });
  await mkdir(join(workDir, "src", "domain"), { recursive: true });
  await mkdir(join(workDir, "scripts"), { recursive: true });
  await writeFile(
    entryAbsolutePath,
    [
      'import { resolveRequestPolicy } from "../../src/services/policy-service.mjs";',
      "export function handleProductionRequest(request = {}) {",
      "  return resolveRequestPolicy(request);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    serviceAbsolutePath,
    [
      'import { selectRuntimePolicy } from "../domain/policy-router.mjs";',
      "export function resolveRequestPolicy(request) {",
      '  return selectRuntimePolicy({ channel: request.channel ?? "production" });',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    routerAbsolutePath,
    [
      `import { ${targetSymbol} } from "../../z-target/policy-${nonce}.mjs";`,
      "export function selectRuntimePolicy(context) {",
      `  return ${targetSymbol}(context);`,
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    verificationAbsolutePath,
    [
      'import { handleProductionRequest } from "../apps/api/policy-entry.mjs";',
      'const actual = handleProductionRequest({ channel: "production" });',
      `if (actual !== ${JSON.stringify(expectedCanary)}) {`,
      "  throw new Error(`expected production policy canary, received ${actual}`);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const taskAbsolutePath = join(workDir, "TASK.md");
  await writeFile(
    taskAbsolutePath,
    [
      "A production API request currently resolves to the legacy policy value.",
      "Trace the production request path from its runnable entrypoint to the implementation that actually supplies that value.",
      "The repository contains archived and test-like policy implementations that are not on the production call path.",
      `After approval, make the production behavior return exactly ${expectedCanary}.`,
      "The deterministic acceptance command is: node scripts/verify-production-policy.mjs",
      "Do not alter unrelated modules.",
      "",
    ].join("\n"),
    "utf8",
  );

  const relativePath = (path: string): string => relative(workDir, path).replaceAll("\\", "/");
  const targetPath = relativePath(targetAbsolutePath);
  const entryPath = relativePath(entryAbsolutePath);
  const servicePath = relativePath(serviceAbsolutePath);
  const routerPath = relativePath(routerAbsolutePath);
  const verificationPath = relativePath(verificationAbsolutePath);
  return {
    taskPath: relativePath(taskAbsolutePath),
    entryPath,
    servicePath,
    routerPath,
    verificationPath,
    targetPath,
    targetSymbol,
    expectedCanary,
    sourcePaths: [
      ...decoyPaths.map(relativePath),
      entryPath,
      servicePath,
      routerPath,
      targetPath,
      verificationPath,
    ],
    decoyPaths: decoyPaths.map(relativePath),
    sameSymbolDecoyPaths: sameSymbolDecoyPaths.map(relativePath),
  };
}
