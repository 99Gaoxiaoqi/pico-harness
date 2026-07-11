let buffer = Buffer.alloc(0);
let expectedLength;
let initializeId;
let documentUri;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  while (true) {
    if (expectedLength === undefined) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const headers = buffer.subarray(0, separator).toString("ascii");
      buffer = buffer.subarray(separator + 4);
      const match = /Content-Length:\s*(\d+)/i.exec(headers);
      if (!match) process.exit(2);
      expectedLength = Number(match[1]);
    }
    if (buffer.length < expectedLength) return;
    const message = JSON.parse(buffer.subarray(0, expectedLength).toString("utf8"));
    buffer = buffer.subarray(expectedLength);
    expectedLength = undefined;
    handle(message);
  }
}

function handle(message) {
  if (message.method === "initialize") {
    initializeId = message.id;
    send({
      jsonrpc: "2.0",
      id: "server-configuration",
      method: "workspace/configuration",
      params: { items: [{ section: "typescript" }] },
    });
    return;
  }
  if (message.id === "server-configuration") {
    if (!Array.isArray(message.result) || message.result.length !== 1) process.exit(3);
    send({
      jsonrpc: "2.0",
      id: initializeId,
      result: { capabilities: { definitionProvider: true } },
    });
    return;
  }
  if (message.method === "textDocument/didOpen") {
    documentUri = message.params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: documentUri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
            severity: 2,
            source: "mock-lsp",
            message: "integration diagnostic",
          },
        ],
      },
    });
    return;
  }
  if (message.method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        uri: documentUri,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
      },
    });
    return;
  }
  if (message.method === "textDocument/diagnostic") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
