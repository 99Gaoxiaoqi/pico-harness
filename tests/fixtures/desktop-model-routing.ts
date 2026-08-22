import { UserConfigStore } from "../../src/input/user-config-store.js";

export const DESKTOP_TEST_MODEL_ENV = "PICO_TEST_TOKEN";

/** Write the device-level model route consumed by Desktop and TUI runtimes. */
export async function writeDesktopModelRouting(picoHome: string): Promise<void> {
  const store = new UserConfigStore({ picoHome });
  const current = await store.read();
  await store.write(
    {
      version: 1,
      defaults: { modelRouteId: "test/coder" },
      providers: {
        test: {
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: DESKTOP_TEST_MODEL_ENV,
          discoverModels: false,
          models: ["coder"],
        },
      },
    },
    { expectedRevision: current.revision },
  );
}
