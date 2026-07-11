// 测试用 Mock MCP stdio server。
//
// 模拟一个最小但合规的 MCP server:
//   - 读取 stdin 的 JSON-RPC 请求(逐行)
//   - 响应 initialize / tools/list / tools/call
//   - 忽略 notification(无 id 的消息)
//
// 用法:node mock-stdio-server.mjs [--crash N] [--tools T]
//   --crash N:启动后 N 毫秒崩溃(测失败隔离)
//   --tools T:暴露 T 个工具(默认 2)
//   --name X:server 名(用于 initialize 响应)

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

const { values } = parseArgs({
  options: {
    crash: { type: "string", default: "0" },
    tools: { type: "string", default: "2" },
    name: { type: "string", default: "mock-server" },
    "fail-startup": { type: "boolean", default: false },
    "ignore-sigterm": { type: "boolean", default: false },
    "pid-file": { type: "string" },
    "env-snapshot": { type: "string" },
    stderr: { type: "string" },
  },
  allowPositionals: false,
});

const crashAfterMs = Number(values.crash);
const toolCount = Number(values.tools);
const serverName = values.name;

if (values["pid-file"]) {
  writeFileSync(values["pid-file"], String(process.pid));
}

if (values["env-snapshot"]) {
  writeFileSync(values["env-snapshot"], JSON.stringify(process.env));
}

if (values["ignore-sigterm"]) {
  process.on("SIGTERM", () => {
    process.stderr.write("[mock] ignoring SIGTERM\n");
  });
}

// 启动即失败:写 stderr 后立即非零退出,不读 stdin(模拟 server 启动崩溃)
if (values["fail-startup"]) {
  process.stderr.write(values.stderr ?? `[mock] ${serverName} 启动失败(模拟)\n`);
  process.exit(1);
}

if (crashAfterMs > 0) {
  setTimeout(() => {
    process.stderr.write(`[mock] 模拟崩溃 after ${crashAfterMs}ms\n`);
    process.exit(1);
  }, crashAfterMs);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // notification(无 id)忽略
  if (msg.id === undefined) return;

  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "1.0.0" },
      });
      break;
    case "tools/list":
      respond(msg.id, { tools: makeTools(toolCount) });
      break;
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      if (name === "echo") {
        respond(msg.id, {
          content: [{ type: "text", text: `echo: ${JSON.stringify(args)}` }],
          isError: false,
        });
      } else if (name === "fail_tool") {
        respond(msg.id, {
          content: [{ type: "text", text: "故意失败" }],
          isError: true,
        });
      } else {
        respond(msg.id, {
          content: [{ type: "text", text: `unknown tool: ${name}` }],
          isError: true,
        });
      }
      break;
    }
    default:
      respondError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function makeTools(count) {
  const tools = [
    {
      name: "echo",
      description: "原样回显输入参数",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ];
  for (let i = 1; i < count; i++) {
    tools.push({
      name: `tool_${i}`,
      description: `测试工具 ${i}`,
      inputSchema: { type: "object", properties: {} },
    });
  }
  return tools;
}

// 保持进程存活,等待 stdin
process.stdin.on("end", () => process.exit(0));
