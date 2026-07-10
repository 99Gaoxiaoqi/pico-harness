import { createServer } from "node:http";

export async function startFakeOpenAiServer(options = {}) {
  const content = options.content ?? "PICO_LOCAL_OPENAI_OK";
  let requestCount = 0;

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end("not found");
      return;
    }

    requestCount += 1;
    const body = await readJsonBody(request);
    if (body.stream === true) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fake OpenAI server did not bind a TCP port");
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    get requestCount() {
      return requestCount;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : {};
}
