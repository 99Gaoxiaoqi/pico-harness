// 中止主链 integration fixture：故意忽略 MCP cancellation 和 SIGTERM，
// 用延迟写文件验证 client 必须物理终止整个进程组。

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "started-file": { type: "string" },
    "cancelled-file": { type: "string" },
    "queued-file": { type: "string" },
    "late-file": { type: "string" },
    "server-pid-file": { type: "string" },
    "worker-pid-file": { type: "string" },
    "late-delay": { type: "string", default: "800" },
    worker: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const lateDelay = Number(values["late-delay"]);

if (values.worker) {
  process.on("SIGTERM", () => {});
  setTimeout(() => writeMarker(values["late-file"], "late-worker-side-effect"), lateDelay);
  setInterval(() => {}, 1_000);
} else {
  process.on("SIGTERM", () => {});
  writeMarker(values["server-pid-file"], String(process.pid));

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleMessage(line);
    }
  });
}

function handleMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === "notifications/cancelled") {
    writeMarker(values["cancelled-file"], JSON.stringify(message.params ?? {}));
    return;
  }
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "abort-fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        { name: "hang", description: "hang", inputSchema: { type: "object" } },
        { name: "queued", description: "queued", inputSchema: { type: "object" } },
        {
          name: "exit_with_worker",
          description: "exit after spawning worker",
          inputSchema: { type: "object" },
        },
      ],
    });
    return;
  }
  if (message.method !== "tools/call") return;

  const name = message.params?.name;
  if (name === "exit_with_worker") {
    const worker = spawnWorker();
    writeMarker(values["worker-pid-file"], String(worker.pid));
    writeMarker(values["started-file"], "worker-started-before-root-exit");
    setImmediate(() => process.exit(1));
    return;
  }
  if (name === "queued") {
    writeMarker(values["queued-file"], "queued-started");
    respond(message.id, { content: [{ type: "text", text: "queued" }], isError: false });
    return;
  }
  if (name !== "hang") return;

  const worker = spawnWorker();
  writeMarker(values["worker-pid-file"], String(worker.pid));
  writeMarker(values["started-file"], "hang-started");

  setTimeout(() => {
    writeMarker(values["late-file"], "late-server-side-effect");
    respond(message.id, {
      content: [{ type: "text", text: "late-output" }],
      isError: false,
    });
  }, lateDelay);
}

function spawnWorker() {
  const workerArgs = [
    import.meta.filename,
    "--worker",
    "--late-delay",
    String(lateDelay),
    ...(values["late-file"] ? ["--late-file", values["late-file"]] : []),
  ];
  return spawn(process.execPath, workerArgs, { stdio: "ignore" });
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeMarker(path, content) {
  if (path) writeFileSync(path, content);
}
