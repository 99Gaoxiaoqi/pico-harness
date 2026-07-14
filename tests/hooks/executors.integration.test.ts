import { createServer, type Server } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultHookExecutor,
  type HookAgentVerifierRequest,
} from "../../src/hooks/executors/index.js";
import type { HookHandler, HookInput, ResolvedHookHandler } from "../../src/hooks/types.js";
import type { LLMProvider } from "../../src/provider/interface.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
          ),
      ),
  );
});

function resolved(handler: HookHandler, id = "handler-1"): ResolvedHookHandler {
  return {
    id,
    event: "PreToolUse",
    source: { kind: "local", path: ".claw/hooks.local.json", version: 1 },
    order: 0,
    matcher: "bash",
    handler,
    trusted: true,
  };
}

const input: HookInput<"PreToolUse"> = {
  session_id: "session-1",
  cwd: "/workspace",
  hook_event_name: "PreToolUse",
  payload: { tool_name: "bash", tool_input: { command: "echo ok" } },
  tool_name: "bash",
  tool_input: { command: "echo ok" },
};

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server 未监听 TCP");
  return `http://127.0.0.1:${address.port}`;
}

describe("DefaultHookExecutor command", () => {
  it("shell form 和 exec args form 都解析结构化决策", async () => {
    const executor = new DefaultHookExecutor({ workDir: process.cwd() });
    await expect(
      executor.execute(
        resolved({
          type: "command",
          command: `printf '{"decision":"block","reason":"shell denied"}'`,
        }),
        input,
        {},
      ),
    ).resolves.toMatchObject({ decision: "deny", reason: "shell denied" });

    const script = [
      "let data=''",
      "process.stdin.on('data', chunk => data += chunk)",
      "process.stdin.on('end', () => {",
      " const input = JSON.parse(data)",
      " process.stdout.write(JSON.stringify({decision:'ask', reason:input.tool_name}))",
      "})",
    ].join(";");
    await expect(
      executor.execute(
        resolved({ type: "command", command: process.execPath, args: ["-e", script] }),
        input,
        {},
      ),
    ).resolves.toMatchObject({ decision: "ask", reason: "bash" });
  });

  it("超时 fail-open 并返回 source/id 诊断", async () => {
    const executor = new DefaultHookExecutor({ workDir: process.cwd() });
    const result = await executor.execute(
      resolved({
        type: "command",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        timeoutMs: 20,
      }),
      input,
      {},
    );
    expect(result.decision).toBe("allow");
    expect(result.diagnostics?.[0]).toMatchObject({
      handlerId: "handler-1",
      source: { kind: "local", path: ".claw/hooks.local.json", version: 1 },
    });
  });

  it("父级取消原样上抛并终止 POSIX 进程组", async () => {
    if (process.platform === "win32") return;
    const workDir = await mkdtemp(join(tmpdir(), "pico-hook-abort-"));
    const sentinel = join(workDir, "descendant-ran");
    const childScript = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'), 250)`;
    const parentScript = [
      "const {spawn}=require('child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}])`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const executor = new DefaultHookExecutor({ workDir });
    const controller = new AbortController();
    const reason = new Error("parent stopped");
    const execution = executor.execute(
      resolved({ type: "command", command: process.execPath, args: ["-e", parentScript] }),
      input,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(reason), 30);

    await expect(execution).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("asyncRewake 启动后立即返回，完成时回唤", async () => {
    let rewake: ((value: unknown) => void) | undefined;
    const rewoken = new Promise((resolve) => {
      rewake = resolve;
    });
    const executor = new DefaultHookExecutor({
      workDir: process.cwd(),
      onAsyncRewake(_handler, output) {
        rewake?.(output);
      },
    });
    const started = Date.now();
    const result = await executor.execute(
      resolved({
        type: "command",
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log(JSON.stringify({decision:'defer'})), 80)"],
        asyncRewake: true,
      }),
      input,
      {},
    );
    expect(result).toEqual({ decision: "allow" });
    expect(Date.now() - started).toBeLessThan(70);
    await expect(rewoken).resolves.toMatchObject({ decision: "defer" });
    await executor.dispose();
  });

  it("dispose 终止 async command 进程树并拒绝迟到 rewake", async () => {
    if (process.platform === "win32") return;
    const workDir = await mkdtemp(join(tmpdir(), "pico-hook-async-dispose-"));
    const sentinel = join(workDir, "descendant-ran");
    const rewake = vi.fn();
    const childScript = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'), 250)`;
    const parentScript = [
      "const {spawn}=require('child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}])`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const executor = new DefaultHookExecutor({ workDir, onAsyncRewake: rewake });
    try {
      await expect(
        executor.execute(
          resolved({
            type: "command",
            command: process.execPath,
            args: ["-e", parentScript],
            asyncRewake: true,
          }),
          input,
          {},
        ),
      ).resolves.toEqual({ decision: "allow" });

      await executor.dispose();
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(rewake).not.toHaveBeenCalled();
      await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        executor.execute(resolved({ type: "command", command: "true" }), input, {}),
      ).rejects.toThrow("Hook runtime disposed");
    } finally {
      await executor.dispose();
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("DefaultHookExecutor HTTP", () => {
  it("POST JSON、允许列表 env header 与受限 redirect", async () => {
    const requests: Array<{ method?: string; authorization?: string; body: string }> = [];
    let base = "";
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        requests.push({
          method: request.method,
          authorization: request.headers.authorization,
          body,
        });
        if (request.url === "/start") {
          response.writeHead(307, { location: `${base}/finish` });
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ decision: "ask", reason: "review" }));
      });
    });
    base = await listen(server);
    const executor = new DefaultHookExecutor({
      workDir: process.cwd(),
      env: { HOOK_TOKEN: "secret" },
    });
    const result = await executor.execute(
      resolved({
        type: "http",
        url: `${base}/start`,
        headers: { Authorization: "Bearer ${HOOK_TOKEN}" },
        allowedEnv: ["HOOK_TOKEN"],
      }),
      input,
      {},
    );

    expect(result).toMatchObject({ decision: "ask", reason: "review" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ method: "POST", authorization: "Bearer secret" });
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ hook_event_name: "PreToolUse" });
  });

  it("跨 origin redirect 不泄露敏感 header，超限响应 fail-open", async () => {
    let receivedAuthorization: string | undefined;
    let receivedApiKey: string | undefined;
    const target = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      receivedApiKey = request.headers["x-api-key"] as string | undefined;
      response.end("x".repeat(64));
    });
    const targetBase = await listen(target);
    const source = createServer((_request, response) => {
      response.writeHead(307, { location: targetBase });
      response.end();
    });
    const sourceBase = await listen(source);
    const executor = new DefaultHookExecutor({
      workDir: process.cwd(),
      env: { HOOK_TOKEN: "redirect-secret" },
    });
    const result = await executor.execute(
      resolved({
        type: "http",
        url: sourceBase,
        headers: {
          Authorization: "Bearer static-secret",
          "X-Api-Key": "${HOOK_TOKEN}",
        },
        allowedEnv: ["HOOK_TOKEN"],
        maxResponseBytes: 8,
      }),
      input,
      {},
    );

    expect(receivedAuthorization).toBeUndefined();
    expect(receivedApiKey).toBeUndefined();
    expect(result).toMatchObject({ decision: "allow" });
    expect(result.diagnostics?.[0]?.handlerId).toBe("handler-1");
  });

  it("响应超过上限时主动取消底层流", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(32)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const executor = new DefaultHookExecutor({
      workDir: process.cwd(),
      fetch: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    });

    await expect(
      executor.execute(
        resolved({ type: "http", url: "https://hooks.example.test", maxResponseBytes: 8 }),
        input,
        {},
      ),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(cancelled).toBe(true);
  });
});

describe("DefaultHookExecutor MCP/prompt/agent", () => {
  it("MCP 只调用注入的已连接窄接口，isError fail-open", async () => {
    const invokeConnectedTool = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"deny","reason":"mcp"}' }],
        isError: false,
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "server error" }],
        isError: true,
      });
    const executor = new DefaultHookExecutor({
      workDir: process.cwd(),
      mcpInvoker: { invokeConnectedTool },
    });
    const handler = resolved({
      type: "mcp_tool",
      server: "policy",
      tool: "check",
      input: { command: "rm" },
    });

    await expect(executor.execute(handler, input, {})).resolves.toMatchObject({
      decision: "deny",
      reason: "mcp",
    });
    const failed = await executor.execute(handler, input, {});
    expect(failed.decision).toBe("allow");
    expect(failed.diagnostics?.[0]?.message).toContain("isError");
    expect(invokeConnectedTool).toHaveBeenCalledWith(
      "policy",
      "check",
      { command: "rm" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("prompt 使用 purpose=hook 且严格解析 {ok,reason}", async () => {
    const generate = vi.fn().mockResolvedValue({
      role: "assistant",
      content: '{"ok":false,"reason":"unsafe"}',
    });
    const provider: LLMProvider = { generate };
    const executor = new DefaultHookExecutor({ workDir: process.cwd(), provider });
    await expect(
      executor.execute(resolved({ type: "prompt", prompt: "是否安全" }), input, {}),
    ).resolves.toMatchObject({ decision: "deny", reason: "unsafe" });
    expect(generate).toHaveBeenCalledWith(
      expect.any(Array),
      [],
      expect.objectContaining({ purpose: "hook", signal: expect.any(AbortSignal) }),
    );

    generate.mockResolvedValueOnce({ role: "assistant", content: "```json\n{}\n```" });
    const invalid = await executor.execute(
      resolved({ type: "prompt", prompt: "是否安全" }),
      input,
      {},
    );
    expect(invalid).toMatchObject({ decision: "allow" });
    expect(invalid.diagnostics?.[0]?.handlerId).toBe("handler-1");
  });

  it("agent 限制 50 轮并强制只读、禁止递归 Hook", async () => {
    let request: HookAgentVerifierRequest | undefined;
    const executor = new DefaultHookExecutor({
      workDir: process.cwd(),
      agentVerifier: {
        async verify(value) {
          request = value;
          return { ok: true, reason: "checked" };
        },
      },
    });
    await expect(
      executor.execute(resolved({ type: "agent", prompt: "深度检查", maxTurns: 500 }), input, {}),
    ).resolves.toMatchObject({ decision: "allow", reason: "checked" });
    expect(request).toMatchObject({
      maxTurns: 50,
      readonlyToolsOnly: true,
      suppressHooks: true,
    });
  });

  it("任意类型都不吞父级 AbortSignal", async () => {
    const reason = new Error("session aborted");
    const controller = new AbortController();
    const executor = new DefaultHookExecutor({
      workDir: process.cwd(),
      provider: {
        async generate(_messages, _tools, options) {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          });
          throw new Error("unreachable");
        },
      },
    });
    const execution = executor.execute(resolved({ type: "prompt", prompt: "check" }), input, {
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(execution).rejects.toBe(reason);
  });
});
