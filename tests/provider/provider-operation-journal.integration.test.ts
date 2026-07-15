import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PicoUserConfig } from "../../src/input/user-config-store.js";
import { credentialRefForProvider } from "../../src/provider/credential-vault.js";
import {
  ProviderOperationConflictError,
  ProviderOperationJournal,
  type ProviderOperationPrepareInput,
} from "../../src/provider/provider-operation-journal.js";

const EMPTY_REVISION = createHash("sha256").update("").digest("hex");
const NEXT_REVISION = createHash("sha256").update("next").digest("hex");

describe("ProviderOperationJournal", () => {
  it("persists one non-secret operation atomically with secure permissions and id OCC", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-provider-operation-"));
    const picoHome = join(root, "home");
    try {
      const journal = new ProviderOperationJournal({ picoHome });
      const input = operationInput("import", "alpha");
      const record = await journal.prepare(input);

      expect(record).toMatchObject({
        kind: "import",
        phase: "prepared",
        credentialExistedBefore: false,
        preparedConfigRevision: EMPTY_REVISION,
        configRevision: EMPTY_REVISION,
      });
      expect((await lstat(picoHome)).mode & 0o777).toBe(0o700);
      expect((await lstat(journal.filePath)).mode & 0o777).toBe(0o600);
      const raw = await readFile(journal.filePath, "utf8");
      expect(raw).not.toContain("super-secret-value");
      expect(JSON.parse(raw)).toEqual(record);
      expect((await readdir(picoHome)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

      await expect(journal.prepare(operationInput("delete", "beta"))).rejects.toBeInstanceOf(
        ProviderOperationConflictError,
      );
      await expect(
        journal.update(randomUUID(), { phase: "credential-imported" }),
      ).rejects.toBeInstanceOf(ProviderOperationConflictError);

      const credentialImported = await journal.update(record.operationId, {
        phase: "credential-imported",
      });
      expect(credentialImported.phase).toBe("credential-imported");
      await expect(journal.update(record.operationId, { phase: "prepared" })).rejects.toThrow(
        /phase/u,
      );

      const committed = await journal.update(record.operationId, {
        phase: "config-committed",
        configRevision: NEXT_REVISION,
      });
      expect(committed.configRevision).toBe(NEXT_REVISION);
      await expect(journal.clear(randomUUID())).rejects.toBeInstanceOf(
        ProviderOperationConflictError,
      );
      await journal.clear(record.operationId);
      await expect(journal.read()).resolves.toBeUndefined();
      await expect(journal.clear(record.operationId)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes competing prepares without exposing a partially written journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-provider-operation-race-"));
    const picoHome = join(root, "home");
    try {
      const left = new ProviderOperationJournal({ picoHome });
      const right = new ProviderOperationJournal({ picoHome });
      const outcomes = await Promise.allSettled([
        left.prepare(operationInput("import", "left")),
        right.prepare(operationInput("delete", "right")),
      ]);
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof left.prepare>>> =>
          outcome.status === "fulfilled",
      );
      expect(fulfilled).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      await expect(left.read()).resolves.toEqual(fulfilled[0]!.value);
      expect(JSON.parse(await readFile(left.filePath, "utf8"))).toEqual(fulfilled[0]!.value);
      expect((await readdir(picoHome)).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown fields, corrupt schemas, and symlink-backed storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-provider-operation-invalid-"));
    const picoHome = join(root, "home");
    try {
      const journal = new ProviderOperationJournal({ picoHome });
      const withSecret = {
        ...operationInput("import", "secret-attempt"),
        secret: "super-secret-value",
      } as ProviderOperationPrepareInput;
      await expect(journal.prepare(withSecret)).rejects.toThrow(/field|secret|字段/iu);
      await expect(readFile(journal.filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await mkdir(picoHome, { recursive: true });
      await writeFile(
        journal.filePath,
        `${JSON.stringify({ schemaVersion: 1, secret: "super-secret-value" })}\n`,
        { mode: 0o600 },
      );
      await expect(journal.read()).rejects.toThrow(/字段|root/u);

      await rm(journal.filePath);
      const outside = join(root, "outside.json");
      await writeFile(outside, "{}\n", { mode: 0o600 });
      await symlink(outside, journal.filePath);
      await expect(journal.read()).rejects.toThrow(/普通文件/u);

      const actualHome = join(root, "actual-home");
      const linkedHome = join(root, "linked-home");
      await mkdir(actualHome);
      await symlink(actualHome, linkedHome);
      await expect(new ProviderOperationJournal({ picoHome: linkedHome }).read()).rejects.toThrow(
        /符号链接/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function operationInput(
  kind: ProviderOperationPrepareInput["kind"],
  providerId: string,
): ProviderOperationPrepareInput {
  const configured: PicoUserConfig = {
    version: 1,
    defaults: { modelRouteId: `${providerId}/gpt-5` },
    providers: {
      [providerId]: {
        protocol: "openai",
        baseURL: `https://${providerId}.example.test/v1`,
        apiKeyEnv: "OPENAI_API_KEY",
        models: ["gpt-5"],
        discoverModels: false,
      },
    },
  };
  const empty: PicoUserConfig = { version: 1, providers: {} };
  const previousUserConfig = kind === "import" ? empty : configured;
  const targetUserConfig = kind === "import" ? configured : empty;
  return {
    kind,
    previousUserConfig,
    targetUserConfig,
    credentialRef: credentialRefForProvider({
      providerId,
      protocol: "openai",
      baseURL: `https://${providerId}.example.test/v1`,
    }),
    credentialExistedBefore: false,
    configRevision: EMPTY_REVISION,
  };
}
