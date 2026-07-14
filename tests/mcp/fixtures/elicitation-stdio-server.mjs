import readline from "node:readline";

let initialized;
let pendingToolCall;

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    initialized = message.params;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "elicitation-fixture", version: "1" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "ask", description: "ask", inputSchema: { type: "object" } }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    pendingToolCall = message;
    // 故意复用 outbound tools/call id，验证双向 ID 命名空间不会串线。
    send({
      jsonrpc: "2.0",
      id: message.id,
      method: "elicitation/create",
      params: {
        message: "Choose environment",
        requestedSchema: {
          type: "object",
          properties: { environment: { type: "string", enum: ["dev", "prod"] } },
          required: ["environment"],
        },
      },
    });
    return;
  }
  if (pendingToolCall && message.id === pendingToolCall.id && !message.method) {
    send({
      jsonrpc: "2.0",
      id: pendingToolCall.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ initialized, elicitationResult: message.result }),
          },
        ],
        isError: false,
      },
    });
    pendingToolCall = undefined;
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
