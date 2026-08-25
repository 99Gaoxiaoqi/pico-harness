import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopRuntimeService } from "../../src/daemon/desktop-runtime-service.js";
import { createRuntimeRequest } from "../../src/daemon/protocol.js";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import {
  CredentialNotFoundError,
  credentialRefForProvider,
  type CredentialRef,
  type CredentialVault,
} from "../../src/provider/credential-vault.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { runWorkspaceDoctor } from "../../src/diagnostics/workspace-doctor.js";

const PROVIDER_ID = "doctor-fixture";
const MODEL_ID = "doctor-model";
const API_KEY_ENV = "PICO_DOCTOR_FIXTURE_API_KEY";

for (const source of ["config", "environment", "keychain"] as const) {
  test(`Desktop Workspace Doctor reports ${source} credentials from effective Runtime`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), `pico-workspace-doctor-${source}-`));
    const picoHome = join(root, "pico-home");
    const workspace = join(root, "workspace");
    const secret = `synthetic-doctor-${source}-secret`;
    await mkdir(workspace, { recursive: true });

    const userConfigStore = new UserConfigStore({ picoHome });
    const initial = await userConfigStore.read();
    await userConfigStore.write(
      {
        version: 1,
        defaults: { modelRouteId: `${PROVIDER_ID}/${MODEL_ID}` },
        providers: {
          [PROVIDER_ID]: {
            protocol: "openai",
            baseURL: "https://doctor.example.test/v1",
            apiKeyEnv: API_KEY_ENV,
            ...(source === "config" ? { apiKey: secret } : {}),
            models: [MODEL_ID],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: initial.revision },
    );

    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(await realpath(workspace));
    const credentialVault = memoryVault();
    if (source === "keychain") {
      await credentialVault.put(
        credentialRefForProvider({
          providerId: PROVIDER_ID,
          protocol: "openai",
          baseURL: "https://doctor.example.test/v1",
        }),
        secret,
      );
    }
    const env = {
      PICO_HOME: picoHome,
      ...(source === "environment" ? { [API_KEY_ENV]: secret } : {}),
    };
    const runtime = new WorkspaceRuntimeService({
      env,
      execute: async () => undefined,
    });
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      userConfigStore,
      trustStore,
      credentialVault,
      env,
    });
    context.after(async () => {
      await desktop.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    });

    const report = asRecord(
      await desktop.handle(createRuntimeRequest("diagnostics.run", { workspacePath: workspace })),
    );
    const output = String(report["output"]);
    assert.match(
      output,
      new RegExp(`Configuration default: ${PROVIDER_ID}/${MODEL_ID} \\(source=user\\)`, "u"),
    );
    assert.match(
      output,
      new RegExp(`Configuration providers: ${PROVIDER_ID}=user/credential-${source}`, "u"),
    );
    assert.match(output, /Provider routes: doctor-fixture provided by user configuration/u);
    assert.match(
      output,
      new RegExp(`Provider credentials: doctor-fixture available from ${source}`, "u"),
    );
    assert.equal(JSON.stringify(report).includes(secret), false, "Doctor must not expose secrets");

    const credentialCheck = asArray(report["checks"])
      .map(asRecord)
      .find((check) => check["id"] === "api-key");
    assert.equal(credentialCheck?.["status"], "ok");
  });
}

test("Workspace Doctor does not use another Provider credential to bless the default route", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-doctor-default-missing-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const report = await runWorkspaceDoctor({
    workDir: workspace,
    picoHome: join(root, "pico-home"),
    provider: "default-provider",
    model: "default-model",
    taskRuntimeAvailable: true,
    configuration: {
      defaultModelRouteId: "default-provider/default-model",
      defaultProviderId: "default-provider",
      defaultSource: "user",
      providerSources: {
        "default-provider": "user",
        "other-provider": "project",
      },
      credentialStates: {
        "default-provider": "missing",
        "other-provider": "environment",
      },
    },
  });
  const credentialCheck = report.checks.find((check) => check.id === "api-key");
  assert.equal(credentialCheck?.status, "warning");
  assert.equal(credentialCheck?.summary, "missing for default-provider");
  assert.match(report.output, /Provider credentials: missing for default-provider/u);
});

function memoryVault(): CredentialVault {
  const secrets = new Map<CredentialRef, string>();
  return {
    capability: () => ({
      available: true,
      backend: "macos-keychain",
      diagnostic: "synthetic in-memory doctor vault",
    }),
    async put(ref, secret) {
      secrets.set(ref, secret);
    },
    async resolve(ref) {
      const secret = secrets.get(ref);
      if (!secret) throw new CredentialNotFoundError(ref);
      return secret;
    },
    async has(ref) {
      return secrets.has(ref);
    },
    async delete(ref) {
      if (!secrets.delete(ref)) throw new CredentialNotFoundError(ref);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
