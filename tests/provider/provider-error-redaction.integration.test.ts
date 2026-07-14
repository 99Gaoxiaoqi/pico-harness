import { afterEach, describe, expect, it, vi } from "vitest";
import { createRawProvider } from "../../src/provider/factory.js";

describe("Provider error redaction integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("在错误进入重试、日志和账本前移除响应回显的凭证", async () => {
    const secret = "provider-secret-that-must-not-leak";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: `request rejected for api_key=${secret}`, token: secret }),
            { status: 401 },
          ),
      ),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = createRawProvider("openai", {
      baseURL: "https://provider.example/v1",
      apiKey: secret,
      model: "test-model",
    });

    let thrown: unknown;
    try {
      await provider.generate([{ role: "user", content: "hello" }], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(REDACTED);
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).stack).not.toContain(secret);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

const REDACTED = "[REDACTED]";
